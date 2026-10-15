// qrlogin.js — 扫码登录 UI：设置页「账号登录」分组内的扫码弹窗 + 轮询。
// Cookie 由 go-music-dl 落库，本模块只做「创建会话 → 展示二维码 → 轮询状态」；
// image_url 优先（qq/qq_wx 有官方图），否则用内置 qrcode.js 把 url 画成二维码。
import { API } from './api.js'
import { sourceLabel } from './state.js'
import { showSnackbar } from './util.js'
import { drawQRToCanvas } from './qrcode.js'

const POLL_INTERVAL_MS = 2200
const POLL_MAX_MS = 5 * 60 * 1000 // 与上游二维码有效期对齐（2-5min），超时自动停止

const STATUS_TEXT = {
  waiting: '等待扫码…',
  scanned: '已扫码，请在手机上确认',
  success: '登录成功，Cookie 已保存到 go-music-dl',
  expired: '二维码已过期',
  failed: '登录失败',
}

let state = {
  source: '',
  key: '',
  timer: 0,
  startedAt: 0,
  pollBusy: false,
}

function clearPoll() {
  if (state.timer) {
    clearInterval(state.timer)
    state.timer = 0
  }
  state.pollBusy = false
}

function setStatus(text, kind = '') {
  const el = document.getElementById('qrStatus')
  if (!el) return
  el.textContent = text || ''
  el.className = 'qr-status' + (kind ? ' ' + kind : '')
}

function setBusy(show, text = '正在生成二维码…') {
  const el = document.getElementById('qrBusy')
  if (!el) return
  el.textContent = text
  el.style.display = show ? 'block' : 'none'
}

function setExpired(show) {
  const el = document.getElementById('qrRefreshBtn')
  if (el) el.style.display = show ? 'inline-flex' : 'none'
}

function closePanel() {
  clearPoll()
  const p = document.getElementById('qrPanel')
  if (p) p.classList.remove('show')
}

async function renderSession(session) {
  const canvas = document.getElementById('qrCanvas')
  const img = document.getElementById('qrImage')
  if (!canvas || !img) return
  const imageUrl = String(session.image_url || '').trim()
  const loginUrl = String(session.url || '').trim()
  if (imageUrl) {
    img.src = imageUrl
    img.style.display = 'block'
    canvas.style.display = 'none'
    setBusy(false)
    return
  }
  if (!loginUrl) throw new Error('二维码内容为空')
  drawQRToCanvas(loginUrl, canvas)
  canvas.style.display = 'block'
  img.style.display = 'none'
  setBusy(false)
}

async function pollOnce() {
  if (state.pollBusy || !state.source || !state.key) return
  state.pollBusy = true
  try {
    const r = await API.qrPoll(state.source, state.key)
    const status = String(r.status || '')
    if (status === 'success') {
      setStatus(STATUS_TEXT.success, 'success')
      setBusy(false)
      clearPoll()
      showSnackbar('扫码登录成功')
      setTimeout(closePanel, 1200)
      return
    }
    if (status === 'scanned') {
      setStatus(STATUS_TEXT.scanned, 'ok')
    } else if (status === 'expired' || status === 'failed') {
      setStatus(
        (STATUS_TEXT[status] || '登录失败') + (r.message ? '：' + r.message : '') + '，可点击刷新重试',
        'err',
      )
      setBusy(false)
      setExpired(true)
      clearPoll()
      return
    }
    if (Date.now() - state.startedAt > POLL_MAX_MS) {
      setStatus('登录超时，请刷新二维码重试', 'err')
      setExpired(true)
      clearPoll()
    }
  } catch (e) {
    // 轮询偶发失败不打断（网络抖动），连续失败由超时兜底
  } finally {
    state.pollBusy = false
  }
}

async function start(source) {
  clearPoll()
  setExpired(false)
  setBusy(true)
  setStatus('正在生成二维码…')
  state = { source, key: '', timer: 0, startedAt: Date.now(), pollBusy: false }
  const panel = document.getElementById('qrPanel')
  const canvas = document.getElementById('qrCanvas')
  const img = document.getElementById('qrImage')
  if (canvas) canvas.style.display = 'none'
  if (img) {
    img.removeAttribute('src')
    img.style.display = 'none'
  }
  if (panel) panel.classList.add('show')
  try {
    const { session } = await API.qrStart(source)
    state.key = session.key
    await renderSession(session)
    setStatus('二维码已生成，请打开对应 App 扫码')
    state.timer = setInterval(pollOnce, POLL_INTERVAL_MS)
  } catch (e) {
    setBusy(false)
    setStatus((e && e.message) || '二维码创建失败', 'err')
  }
}

export async function openQrLogin(source, channelLabel) {
  if (!source) return
  // 弹窗标题带上渠道（如「QQ 音乐 · 微信扫码」），避免混淆同一平台的多个渠道
  const title = document.getElementById('qrTitle')
  if (title) title.textContent = channelLabel ? `${channelLabel}登录` : '扫码登录'
  await start(source)
}

export function initQrLogin() {
  const closeBtn = document.getElementById('qrCloseBtn')
  if (closeBtn) closeBtn.onclick = closePanel
  const refreshBtn = document.getElementById('qrRefreshBtn')
  if (refreshBtn)
    refreshBtn.onclick = () => {
      if (state.source) start(state.source)
    }
  // 平台卡片：后端 /qr/sources 拉列表，失败时用 SOURCE_LABELS 派生的兜底列表
  renderSourceCards().catch(() => {})
}

// 兜底源列表：由 state.js 的 SOURCE_LABELS 派生（名称单点），仅在后端 /qr/sources
// 不可用时使用（正常应与其后端 QR_SOURCES 内容一致）
const FALLBACK_SOURCES = ['netease', 'qq', 'qq_wx', 'kugou', 'bilibili'].map((s) => ({
  source: s,
  name: sourceLabel(s) || s,
}))

// 渠道布局：同一平台的多个扫码渠道（qq=QQ App 扫 / qq_wx=微信扫，两者 Cookie 均写入
// gmd 的 qq 名下，见上游 qr_login.go qrLoginCookieSource 的归并）合并一行展示，
// 避免看起来像重复项；未知来源（上游后续新增）自动追加为独立行。
const CHANNEL_LAYOUT = [
  { label: '网易云音乐', channels: [{ source: 'netease', label: '扫码登录' }] },
  {
    label: 'QQ 音乐',
    channels: [
      { source: 'qq', label: 'QQ 扫码' },
      { source: 'qq_wx', label: '微信扫码' },
    ],
  },
  { label: '酷狗音乐', channels: [{ source: 'kugou', label: '扫码登录' }] },
  { label: 'Bilibili', channels: [{ source: 'bilibili', label: '扫码登录' }] },
]

function groupSources(sources) {
  const bySource = new Map(sources.map((s) => [s.source, s]))
  const rows = []
  const used = new Set()
  for (const g of CHANNEL_LAYOUT) {
    const channels = g.channels.filter((c) => bySource.has(c.source))
    if (!channels.length) continue
    channels.forEach((c) => used.add(c.source))
    rows.push({ label: g.label, channels })
  }
  for (const s of sources) {
    if (!used.has(s.source)) {
      rows.push({
        label: s.name || s.source,
        channels: [{ source: s.source, label: '扫码登录' }],
      })
    }
  }
  return rows
}

async function renderSourceCards() {
  const box = document.getElementById('qrSourceList')
  if (!box || box.childElementCount) return
  let sources = FALLBACK_SOURCES
  try {
    const r = await API.qrSources()
    if (Array.isArray(r.sources) && r.sources.length) sources = r.sources
  } catch {
    /* 用内置列表兜底 */
  }
  box.innerHTML = ''
  for (const row of groupSources(sources)) {
    const el = document.createElement('div')
    el.className = 'qr-source-row'
    const nameSpan = document.createElement('span')
    nameSpan.className = 'qr-source-name'
    nameSpan.textContent = row.label
    const actions = document.createElement('div')
    actions.className = 'qr-source-actions'
    for (const ch of row.channels) {
      const btn = document.createElement('button')
      btn.className = 'btn-text qr-login-btn'
      btn.type = 'button'
      btn.textContent = ch.label
      btn.onclick = () => openQrLogin(ch.source, ch.label)
      actions.appendChild(btn)
    }
    el.appendChild(nameSpan)
    el.appendChild(actions)
    box.appendChild(el)
  }
}
