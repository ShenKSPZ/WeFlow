import * as fs from 'fs'
import * as path from 'path'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import { chatService } from './chatService'
import { imageDecryptService } from './imageDecryptService'
import { ConfigService } from './config'

export interface StandaloneExportOptions {
  dateRange?: { start: number; end: number } | null
  exportAvatars?: boolean
}

export interface StandaloneExportProgress {
  current: number
  total: number
  sessionId: string
  sessionName: string
  phase: 'preparing' | 'collecting' | 'writing' | 'complete' | 'error'
  message?: string
}

export interface StandaloneExportResult {
  success: boolean
  successCount: number
  failCount: number
  error?: string
}

type MessageRecord = Awaited<ReturnType<typeof chatService.getAllMessages>>['messages'] extends (infer M)[] ? M : any

class StandaloneExportService {
  private configService = new ConfigService()

  async exportSessions(
    sessionIds: string[],
    outputDir: string,
    options: StandaloneExportOptions,
    onProgress?: (progress: StandaloneExportProgress) => void
  ): Promise<StandaloneExportResult> {
    let successCount = 0
    let failCount = 0
    try {
      const baseDir = await this.ensureOutputDir(outputDir)
      const conn = await this.ensureConnected()
      if (!conn.success) {
        return { success: false, successCount: 0, failCount: sessionIds.length, error: conn.error }
      }

      for (let i = 0; i < sessionIds.length; i++) {
        const sessionId = sessionIds[i]
        const sessionName = await this.getDisplayName(sessionId)
        onProgress?.({ current: i, total: sessionIds.length, sessionId, sessionName, phase: 'preparing' })
        try {
          await this.exportSingleSession(sessionId, sessionName, baseDir, options, (phase, msg) => {
            onProgress?.({
              current: i,
              total: sessionIds.length,
              sessionId,
              sessionName,
              phase,
              message: msg
            })
          })
          successCount++
        } catch (e) {
          failCount++
          onProgress?.({
            current: i + 1,
            total: sessionIds.length,
            sessionId,
            sessionName,
            phase: 'error',
            message: String(e)
          })
        }
      }

      onProgress?.({
        current: sessionIds.length,
        total: sessionIds.length,
        sessionId: '',
        sessionName: '',
        phase: 'complete'
      })
      return { success: true, successCount, failCount }
    } catch (e) {
      return { success: false, successCount, failCount, error: String(e) }
    }
  }

  private async exportSingleSession(
    sessionId: string,
    sessionName: string,
    rootDir: string,
    options: StandaloneExportOptions,
    notify?: (phase: StandaloneExportProgress['phase'], msg?: string) => void
  ): Promise<void> {
    notify?.('collecting', '收集消息与媒体')

    const safeSessionName = this.safeName(sessionName || sessionId)
    const sessionRoot = path.join(rootDir, safeSessionName)
    const dataRoot = path.join(sessionRoot, 'mydata')
    const imagesDir = path.join(dataRoot, 'images')
    const emojisDir = path.join(dataRoot, 'emojis')
    const voicesDir = path.join(dataRoot, 'voices')
    const avatarsDir = path.join(dataRoot, 'avatars')
    const dbDir = path.join(dataRoot, 'db')

    this.ensureDir(imagesDir)
    this.ensureDir(emojisDir)
    this.ensureDir(voicesDir)
    this.ensureDir(avatarsDir)
    this.ensureDir(dbDir)

    const dateRange = options.dateRange ?? undefined
    const allMessagesResult = await chatService.getAllMessages(sessionId, dateRange || undefined)
    if (!allMessagesResult.success || !allMessagesResult.messages) {
      throw new Error(allMessagesResult.error || '获取消息失败')
    }
    const messages = allMessagesResult.messages as MessageRecord[]

    const participants = new Map<string, { displayName: string; avatarPath?: string }>()
    const myWxid = this.configService.get('myWxid')
    const addParticipant = async (username: string | null | undefined) => {
      if (!username) return
      if (participants.has(username)) return
      const contact = await chatService.getContactAvatar(username)
      if (contact) {
        participants.set(username, { displayName: contact.displayName || username })
        if (options.exportAvatars !== false) {
          const avatarPath = await this.persistAvatar(contact.avatarUrl, avatarsDir, username)
          if (avatarPath) {
            participants.set(username, { displayName: contact.displayName || username, avatarPath })
          }
        }
      } else {
        participants.set(username, { displayName: username })
      }
    }

    // 收集参与者
    await addParticipant(sessionId)
    if (myWxid) {
      await addParticipant(myWxid)
    }
    for (const msg of messages) {
      await addParticipant(msg.senderUsername)
    }

    // 缓存媒体
    const emojiCache = new Map<string, string>()
    notify?.('collecting', '处理媒体文件')
    for (let idx = 0; idx < messages.length; idx++) {
      const msg = messages[idx] as any
      if (msg.localType === 3) {
        const imagePath = await this.persistImage(msg, sessionId, imagesDir)
        msg.imagePath = imagePath || null
      } else if (msg.localType === 47 && msg.emojiCdnUrl) {
        const cacheKey = msg.emojiMd5 || msg.emojiCdnUrl
        let emojiPath = emojiCache.get(cacheKey)
        if (!emojiPath) {
          emojiPath = await this.persistEmoji(msg.emojiCdnUrl, msg.emojiMd5, emojisDir, idx)
          if (emojiPath) emojiCache.set(cacheKey, emojiPath)
        }
        msg.emojiPath = emojiPath || null
      } else if (msg.localType === 34) {
        const voicePath = await this.persistVoice(sessionId, msg, voicesDir, idx)
        msg.voicePath = voicePath || null
      }
    }

    notify?.('writing', '写入数据库与查看器')
    await this.writeDatabase({
      sessionId,
      sessionName,
      dataRoot,
      dbDir,
      participants,
      messages
    })

    await this.writeViewerApp(sessionRoot)

    notify?.('complete', '完成')
  }

  private async writeDatabase(payload: {
    sessionId: string
    sessionName: string
    dataRoot: string
    dbDir: string
    participants: Map<string, { displayName: string; avatarPath?: string }>
    messages: MessageRecord[]
  }): Promise<void> {
    const dbPath = path.join(payload.dbDir, 'messages.db')
    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')

    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS session (
        id TEXT PRIMARY KEY,
        displayName TEXT,
        type TEXT,
        avatarPath TEXT
      );
      CREATE TABLE IF NOT EXISTS participants (
        username TEXT PRIMARY KEY,
        displayName TEXT,
        avatarPath TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        localId INTEGER,
        serverId INTEGER,
        localType INTEGER,
        createTime INTEGER,
        sortSeq INTEGER,
        isSend INTEGER,
        senderUsername TEXT,
        senderDisplayName TEXT,
        parsedContent TEXT,
        rawContent TEXT,
        emojiCdnUrl TEXT,
        emojiMd5 TEXT,
        emojiPath TEXT,
        imageMd5 TEXT,
        imageDatName TEXT,
        imagePath TEXT,
        voiceDurationSeconds INTEGER,
        voicePath TEXT,
        quotedContent TEXT,
        quotedSender TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_createTime ON messages(createTime);
    `)

    const insertMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    insertMeta.run('exportedAt', new Date().toISOString())
    insertMeta.run('generator', 'WeFlow Standalone')

    const sessionType = payload.sessionId.includes('@chatroom') ? 'group' : 'private'
    const sessionAvatar = payload.participants.get(payload.sessionId)?.avatarPath || null
    const insertSession = db.prepare('INSERT OR REPLACE INTO session (id, displayName, type, avatarPath) VALUES (?, ?, ?, ?)')
    insertSession.run(payload.sessionId, payload.sessionName, sessionType, sessionAvatar)

    const insertParticipant = db.prepare('INSERT OR REPLACE INTO participants (username, displayName, avatarPath) VALUES (?, ?, ?)')
    for (const [username, info] of payload.participants.entries()) {
      insertParticipant.run(username, info.displayName, info.avatarPath || null)
    }

    const insertMessage = db.prepare(`
      INSERT INTO messages (
        localId, serverId, localType, createTime, sortSeq, isSend,
        senderUsername, senderDisplayName, parsedContent, rawContent,
        emojiCdnUrl, emojiMd5, emojiPath,
        imageMd5, imageDatName, imagePath,
        voiceDurationSeconds, voicePath,
        quotedContent, quotedSender
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const participants = payload.participants
    const insertMany = db.transaction((rows: MessageRecord[]) => {
      for (const msg of rows) {
        const senderName = participants.get(msg.senderUsername || '')?.displayName || msg.senderUsername || ''
        insertMessage.run(
          msg.localId ?? null,
          msg.serverId ?? null,
          msg.localType ?? null,
          msg.createTime ?? null,
          msg.sortSeq ?? null,
          msg.isSend ?? null,
          msg.senderUsername ?? null,
          senderName,
          msg.parsedContent ?? null,
          msg.rawContent ?? null,
          msg.emojiCdnUrl ?? null,
          msg.emojiMd5 ?? null,
          (msg as any).emojiPath ?? null,
          msg.imageMd5 ?? null,
          msg.imageDatName ?? null,
          (msg as any).imagePath ?? null,
          msg.voiceDurationSeconds ?? null,
          (msg as any).voicePath ?? null,
          msg.quotedContent ?? null,
          msg.quotedSender ?? null
        )
      }
    })

    insertMany(payload.messages)
    db.close()
  }

  private async writeViewerApp(sessionRoot: string): Promise<void> {
    const appDir = path.join(sessionRoot, 'standalone-app')
    const rendererDir = path.join(appDir, 'renderer')
    this.ensureDir(rendererDir)

    const pkg = {
      name: 'weflow-standalone-viewer',
      private: true,
      version: '1.0.0',
      main: 'main.js',
      type: 'module',
      scripts: {
        start: 'electron .'
      },
      dependencies: {
        electron: '^39.2.7',
        react: '^19.2.3',
        'react-dom': '^19.2.3',
        'better-sqlite3': '^12.5.0'
      }
    }
    fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf-8')

    const mainJs = `
import { app, BrowserWindow } from 'electron'
import { join } from 'path'

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: join(process.cwd(), 'preload.js'),
      contextIsolation: true
    }
  })
  win.loadFile(join(process.cwd(), 'renderer', 'index.html'))
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
`.trimStart()
    fs.writeFileSync(path.join(appDir, 'main.js'), mainJs, 'utf-8')

    const preloadJs = `
import { contextBridge } from 'electron'
import { join } from 'path'
import Database from 'better-sqlite3'
import fs from 'fs'

function loadData() {
  const dataRoot = join(process.cwd(), '..', 'mydata')
  const dbPath = join(dataRoot, 'db', 'messages.db')
  const db = new Database(dbPath, { readonly: true })
  const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]))
  const session = db.prepare('SELECT * FROM session LIMIT 1').get()
  const participants = db.prepare('SELECT * FROM participants').all()
  const messages = db.prepare('SELECT * FROM messages ORDER BY createTime ASC').all()
  db.close()
  return { meta, session, participants, messages, dataRoot }
}

contextBridge.exposeInMainWorld('viewerAPI', {
  loadData
})
`.trimStart()
    fs.writeFileSync(path.join(appDir, 'preload.js'), preloadJs, 'utf-8')

    const indexHtml = `
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>WeFlow Standalone</title>
    <link rel="stylesheet" href="style.css" />
    <script crossorigin src="https://unpkg.com/react@19/umd/react.production.min.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@19/umd/react-dom.production.min.js"></script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./app.js"></script>
  </body>
</html>
`.trimStart()
    fs.writeFileSync(path.join(rendererDir, 'index.html'), indexHtml, 'utf-8')

    const styleCss = `
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', 'Microsoft YaHei', sans-serif; background: #f6f7fb; color: #1f2329; }
.layout { display: grid; grid-template-columns: 280px 1fr; height: 100vh; }
.sidebar { border-right: 1px solid #e5e7eb; padding: 16px; overflow: auto; background: #fff; }
.content { padding: 16px; overflow: auto; }
.session-card { padding: 12px; border: 1px solid #e5e7eb; border-radius: 10px; background: #fff; margin-bottom: 12px; }
.message { padding: 10px 12px; margin-bottom: 8px; border-radius: 10px; background: #fff; border: 1px solid #e5e7eb; }
.message .meta { display: flex; gap: 8px; align-items: center; color: #6b7280; font-size: 12px; margin-bottom: 6px; }
.badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 999px; background: #eef2ff; color: #4338ca; font-size: 12px; }
.media { margin-top: 8px; }
.media img { max-width: 360px; border-radius: 8px; border: 1px solid #e5e7eb; }
.media audio { width: 320px; }
table.meta { width: 100%; border-collapse: collapse; margin-top: 8px; }
table.meta td { padding: 4px 8px; border: 1px solid #e5e7eb; font-size: 12px; }
`.trimStart()
    fs.writeFileSync(path.join(rendererDir, 'style.css'), styleCss, 'utf-8')

    const appJs = `
const { useEffect, useState, useMemo } = React

function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  return d.toLocaleString()
}

function MessageItem({ msg, participants }) {
  const sender = participants[msg.senderUsername] || {}
  return (
    React.createElement('div', { className: 'message' }, [
      React.createElement('div', { key: 'meta', className: 'meta' }, [
        React.createElement('span', { key: 'sender' }, sender.displayName || msg.senderUsername || '未知'),
        React.createElement('span', { key: 'time' }, formatTime(msg.createTime)),
        React.createElement('span', { key: 'type', className: 'badge' }, msg.localType)
      ]),
      React.createElement('div', { key: 'text' }, msg.parsedContent || ''),
      msg.imagePath
        ? React.createElement('div', { key: 'img', className: 'media' },
            React.createElement('img', { src: '../../mydata/' + msg.imagePath, alt: '' })
          )
        : null,
      msg.emojiPath
        ? React.createElement('div', { key: 'emoji', className: 'media' },
            React.createElement('img', { src: '../../mydata/' + msg.emojiPath, alt: '' })
          )
        : null,
      msg.voicePath
        ? React.createElement('div', { key: 'voice', className: 'media' },
            React.createElement('audio', { controls: true, src: '../../mydata/' + msg.voicePath })
          )
        : null
    ])
  )
}

function App() {
  const [data, setData] = useState(null)
  useEffect(() => {
    const loaded = window.viewerAPI.loadData()
    setData(loaded)
  }, [])

  const participantsMap = useMemo(() => {
    const map = {}
    data?.participants?.forEach((p) => {
      map[p.username] = p
    })
    return map
  }, [data])

  if (!data) {
    return React.createElement('div', { style: { padding: 24 } }, '正在加载...')
  }

  return (
    React.createElement('div', { className: 'layout' }, [
      React.createElement('div', { key: 'sidebar', className: 'sidebar' },
        React.createElement('div', { className: 'session-card' }, [
          React.createElement('h3', { key: 'title' }, data.session?.displayName || data.session?.id || '会话'),
          React.createElement('table', { key: 'meta', className: 'meta' }, [
            React.createElement('tbody', { key: 'body' }, [
              React.createElement('tr', { key: 'type' }, [
                React.createElement('td', { key: 'k1' }, '类型'),
                React.createElement('td', { key: 'v1' }, data.session?.type || '')
              ]),
              React.createElement('tr', { key: 'export' }, [
                React.createElement('td', { key: 'k2' }, '导出时间'),
                React.createElement('td', { key: 'v2' }, data.meta?.exportedAt || '')
              ])
            ])
          ])
        ])
      ),
      React.createElement('div', { key: 'content', className: 'content' },
        data.messages.map((msg, idx) =>
          React.createElement(MessageItem, { key: idx, msg, participants: participantsMap })
        )
      )
    ])
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App))
`.trimStart()
    fs.writeFileSync(path.join(rendererDir, 'app.js'), appJs, 'utf-8')
  }

  private async persistImage(
    msg: any,
    sessionId: string,
    imagesDir: string
  ): Promise<string | null> {
    try {
      const result = await imageDecryptService.decryptImage({
        sessionId,
        imageMd5: msg.imageMd5,
        imageDatName: msg.imageDatName,
        force: true
      })
      if (!result.success || !result.localPath) return null
      const { buffer, ext } = await this.resolveBinary(result.localPath)
      if (!buffer) return null
      const fileName = `img_${msg.createTime || msg.localId || Date.now()}.` + (ext || 'jpg').replace(/^\./, '')
      const filePath = path.join(imagesDir, fileName)
      fs.writeFileSync(filePath, buffer)
      return path.relative(path.join(imagesDir, '..'), filePath).replace(/\\/g, '/')
    } catch {
      return null
    }
  }

  private async persistEmoji(
    cdnUrl: string,
    md5: string | undefined,
    emojisDir: string,
    idx: number
  ): Promise<string | null> {
    try {
      const result = await chatService.downloadEmoji(cdnUrl, md5)
      if (!result.success || !result.localPath) return null
      const { buffer, ext } = await this.resolveBinary(result.localPath, 'gif')
      if (!buffer) return null
      const fileName = `emoji_${md5 || idx}.${(ext || 'gif').replace(/^\./, '')}`
      const filePath = path.join(emojisDir, fileName)
      fs.writeFileSync(filePath, buffer)
      return path.relative(path.join(emojisDir, '..'), filePath).replace(/\\/g, '/')
    } catch {
      return null
    }
  }

  private async persistVoice(
    sessionId: string,
    msg: any,
    voicesDir: string,
    idx: number
  ): Promise<string | null> {
    try {
      const voice = await chatService.getVoiceData(sessionId, String(msg.localId || msg.serverId || idx))
      if (!voice.success || !voice.data) return null
      const buffer = Buffer.from(voice.data, 'base64')
      const fileName = `voice_${msg.createTime || msg.localId || idx}.wav`
      const filePath = path.join(voicesDir, fileName)
      fs.writeFileSync(filePath, buffer)
      return path.relative(path.join(voicesDir, '..'), filePath).replace(/\\/g, '/')
    } catch {
      return null
    }
  }

  private async persistAvatar(avatarUrl: string | undefined, avatarsDir: string, username: string): Promise<string | undefined> {
    if (!avatarUrl) return undefined
    try {
      const { buffer, ext } = await this.resolveBinary(avatarUrl, 'jpg')
      if (!buffer) return undefined
      const fileName = `${this.safeName(username)}.${(ext || 'jpg').replace(/^\./, '')}`
      const filePath = path.join(avatarsDir, fileName)
      fs.writeFileSync(filePath, buffer)
      return path.relative(path.join(avatarsDir, '..'), filePath).replace(/\\/g, '/')
    } catch {
      return undefined
    }
  }

  private async resolveBinary(input: string, fallbackExt?: string): Promise<{ buffer?: Buffer; ext?: string }> {
    if (input.startsWith('data:')) {
      const match = /^data:([^;]+);base64,(.+)$/.exec(input)
      if (!match) return {}
      const mime = match[1]
      const ext = this.extFromMime(mime) || fallbackExt
      return { buffer: Buffer.from(match[2], 'base64'), ext }
    }
    if (input.startsWith('file://')) {
      const fsPath = fileURLToPath(input)
      const data = await fs.promises.readFile(fsPath)
      const ext = path.extname(fsPath) || fallbackExt
      return { buffer: data, ext }
    }
    if (input.startsWith('http://') || input.startsWith('https://')) {
      // 远程 URL 暂不下载，直接返回空
      return {}
    }
    const ext = path.extname(input) || fallbackExt
    const data = await fs.promises.readFile(input)
    return { buffer: data, ext }
  }

  private extFromMime(mime: string): string | undefined {
    const lower = mime.toLowerCase()
    if (lower.includes('png')) return 'png'
    if (lower.includes('gif')) return 'gif'
    if (lower.includes('webp')) return 'webp'
    if (lower.includes('bmp')) return 'bmp'
    return 'jpg'
  }

  private ensureDir(dir: string) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  private safeName(name: string): string {
    return name.replace(/[<>:"/\\\\|?*]+/g, '_').trim() || 'session'
  }

  private async ensureOutputDir(outputDir: string): Promise<string> {
    this.ensureDir(outputDir)
    const base = `Standalone_${this.timestamp()}`
    let target = path.join(outputDir, base)
    let counter = 1
    while (fs.existsSync(target)) {
      counter += 1
      target = path.join(outputDir, `${base}_${counter}`)
    }
    this.ensureDir(target)
    return target
  }

  private timestamp(): string {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  }

  private async ensureConnected(): Promise<{ success: boolean; error?: string }> {
    const wxid = this.configService.get('myWxid')
    const dbPath = this.configService.get('dbPath')
    const decryptKey = this.configService.get('decryptKey')
    if (!wxid) return { success: false, error: '请先在设置页面配置微信ID' }
    if (!dbPath) return { success: false, error: '请先在设置页面配置数据库路径' }
    if (!decryptKey) return { success: false, error: '请先在设置页面配置解密密钥' }
    const connect = await chatService.connect()
    if (!connect.success) return { success: false, error: connect.error || 'WCDB 连接失败' }
    return { success: true }
  }

  private async getDisplayName(username: string): Promise<string> {
    const info = await chatService.getContactAvatar(username)
    return info?.displayName || username
  }
}

export const standaloneExportService = new StandaloneExportService()
