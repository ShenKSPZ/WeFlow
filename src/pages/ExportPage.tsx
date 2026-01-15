import { useState, useEffect, useCallback } from 'react'
import { Search, Download, FolderOpen, RefreshCw, Check, Calendar, FileJson, FileText, Table, Loader2, X, ChevronDown, ChevronLeft, ChevronRight, FileSpreadsheet, Database, FileCode, CheckCircle, XCircle, ExternalLink } from 'lucide-react'
import * as configService from '../services/config'
import './ExportPage.scss'

interface ChatSession {
  username: string
  displayName?: string
  avatarUrl?: string
  summary: string
  lastTimestamp: number
}

interface ExportOptions {
  format: 'chatlab' | 'chatlab-jsonl' | 'json' | 'html' | 'txt' | 'excel' | 'sql' | 'standalone'
  dateRange: { start: Date; end: Date } | null
  useAllTime: boolean
  exportAvatars: boolean
}

interface ExportResult {
  success: boolean
  successCount?: number
  failCount?: number
  error?: string
}

function ExportPage() {
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [filteredSessions, setFilteredSessions] = useState<ChatSession[]>([])
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set())
  const [isLoading, setIsLoading] = useState(true)
  const [searchKeyword, setSearchKeyword] = useState('')
  const [exportFolder, setExportFolder] = useState<string>('')
  const [isExporting, setIsExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState({ current: 0, total: 0, currentName: '' })
  const [exportResult, setExportResult] = useState<ExportResult | null>(null)
  const [showDatePicker, setShowDatePicker] = useState(false)
  const [calendarDate, setCalendarDate] = useState(new Date())
  const [selectingStart, setSelectingStart] = useState(true)

  const [options, setOptions] = useState<ExportOptions>({
    format: 'chatlab',
    dateRange: {
      start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      end: new Date()
    },
    useAllTime: true,
    exportAvatars: true
  })

  const loadSessions = useCallback(async () => {
    setIsLoading(true)
    try {
      const result = await window.electronAPI.chat.connect()
      if (!result.success) {
        console.error('连接失败:', result.error)
        setIsLoading(false)
        return
      }
      const sessionsResult = await window.electronAPI.chat.getSessions()
      if (sessionsResult.success && sessionsResult.sessions) {
        setSessions(sessionsResult.sessions)
        setFilteredSessions(sessionsResult.sessions)
      }
    } catch (e) {
      console.error('加载会话失败:', e)
    } finally {
      setIsLoading(false)
    }
  }, [])

  const loadExportPath = useCallback(async () => {
    try {
      const savedPath = await configService.getExportPath()
      if (savedPath) {
        setExportFolder(savedPath)
      } else {
        const downloadsPath = await window.electronAPI.app.getDownloadsPath()
        setExportFolder(downloadsPath)
      }
    } catch (e) {
      console.error('加载导出路径失败:', e)
    }
  }, [])

  useEffect(() => {
    loadSessions()
    loadExportPath()
  }, [loadSessions, loadExportPath])

  useEffect(() => {
    if (!searchKeyword.trim()) {
      setFilteredSessions(sessions)
      return
    }
    const lower = searchKeyword.toLowerCase()
    setFilteredSessions(sessions.filter(s =>
      s.displayName?.toLowerCase().includes(lower) ||
      s.username.toLowerCase().includes(lower)
    ))
  }, [searchKeyword, sessions])

  const toggleSession = (username: string) => {
    const newSet = new Set(selectedSessions)
    if (newSet.has(username)) {
      newSet.delete(username)
    } else {
      newSet.add(username)
    }
    setSelectedSessions(newSet)
  }

  const toggleSelectAll = () => {
    if (selectedSessions.size === filteredSessions.length) {
      setSelectedSessions(new Set())
    } else {
      setSelectedSessions(new Set(filteredSessions.map(s => s.username)))
    }
  }

  const getAvatarLetter = (name: string) => {
    if (!name) return '?'
    return [...name][0] || '?'
  }

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
  }

  const openExportFolder = async () => {
    if (exportFolder) {
      await window.electronAPI.shell.openPath(exportFolder)
    }
  }

  const startExport = async () => {
    if (selectedSessions.size === 0 || !exportFolder) return

    setIsExporting(true)
    setExportProgress({ current: 0, total: selectedSessions.size, currentName: '' })
    setExportResult(null)

    try {
      const sessionList = Array.from(selectedSessions)
      const exportOptions = {
        format: options.format,
        exportAvatars: options.exportAvatars,
        dateRange: options.useAllTime ? null : options.dateRange ? {
          start: Math.floor(options.dateRange.start.getTime() / 1000),
          // 将结束日期设置为当天的 23:59:59,以包含当天的所有消息
          end: Math.floor(new Date(options.dateRange.end.getFullYear(), options.dateRange.end.getMonth(), options.dateRange.end.getDate(), 23, 59, 59).getTime() / 1000)
        } : null
      }

      if (options.format === 'standalone') {
        const result = await window.electronAPI.export.standaloneSessions(
          sessionList,
          exportFolder,
          {
            dateRange: exportOptions.dateRange,
            exportAvatars: options.exportAvatars
          }
        )
        setExportProgress({ current: sessionList.length, total: sessionList.length, currentName: '' })
        setExportResult(result)
      } else if (options.format === 'chatlab' || options.format === 'chatlab-jsonl' || options.format === 'json') {
        const result = await window.electronAPI.export.exportSessions(
          sessionList,
          exportFolder,
          exportOptions
        )
        setExportResult(result)
      } else {
        setExportResult({ success: false, error: `${options.format.toUpperCase()} 格式导出功能开发中...` })
      }
    } catch (e) {
      console.error('导出失败:', e)
      setExportResult({ success: false, error: String(e) })
    } finally {
      setIsExporting(false)
    }
  }

  const getDaysInMonth = (date: Date) => {
    const year = date.getFullYear()
    const month = date.getMonth()
    return new Date(year, month + 1, 0).getDate()
  }

  const getFirstDayOfMonth = (date: Date) => {
    const year = date.getFullYear()
    const month = date.getMonth()
    return new Date(year, month, 1).getDay()
  }

  const generateCalendar = () => {
    const daysInMonth = getDaysInMonth(calendarDate)
    const firstDay = getFirstDayOfMonth(calendarDate)
    const days: (number | null)[] = []

    for (let i = 0; i < firstDay; i++) {
      days.push(null)
    }

    for (let i = 1; i <= daysInMonth; i++) {
      days.push(i)
    }

    return days
  }

  const handleDateSelect = (day: number) => {
    const year = calendarDate.getFullYear()
    const month = calendarDate.getMonth()
    const selectedDate = new Date(year, month, day)

    if (selectingStart) {
      setOptions({
        ...options,
        dateRange: options.dateRange ? { ...options.dateRange, start: selectedDate } : { start: selectedDate, end: new Date() }
      })
      setSelectingStart(false)
    } else {
      setOptions({
        ...options,
        dateRange: options.dateRange ? { ...options.dateRange, end: selectedDate } : { start: new Date(), end: selectedDate }
      })
      setSelectingStart(true)
    }
  }

  const formatOptions = [
    { value: 'chatlab', label: 'ChatLab', icon: FileCode, desc: '标准格式，支持其他软件导入' },
    { value: 'chatlab-jsonl', label: 'ChatLab JSONL', icon: FileCode, desc: '流式格式，适合大量消息' },
    { value: 'json', label: 'JSON', icon: FileJson, desc: '详细格式，包含完整消息信息' },
    { value: 'standalone', label: 'Standalone', icon: ExternalLink, desc: '生成可独立查看的桌面版浏览器' },
    { value: 'html', label: 'HTML', icon: FileText, desc: '网页格式，可直接浏览' },
    { value: 'txt', label: 'TXT', icon: Table, desc: '纯文本，通用格式' },
    { value: 'excel', label: 'Excel', icon: FileSpreadsheet, desc: '电子表格，适合统计分析' },
    { value: 'sql', label: 'PostgreSQL', icon: Database, desc: '数据库脚本，便于导入到数据库' }
  ]

  return (
    <div className="export-page">
      <div className="session-panel">
        <div className="panel-header">
          <h2>选择会话</h2>
          <button className="icon-btn" onClick={loadSessions} disabled={isLoading}>
            <RefreshCw size={18} className={isLoading ? 'spin' : ''} />
          </button>
        </div>

        <div className="search-bar">
          <Search size={16} />
          <input
            type="text"
            placeholder="搜索联系人或群组..."
            value={searchKeyword}
            onChange={e => setSearchKeyword(e.target.value)}
          />
          {searchKeyword && (
            <button className="clear-btn" onClick={() => setSearchKeyword('')}>
              <X size={14} />
            </button>
          )}
        </div>

        <div className="select-actions">
          <button className="select-all-btn" onClick={toggleSelectAll}>
            {selectedSessions.size === filteredSessions.length && filteredSessions.length > 0 ? '取消全选' : '全选'}
          </button>
          <span className="selected-count">已选 {selectedSessions.size} 个</span>
        </div>

        {isLoading ? (
          <div className="loading-state">
            <Loader2 size={24} className="spin" />
            <span>加载中...</span>
          </div>
        ) : filteredSessions.length === 0 ? (
          <div className="empty-state">
            <span>暂无会话</span>
          </div>
        ) : (
          <div className="export-session-list">
            {filteredSessions.map(session => (
              <div
                key={session.username}
                className={`export-session-item ${selectedSessions.has(session.username) ? 'selected' : ''}`}
                onClick={() => toggleSession(session.username)}
              >
                <div className="check-box">
                  {selectedSessions.has(session.username) && <Check size={14} />}
                </div>
                <div className="export-avatar">
                  {session.avatarUrl ? (
                    <img src={session.avatarUrl} alt="" />
                  ) : (
                    <span>{getAvatarLetter(session.displayName || session.username)}</span>
                  )}
                </div>
                <div className="export-session-info">
                  <div className="export-session-name">{session.displayName || session.username}</div>
                  <div className="export-session-summary">{session.summary || '暂无消息'}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="settings-panel">
        <div className="panel-header">
          <h2>导出设置</h2>
        </div>

        <div className="settings-content">
          <div className="setting-section">
            <h3>导出格式</h3>
            <div className="format-options">
              {formatOptions.map(fmt => (
                <div
                  key={fmt.value}
                  className={`format-card ${options.format === fmt.value ? 'active' : ''}`}
                  onClick={() => setOptions({ ...options, format: fmt.value as any })}
                >
                  <fmt.icon size={24} />
                  <span className="format-label">{fmt.label}</span>
                  <span className="format-desc">{fmt.desc}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="setting-section">
            <h3>时间范围</h3>
            <div className="time-options">
              <label className="checkbox-item">
                <input
                  type="checkbox"
                  checked={options.useAllTime}
                  onChange={e => setOptions({ ...options, useAllTime: e.target.checked })}
                />
                <span>导出全部时间</span>
              </label>
              {!options.useAllTime && options.dateRange && (
                <div className="date-range" onClick={() => setShowDatePicker(true)}>
                  <Calendar size={16} />
                  <span>{formatDate(options.dateRange.start)} - {formatDate(options.dateRange.end)}</span>
                  <ChevronDown size={14} />
                </div>
              )}
            </div>
          </div>

          <div className="setting-section">
            <h3>导出头像</h3>
            <div className="time-options">
              <label className="checkbox-item">
                <input
                  type="checkbox"
                  checked={options.exportAvatars}
                  onChange={e => setOptions({ ...options, exportAvatars: e.target.checked })}
                />
                <span>导出头像图片</span>
              </label>
            </div>
          </div>

          <div className="setting-section">
            <h3>导出位置</h3>
            <div className="export-path-display">
              <FolderOpen size={16} />
              <span>{exportFolder || '未设置'}</span>
            </div>
            <button
              className="select-folder-btn"
              onClick={async () => {
                try {
                  const result = await window.electronAPI.dialog.openFile({
                    title: '选择导出目录',
                    properties: ['openDirectory']
                  })
                  if (!result.canceled && result.filePaths.length > 0) {
                    setExportFolder(result.filePaths[0])
                    await configService.setExportPath(result.filePaths[0])
                  }
                } catch (e) {
                  console.error('选择目录失败:', e)
                }
              }}
            >
              <FolderOpen size={16} />
              <span>选择导出目录</span>
            </button>
          </div>
        </div>

        <div className="export-action">
          <button
            className="export-btn"
            onClick={startExport}
            disabled={selectedSessions.size === 0 || !exportFolder || isExporting}
          >
            {isExporting ? (
              <>
                <Loader2 size={18} className="spin" />
                <span>导出中 ({exportProgress.current}/{exportProgress.total})</span>
              </>
            ) : (
              <>
                <Download size={18} />
                <span>开始导出</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* 导出进度弹窗 */}
      {isExporting && (
        <div className="export-overlay">
          <div className="export-progress-modal">
            <div className="progress-spinner">
              <Loader2 size={32} className="spin" />
            </div>
            <h3>正在导出</h3>
            <p className="progress-text">{exportProgress.currentName}</p>
            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{ width: `${(exportProgress.current / exportProgress.total) * 100}%` }}
              />
            </div>
            <p className="progress-count">{exportProgress.current} / {exportProgress.total}</p>
          </div>
        </div>
      )}

      {/* 导出结果弹窗 */}
      {exportResult && (
        <div className="export-overlay">
          <div className="export-result-modal">
            <div className={`result-icon ${exportResult.success ? 'success' : 'error'}`}>
              {exportResult.success ? <CheckCircle size={48} /> : <XCircle size={48} />}
            </div>
            <h3>{exportResult.success ? '导出完成' : '导出失败'}</h3>
            {exportResult.success ? (
              <p className="result-text">
                成功导出 {exportResult.successCount} 个会话
                {exportResult.failCount ? `，${exportResult.failCount} 个失败` : ''}
              </p>
            ) : (
              <p className="result-text error">{exportResult.error}</p>
            )}
            <div className="result-actions">
              {exportResult.success && (
                <button className="open-folder-btn" onClick={openExportFolder}>
                  <ExternalLink size={16} />
                  <span>打开文件夹</span>
                </button>
              )}
              <button className="close-btn" onClick={() => setExportResult(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 日期选择弹窗 */}
      {showDatePicker && (
        <div className="export-overlay" onClick={() => setShowDatePicker(false)}>
          <div className="date-picker-modal" onClick={e => e.stopPropagation()}>
            <h3>选择时间范围</h3>
            <div className="quick-select">
              <button
                className="quick-btn"
                onClick={() => {
                  const end = new Date()
                  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000)
                  setOptions({ ...options, dateRange: { start, end } })
                }}
              >
                最近7天
              </button>
              <button
                className="quick-btn"
                onClick={() => {
                  const end = new Date()
                  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000)
                  setOptions({ ...options, dateRange: { start, end } })
                }}
              >
                最近30天
              </button>
              <button
                className="quick-btn"
                onClick={() => {
                  const end = new Date()
                  const start = new Date(end.getTime() - 90 * 24 * 60 * 60 * 1000)
                  setOptions({ ...options, dateRange: { start, end } })
                }}
              >
                最近90天
              </button>
            </div>
            <div className="date-display">
              <div
                className={`date-display-item ${selectingStart ? 'active' : ''}`}
                onClick={() => setSelectingStart(true)}
              >
                <span className="date-label">开始日期</span>
                <span className="date-value">
                  {options.dateRange?.start.toLocaleDateString('zh-CN', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit'
                  })}
                </span>
              </div>
              <span className="date-separator">至</span>
              <div
                className={`date-display-item ${!selectingStart ? 'active' : ''}`}
                onClick={() => setSelectingStart(false)}
              >
                <span className="date-label">结束日期</span>
                <span className="date-value">
                  {options.dateRange?.end.toLocaleDateString('zh-CN', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit'
                  })}
                </span>
              </div>
            </div>
            <div className="calendar-container">
              <div className="calendar-header">
                <button
                  className="calendar-nav-btn"
                  onClick={() => setCalendarDate(new Date(calendarDate.getFullYear(), calendarDate.getMonth() - 1, 1))}
                >
                  <ChevronLeft size={18} />
                </button>
                <span className="calendar-month">
                  {calendarDate.getFullYear()}年{calendarDate.getMonth() + 1}月
                </span>
                <button
                  className="calendar-nav-btn"
                  onClick={() => setCalendarDate(new Date(calendarDate.getFullYear(), calendarDate.getMonth() + 1, 1))}
                >
                  <ChevronRight size={18} />
                </button>
              </div>
              <div className="calendar-weekdays">
                {['日', '一', '二', '三', '四', '五', '六'].map(day => (
                  <div key={day} className="calendar-weekday">{day}</div>
                ))}
              </div>
              <div className="calendar-days">
                {generateCalendar().map((day, index) => {
                  if (day === null) {
                    return <div key={`empty-${index}`} className="calendar-day empty" />
                  }

                  const currentDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth(), day)
                  const isStart = options.dateRange?.start.toDateString() === currentDate.toDateString()
                  const isEnd = options.dateRange?.end.toDateString() === currentDate.toDateString()
                  const isInRange = options.dateRange && currentDate >= options.dateRange.start && currentDate <= options.dateRange.end

                  return (
                    <div
                      key={day}
                      className={`calendar-day ${isStart ? 'start' : ''} ${isEnd ? 'end' : ''} ${isInRange ? 'in-range' : ''}`}
                      onClick={() => handleDateSelect(day)}
                    >
                      {day}
                    </div>
                  )
                })}
              </div>
            </div>
            <div className="date-picker-actions">
              <button className="cancel-btn" onClick={() => setShowDatePicker(false)}>
                取消
              </button>
              <button className="confirm-btn" onClick={() => setShowDatePicker(false)}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ExportPage
