import * as fs from 'fs'
import * as path from 'path'
import * as http from 'http'
import * as https from 'https'
import { fileURLToPath } from 'url'
import { ConfigService } from './config'
import { wcdbService } from './wcdbService'

// ChatLab 格式类型定义
interface ChatLabHeader {
  version: string
  exportedAt: number
  generator: string
  description?: string
}

interface ChatLabMeta {
  name: string
  platform: string
  type: 'group' | 'private'
  groupId?: string
  groupAvatar?: string
}

interface ChatLabMember {
  platformId: string
  accountName: string
  groupNickname?: string
  avatar?: string
}

interface ChatLabMessage {
  sender: string
  accountName: string
  groupNickname?: string
  timestamp: number
  type: number
  content: string | null
}

interface ChatLabExport {
  chatlab: ChatLabHeader
  meta: ChatLabMeta
  members: ChatLabMember[]
  messages: ChatLabMessage[]
}

// 消息类型映射：微信 localType -> ChatLab type
const MESSAGE_TYPE_MAP: Record<number, number> = {
  1: 0,      // 文本 -> TEXT
  3: 1,      // 图片 -> IMAGE
  34: 2,     // 语音 -> VOICE
  43: 3,     // 视频 -> VIDEO
  49: 7,     // 链接/文件 -> LINK (需要进一步判断)
  47: 5,     // 表情包 -> EMOJI
  48: 8,     // 位置 -> LOCATION
  42: 27,    // 名片 -> CONTACT
  50: 23,    // 通话 -> CALL
  10000: 80, // 系统消息 -> SYSTEM
}

export interface ExportOptions {
  format: 'chatlab' | 'chatlab-jsonl' | 'json' | 'html' | 'txt' | 'excel' | 'sql'
  dateRange?: { start: number; end: number } | null
  exportMedia?: boolean
  exportAvatars?: boolean
}

export interface ExportProgress {
  current: number
  total: number
  currentSession: string
  phase: 'preparing' | 'exporting' | 'writing' | 'complete'
}

class ExportService {
  private configService: ConfigService
  private contactCache: Map<string, { displayName: string; avatarUrl?: string }> = new Map()

  constructor() {
    this.configService = new ConfigService()
  }

  private cleanAccountDirName(dirName: string): string {
    const trimmed = dirName.trim()
    if (!trimmed) return trimmed
    if (trimmed.toLowerCase().startsWith('wxid_')) {
      const match = trimmed.match(/^(wxid_[^_]+)/i)
      if (match) return match[1]
      return trimmed
    }
    const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
    if (suffixMatch) return suffixMatch[1]
    return trimmed
  }

  private async ensureConnected(): Promise<{ success: boolean; cleanedWxid?: string; error?: string }> {
    const wxid = this.configService.get('myWxid')
    const dbPath = this.configService.get('dbPath')
    const decryptKey = this.configService.get('decryptKey')
    if (!wxid) return { success: false, error: '请先在设置页面配置微信ID' }
    if (!dbPath) return { success: false, error: '请先在设置页面配置数据库路径' }
    if (!decryptKey) return { success: false, error: '请先在设置页面配置解密密钥' }

    const cleanedWxid = this.cleanAccountDirName(wxid)
    const ok = await wcdbService.open(dbPath, decryptKey, cleanedWxid)
    if (!ok) return { success: false, error: 'WCDB 打开失败' }
    return { success: true, cleanedWxid }
  }

  private async getContactInfo(username: string): Promise<{ displayName: string; avatarUrl?: string }> {
    if (this.contactCache.has(username)) {
      return this.contactCache.get(username)!
    }

    const [displayNames, avatarUrls] = await Promise.all([
      wcdbService.getDisplayNames([username]),
      wcdbService.getAvatarUrls([username])
    ])

    const displayName = displayNames.success && displayNames.map
      ? (displayNames.map[username] || username)
      : username
    const avatarUrl = avatarUrls.success && avatarUrls.map
      ? avatarUrls.map[username]
      : undefined

    const info = { displayName, avatarUrl }
    this.contactCache.set(username, info)
    return info
  }

  /**
   * 转换微信消息类型到 ChatLab 类型
   */
  private convertMessageType(localType: number, content: string): number {
    if (localType === 49) {
      const typeMatch = /<type>(\d+)<\/type>/i.exec(content)
      if (typeMatch) {
        const subType = parseInt(typeMatch[1])
        switch (subType) {
          case 6: return 4   // 文件 -> FILE
          case 33:
          case 36: return 24 // 小程序 -> SHARE
          case 57: return 25 // 引用回复 -> REPLY
          default: return 7  // 链接 -> LINK
        }
      }
    }
    return MESSAGE_TYPE_MAP[localType] ?? 99
  }

  /**
   * 解码消息内容
   */
  private decodeMessageContent(messageContent: any, compressContent: any): string {
    let content = this.decodeMaybeCompressed(compressContent)
    if (!content || content.length === 0) {
      content = this.decodeMaybeCompressed(messageContent)
    }
    return content
  }

  private decodeMaybeCompressed(raw: any): string {
    if (!raw) return ''
    if (typeof raw === 'string') {
      if (raw.length === 0) return ''
      if (this.looksLikeHex(raw)) {
        const bytes = Buffer.from(raw, 'hex')
        if (bytes.length > 0) return this.decodeBinaryContent(bytes)
      }
      if (this.looksLikeBase64(raw)) {
        try {
          const bytes = Buffer.from(raw, 'base64')
          return this.decodeBinaryContent(bytes)
        } catch {
          return raw
        }
      }
      return raw
    }
    return ''
  }

  private decodeBinaryContent(data: Buffer): string {
    if (data.length === 0) return ''
    try {
      if (data.length >= 4) {
        const magic = data.readUInt32LE(0)
        if (magic === 0xFD2FB528) {
          const fzstd = require('fzstd')
          const decompressed = fzstd.decompress(data)
          return Buffer.from(decompressed).toString('utf-8')
        }
      }
      const decoded = data.toString('utf-8')
      const replacementCount = (decoded.match(/\uFFFD/g) || []).length
      if (replacementCount < decoded.length * 0.2) {
        return decoded.replace(/\uFFFD/g, '')
      }
      return data.toString('latin1')
    } catch {
      return ''
    }
  }

  private looksLikeHex(s: string): boolean {
    if (s.length % 2 !== 0) return false
    return /^[0-9a-fA-F]+$/.test(s)
  }

  private looksLikeBase64(s: string): boolean {
    if (s.length % 4 !== 0) return false
    return /^[A-Za-z0-9+/=]+$/.test(s)
  }

  /**
   * 解析消息内容为可读文本
   */
  private parseMessageContent(content: string, localType: number): string | null {
    if (!content) return null

    switch (localType) {
      case 1:
        return this.stripSenderPrefix(content)
      case 3: return '[图片]'
      case 34: return '[语音消息]'
      case 42: return '[名片]'
      case 43: return '[视频]'
      case 47: return '[动画表情]'
      case 48: return '[位置]'
      case 49: {
        const title = this.extractXmlValue(content, 'title')
        return title || '[链接]'
      }
      case 50: return this.parseVoipMessage(content)
      case 10000: return this.cleanSystemMessage(content)
      default:
        if (content.includes('<type>57</type>')) {
          const title = this.extractXmlValue(content, 'title')
          return title || '[引用消息]'
        }
        return this.stripSenderPrefix(content) || null
    }
  }

  private stripSenderPrefix(content: string): string {
    return content.replace(/^[\s]*([a-zA-Z0-9_-]+):(?!\/\/)/, '')
  }

  private extractXmlValue(xml: string, tagName: string): string {
    const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\/${tagName}>`, 'i')
    const match = regex.exec(xml)
    if (match) {
      return match[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim()
    }
    return ''
  }

  private cleanSystemMessage(content: string): string {
    return content
      .replace(/<img[^>]*>/gi, '')
      .replace(/<\/?[a-zA-Z0-9_]+[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim() || '[系统消息]'
  }

  /**
   * 解析通话消息
   * 格式: <voipmsg type="VoIPBubbleMsg"><VoIPBubbleMsg><msg><![CDATA[...]]></msg><room_type>0/1</room_type>...</VoIPBubbleMsg></voipmsg>
   * room_type: 0 = 语音通话, 1 = 视频通话
   */
  private parseVoipMessage(content: string): string {
    try {
      if (!content) return '[通话]'

      // 提取 msg 内容（中文通话状态）
      const msgMatch = /<msg><!\[CDATA\[(.*?)\]\]><\/msg>/i.exec(content)
      const msg = msgMatch?.[1]?.trim() || ''

      // 提取 room_type（0=视频，1=语音）
      const roomTypeMatch = /<room_type>(\d+)<\/room_type>/i.exec(content)
      const roomType = roomTypeMatch ? parseInt(roomTypeMatch[1], 10) : -1

      // 构建通话类型标签
      let callType: string
      if (roomType === 0) {
        callType = '视频通话'
      } else if (roomType === 1) {
        callType = '语音通话'
      } else {
        callType = '通话'
      }

      // 解析通话状态
      if (msg.includes('通话时长')) {
        const durationMatch = /通话时长\s*(\d{1,2}:\d{2}(?::\d{2})?)/i.exec(msg)
        const duration = durationMatch?.[1] || ''
        if (duration) {
          return `[${callType}] ${duration}`
        }
        return `[${callType}] 已接听`
      } else if (msg.includes('对方无应答')) {
        return `[${callType}] 对方无应答`
      } else if (msg.includes('已取消')) {
        return `[${callType}] 已取消`
      } else if (msg.includes('已在其它设备接听') || msg.includes('已在其他设备接听')) {
        return `[${callType}] 已在其他设备接听`
      } else if (msg.includes('对方已拒绝') || msg.includes('已拒绝')) {
        return `[${callType}] 对方已拒绝`
      } else if (msg.includes('忙线未接听') || msg.includes('忙线')) {
        return `[${callType}] 忙线未接听`
      } else if (msg.includes('未接听')) {
        return `[${callType}] 未接听`
      } else if (msg) {
        return `[${callType}] ${msg}`
      }

      return `[${callType}]`
    } catch (e) {
      console.error('[ExportService] Failed to parse VOIP message:', e)
      return '[通话]'
    }
  }

  /**
   * 获取消息类型名称
   */
  private getMessageTypeName(localType: number): string {
    const typeNames: Record<number, string> = {
      1: '文本消息',
      3: '图片消息',
      34: '语音消息',
      42: '名片消息',
      43: '视频消息',
      47: '动画表情',
      48: '位置消息',
      49: '链接消息',
      50: '通话消息',
      10000: '系统消息'
    }
    return typeNames[localType] || '其他消息'
  }

  /**
   * 格式化时间戳为可读字符串
   */
  private formatTimestamp(timestamp: number): string {
    const date = new Date(timestamp * 1000)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    const seconds = String(date.getSeconds()).padStart(2, '0')
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
  }

  private async collectMessages(
    sessionId: string,
    cleanedMyWxid: string,
    dateRange?: { start: number; end: number } | null
  ): Promise<{ rows: any[]; memberSet: Map<string, { member: ChatLabMember; avatarUrl?: string }>; firstTime: number | null; lastTime: number | null }> {
    const rows: any[] = []
    const memberSet = new Map<string, { member: ChatLabMember; avatarUrl?: string }>()
    let firstTime: number | null = null
    let lastTime: number | null = null

    const cursor = await wcdbService.openMessageCursor(
      sessionId,
      500,
      true,
      dateRange?.start || 0,
      dateRange?.end || 0
    )
    if (!cursor.success || !cursor.cursor) {
      return { rows, memberSet, firstTime, lastTime }
    }

    try {
      let hasMore = true
      while (hasMore) {
        const batch = await wcdbService.fetchMessageBatch(cursor.cursor)
        if (!batch.success || !batch.rows) break
        for (const row of batch.rows) {
          const createTime = parseInt(row.create_time || '0', 10)
          if (dateRange) {
            if (createTime < dateRange.start || createTime > dateRange.end) continue
          }

          const content = this.decodeMessageContent(row.message_content, row.compress_content)
          const localType = parseInt(row.local_type || row.type || '1', 10)
          const senderUsername = row.sender_username || ''
          const isSendRaw = row.computed_is_send ?? row.is_send ?? '0'
          const isSend = parseInt(isSendRaw, 10) === 1

          const actualSender = isSend ? cleanedMyWxid : (senderUsername || sessionId)
          const memberInfo = await this.getContactInfo(actualSender)
          if (!memberSet.has(actualSender)) {
            memberSet.set(actualSender, {
              member: {
                platformId: actualSender,
                accountName: memberInfo.displayName
              },
              avatarUrl: memberInfo.avatarUrl
            })
          }

          rows.push({
            createTime,
            localType,
            content,
            senderUsername: actualSender,
            isSend
          })

          if (firstTime === null || createTime < firstTime) firstTime = createTime
          if (lastTime === null || createTime > lastTime) lastTime = createTime
        }
        hasMore = batch.hasMore === true
      }
    } finally {
      await wcdbService.closeMessageCursor(cursor.cursor)
    }

    return { rows, memberSet, firstTime, lastTime }
  }

  // 补齐群成员，避免只导出发言者导致头像缺失
  private async mergeGroupMembers(
    chatroomId: string,
    memberSet: Map<string, { member: ChatLabMember; avatarUrl?: string }>,
    includeAvatars: boolean
  ): Promise<void> {
    const result = await wcdbService.getGroupMembers(chatroomId)
    if (!result.success || !result.members || result.members.length === 0) return

    const rawMembers = result.members as Array<{
      username?: string
      avatarUrl?: string
      nickname?: string
      displayName?: string
      remark?: string
      originalName?: string
    }>
    const usernames = rawMembers
      .map((member) => member.username)
      .filter((username): username is string => Boolean(username))
    if (usernames.length === 0) return

    const lookupUsernames = new Set<string>()
    for (const username of usernames) {
      lookupUsernames.add(username)
      const cleaned = this.cleanAccountDirName(username)
      if (cleaned && cleaned !== username) {
        lookupUsernames.add(cleaned)
      }
    }

    const [displayNames, avatarUrls] = await Promise.all([
      wcdbService.getDisplayNames(Array.from(lookupUsernames)),
      includeAvatars ? wcdbService.getAvatarUrls(Array.from(lookupUsernames)) : Promise.resolve({ success: true, map: {} as Record<string, string> })
    ])

    for (const member of rawMembers) {
      const username = member.username
      if (!username) continue

      const cleaned = this.cleanAccountDirName(username)
      const displayName = displayNames.success && displayNames.map
        ? (displayNames.map[username] || (cleaned ? displayNames.map[cleaned] : undefined) || username)
        : username
      const groupNickname = member.nickname || member.displayName || member.remark || member.originalName
      const avatarUrl = includeAvatars && avatarUrls.success && avatarUrls.map
        ? (avatarUrls.map[username] || (cleaned ? avatarUrls.map[cleaned] : undefined) || member.avatarUrl)
        : member.avatarUrl

      const existing = memberSet.get(username)
      if (existing) {
        if (displayName && existing.member.accountName === existing.member.platformId && displayName !== existing.member.platformId) {
          existing.member.accountName = displayName
        }
        if (groupNickname && !existing.member.groupNickname) {
          existing.member.groupNickname = groupNickname
        }
        if (!existing.avatarUrl && avatarUrl) {
          existing.avatarUrl = avatarUrl
        }
        memberSet.set(username, existing)
        continue
      }

      const chatlabMember: ChatLabMember = {
        platformId: username,
        accountName: displayName
      }
      if (groupNickname) {
        chatlabMember.groupNickname = groupNickname
      }
      memberSet.set(username, { member: chatlabMember, avatarUrl })
    }
  }

  private resolveAvatarFile(avatarUrl?: string): { data?: Buffer; sourcePath?: string; sourceUrl?: string; ext: string; mime?: string } | null {
    if (!avatarUrl) return null
    if (avatarUrl.startsWith('data:')) {
      const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/i.exec(avatarUrl)
      if (!match) return null
      const mime = match[1].toLowerCase()
      const data = Buffer.from(match[2], 'base64')
      const ext = mime.includes('png') ? '.png'
        : mime.includes('gif') ? '.gif'
          : mime.includes('webp') ? '.webp'
            : '.jpg'
      return { data, ext, mime }
    }
    if (avatarUrl.startsWith('file://')) {
      try {
        const sourcePath = fileURLToPath(avatarUrl)
        const ext = path.extname(sourcePath) || '.jpg'
        return { sourcePath, ext }
      } catch {
        return null
      }
    }
    if (avatarUrl.startsWith('http://') || avatarUrl.startsWith('https://')) {
      const url = new URL(avatarUrl)
      const ext = path.extname(url.pathname) || '.jpg'
      return { sourceUrl: avatarUrl, ext }
    }
    const sourcePath = avatarUrl
    const ext = path.extname(sourcePath) || '.jpg'
    return { sourcePath, ext }
  }

  private async downloadToBuffer(url: string, remainingRedirects = 2): Promise<{ data: Buffer; mime?: string } | null> {
    const client = url.startsWith('https:') ? https : http
    return new Promise((resolve) => {
      const request = client.get(url, (res) => {
        const status = res.statusCode || 0
        if (status >= 300 && status < 400 && res.headers.location && remainingRedirects > 0) {
          res.resume()
          const redirectedUrl = new URL(res.headers.location, url).href
          this.downloadToBuffer(redirectedUrl, remainingRedirects - 1)
            .then(resolve)
          return
        }
        if (status < 200 || status >= 300) {
          res.resume()
          resolve(null)
          return
        }
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        res.on('end', () => {
          const data = Buffer.concat(chunks)
          const mime = typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : undefined
          resolve({ data, mime })
        })
      })
      request.on('error', () => resolve(null))
      request.setTimeout(15000, () => {
        request.destroy()
        resolve(null)
      })
    })
  }

  private async exportAvatars(
    members: Array<{ username: string; avatarUrl?: string }>
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    if (members.length === 0) return result

    for (const member of members) {
      const fileInfo = this.resolveAvatarFile(member.avatarUrl)
      if (!fileInfo) continue
      try {
        let data: Buffer | null = null
        let mime = fileInfo.mime
        if (fileInfo.data) {
          data = fileInfo.data
        } else if (fileInfo.sourcePath && fs.existsSync(fileInfo.sourcePath)) {
          data = await fs.promises.readFile(fileInfo.sourcePath)
        } else if (fileInfo.sourceUrl) {
          const downloaded = await this.downloadToBuffer(fileInfo.sourceUrl)
          if (downloaded) {
            data = downloaded.data
            mime = downloaded.mime || mime
          }
        }
        if (!data) continue

        // 优先使用内容检测出的 MIME 类型
        const detectedMime = this.detectMimeType(data)
        const finalMime = detectedMime || mime || this.inferImageMime(fileInfo.ext)

        const base64 = data.toString('base64')
        result.set(member.username, `data:${finalMime};base64,${base64}`)
      } catch {
        continue
      }
    }

    return result
  }

  private detectMimeType(buffer: Buffer): string | null {
    if (buffer.length < 4) return null

    // PNG: 89 50 4E 47
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
      return 'image/png'
    }

    // JPEG: FF D8 FF
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
      return 'image/jpeg'
    }

    // GIF: 47 49 46 38
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
      return 'image/gif'
    }

    // WEBP: RIFF ... WEBP
    if (buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
      return 'image/webp'
    }

    // BMP: 42 4D
    if (buffer[0] === 0x42 && buffer[1] === 0x4D) {
      return 'image/bmp'
    }

    return null
  }

  private inferImageMime(ext: string): string {
    switch (ext.toLowerCase()) {
      case '.png':
        return 'image/png'
      case '.gif':
        return 'image/gif'
      case '.webp':
        return 'image/webp'
      case '.bmp':
        return 'image/bmp'
      default:
        return 'image/jpeg'
    }
  }

  /**
   * 导出单个会话为 ChatLab 格式
   */
  async exportSessionToChatLab(
    sessionId: string,
    outputPath: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success || !conn.cleanedWxid) return { success: false, error: conn.error }

      const cleanedMyWxid = conn.cleanedWxid
      const isGroup = sessionId.includes('@chatroom')

      const sessionInfo = await this.getContactInfo(sessionId)

      onProgress?.({
        current: 0,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'preparing'
      })

      const collected = await this.collectMessages(sessionId, cleanedMyWxid, options.dateRange)
      const allMessages = collected.rows
      if (isGroup) {
        await this.mergeGroupMembers(sessionId, collected.memberSet, options.exportAvatars === true)
      }

      allMessages.sort((a, b) => a.createTime - b.createTime)

      onProgress?.({
        current: 50,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'exporting'
      })

      const chatLabMessages: ChatLabMessage[] = allMessages.map((msg) => {
        const memberInfo = collected.memberSet.get(msg.senderUsername)?.member || {
          platformId: msg.senderUsername,
          accountName: msg.senderUsername,
          groupNickname: undefined
        }
        return {
          sender: msg.senderUsername,
          accountName: memberInfo.accountName,
          groupNickname: memberInfo.groupNickname,
          timestamp: msg.createTime,
          type: this.convertMessageType(msg.localType, msg.content),
          content: this.parseMessageContent(msg.content, msg.localType)
        }
      })

      const avatarMap = options.exportAvatars
        ? await this.exportAvatars(
          [
            ...Array.from(collected.memberSet.entries()).map(([username, info]) => ({
              username,
              avatarUrl: info.avatarUrl
            })),
            { username: sessionId, avatarUrl: sessionInfo.avatarUrl }
          ]
        )
        : new Map<string, string>()

      const sessionAvatar = avatarMap.get(sessionId)
      const members = Array.from(collected.memberSet.values()).map((info) => {
        const avatar = avatarMap.get(info.member.platformId)
        return avatar ? { ...info.member, avatar } : info.member
      })

      const chatLabExport: ChatLabExport = {
        chatlab: {
          version: '0.0.1',
          exportedAt: Math.floor(Date.now() / 1000),
          generator: 'WeFlow'
        },
        meta: {
          name: sessionInfo.displayName,
          platform: 'wechat',
          type: isGroup ? 'group' : 'private',
          ...(isGroup && { groupId: sessionId }),
          ...(sessionAvatar && { groupAvatar: sessionAvatar })
        },
        members,
        messages: chatLabMessages
      }

      onProgress?.({
        current: 80,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'writing'
      })

      if (options.format === 'chatlab-jsonl') {
        const lines: string[] = []
        lines.push(JSON.stringify({
          _type: 'header',
          chatlab: chatLabExport.chatlab,
          meta: chatLabExport.meta
        }))
        for (const member of chatLabExport.members) {
          lines.push(JSON.stringify({ _type: 'member', ...member }))
        }
        for (const message of chatLabExport.messages) {
          lines.push(JSON.stringify({ _type: 'message', ...message }))
        }
        fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8')
      } else {
        fs.writeFileSync(outputPath, JSON.stringify(chatLabExport, null, 2), 'utf-8')
      }

      onProgress?.({
        current: 100,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'complete'
      })

      return { success: true }
    } catch (e) {
      console.error('ExportService: 导出失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 导出单个会话为详细 JSON 格式（原项目格式）
   */
  async exportSessionToDetailedJson(
    sessionId: string,
    outputPath: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success || !conn.cleanedWxid) return { success: false, error: conn.error }

      const cleanedMyWxid = conn.cleanedWxid
      const isGroup = sessionId.includes('@chatroom')

      const sessionInfo = await this.getContactInfo(sessionId)
      const myInfo = await this.getContactInfo(cleanedMyWxid)

      onProgress?.({
        current: 0,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'preparing'
      })

      const collected = await this.collectMessages(sessionId, cleanedMyWxid, options.dateRange)
      const allMessages: any[] = []

      for (const msg of collected.rows) {
        const senderInfo = await this.getContactInfo(msg.senderUsername)
        const sourceMatch = /<msgsource>[\s\S]*?<\/msgsource>/i.exec(msg.content || '')
        const source = sourceMatch ? sourceMatch[0] : ''

        allMessages.push({
          localId: allMessages.length + 1,
          createTime: msg.createTime,
          formattedTime: this.formatTimestamp(msg.createTime),
          type: this.getMessageTypeName(msg.localType),
          localType: msg.localType,
          content: this.parseMessageContent(msg.content, msg.localType),
          isSend: msg.isSend ? 1 : 0,
          senderUsername: msg.senderUsername,
          senderDisplayName: senderInfo.displayName,
          source,
          senderAvatarKey: msg.senderUsername
        })
      }

      allMessages.sort((a, b) => a.createTime - b.createTime)

      onProgress?.({
        current: 70,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'writing'
      })

      const detailedExport = {
        session: {
          wxid: sessionId,
          nickname: sessionInfo.displayName,
          remark: sessionInfo.displayName,
          displayName: sessionInfo.displayName,
          type: isGroup ? '群聊' : '私聊',
          lastTimestamp: collected.lastTime,
          messageCount: allMessages.length,
          avatar: undefined as string | undefined
        },
        messages: allMessages
      }

      if (options.exportAvatars) {
        const avatarMap = await this.exportAvatars(
          [
            ...Array.from(collected.memberSet.entries()).map(([username, info]) => ({
              username,
              avatarUrl: info.avatarUrl
            })),
            { username: sessionId, avatarUrl: sessionInfo.avatarUrl }
          ]
        )
        const avatars: Record<string, string> = {}
        for (const [username, relPath] of avatarMap.entries()) {
          avatars[username] = relPath
        }
        if (Object.keys(avatars).length > 0) {
          detailedExport.session = {
            ...detailedExport.session,
            avatar: avatars[sessionId]
          }
            ; (detailedExport as any).avatars = avatars
        }
      }

      fs.writeFileSync(outputPath, JSON.stringify(detailedExport, null, 2), 'utf-8')

      onProgress?.({
        current: 100,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'complete'
      })

      return { success: true }
    } catch (e) {
      console.error('ExportService: 导出失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 批量导出多个会话
   */
  async exportSessions(
    sessionIds: string[],
    outputDir: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void
  ): Promise<{ success: boolean; successCount: number; failCount: number; error?: string }> {
    let successCount = 0
    let failCount = 0

    try {
      const conn = await this.ensureConnected()
      if (!conn.success) {
        return { success: false, successCount: 0, failCount: sessionIds.length, error: conn.error }
      }

      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true })
      }

      for (let i = 0; i < sessionIds.length; i++) {
        const sessionId = sessionIds[i]
        const sessionInfo = await this.getContactInfo(sessionId)

        onProgress?.({
          current: i + 1,
          total: sessionIds.length,
          currentSession: sessionInfo.displayName,
          phase: 'exporting'
        })

        const safeName = sessionInfo.displayName.replace(/[<>:"/\\|?*]/g, '_')
        let ext = '.json'
        if (options.format === 'chatlab-jsonl') ext = '.jsonl'
        const outputPath = path.join(outputDir, `${safeName}${ext}`)

        let result: { success: boolean; error?: string }
        if (options.format === 'json') {
          result = await this.exportSessionToDetailedJson(sessionId, outputPath, options)
        } else if (options.format === 'chatlab' || options.format === 'chatlab-jsonl') {
          result = await this.exportSessionToChatLab(sessionId, outputPath, options)
        } else {
          result = { success: false, error: `不支持的格式: ${options.format}` }
        }

        if (result.success) {
          successCount++
        } else {
          failCount++
          console.error(`导出 ${sessionId} 失败:`, result.error)
        }
      }

      onProgress?.({
        current: sessionIds.length,
        total: sessionIds.length,
        currentSession: '',
        phase: 'complete'
      })

      return { success: true, successCount, failCount }
    } catch (e) {
      return { success: false, successCount, failCount, error: String(e) }
    }
  }
}

export const exportService = new ExportService()
