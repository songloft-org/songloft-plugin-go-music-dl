// cast.js — 投放到 MIoT 音箱
// 通过跨插件 HTTP（宿主同源 /api/v1/jsplugin/miot/mina/*）复用 miot 插件的控制面：
// 设备列表 / play-url / pause / resume / stop / volume / status。
// 交互遵循蓝牙隐喻：连接后所有播放转由音箱发声，断开时从音箱进度无缝回本地。
// 已知限制（v1，见可行性分析）：
//   1) MiNA 云端无 seek 命令 → 投放时禁用拖动进度（fullscreen.js 拦截）；
//   2) /mina/status 无曲目标识 → 语音打断/他人投放无法检测，UI 可能失真；
//   3) 音箱必须能直连宿主（直链由后端 /cast/stream-url 做 host 推导，失败则降级提示）。
import { store } from './state.js'
import { fmtTime, showSnackbar, escapeHtml } from './util.js'
import { API, hostPluginFetch } from './api.js'
import {
  getAudio,
  setPlayIcon,
  setBar,
  startAudio,
  updateNowPlaying,
  nextSong,
  resetNowPlayingUI,
} from './player.js'
import { highlightLyric } from './lyrics.js'
import { readStoredJson, writeStoredJson, clearPlaybackState } from './persist.js'

const CAST_KEY = 'gmd-cast-state'
const MIOT_BASE = '/api/v1/jsplugin/miot/mina'
const POLL_MS = 1500 // miot /mina/status 底层有 4s 缓存 + 位置外推，1.5s 轮询即够
// play-url 下发后等待 status 变为 playing 的窗口；超时仍 stopped 视为播放失败（音源失效等）
const PLAY_CONFIRM_MS = 8000

// 投放会话状态（不持久化；持久化的只有连接选择）
const cast = {
  playing: false, // 我方最后一次指令期望的播放态
  awaitingPlay: false, // play-url 已下发，等待 status 确认
  issuedAt: 0,
  lastVolume: null, // 最近一次已知的音箱音量（静音恢复用）
  muted: false,
}
let pollTimer = null
let pollInFlight = false

// ---------- 连接选择持久化（gmd- 前缀键名，所有插件与宿主同源共享 localStorage） ----------

function persistCastState() {
  writeStoredJson(CAST_KEY, { v: 1, ...store.cast })
}

// ---------- miot 调用 ----------

async function miotPost(action, body) {
  try {
    const j = await hostPluginFetch(`${MIOT_BASE}/${action}`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    return !!(j && j.success)
  } catch {
    return false
  }
}

// 查一次物理状态（含缓存 + 位置外推）；失败返回 null（按 miot 集成指南：保持轮询不销毁上下文）
async function fetchStatusOnce() {
  try {
    const q =
      `account_id=${encodeURIComponent(store.cast.accountId)}` +
      `&device_id=${encodeURIComponent(store.cast.deviceId)}`
    const j = await hostPluginFetch(`${MIOT_BASE}/status?${q}`)
    return j && j.success ? j.data : null
  } catch {
    return null
  }
}

// ---------- 设备列表 ----------

// 归一化 GET /mina/devices：
// { success, data: [{ account_id, account_name?, last_selected_device_id?, devices: [DeviceInfo] }] }
// DeviceInfo 关键字段：deviceID / name / alias / model / presence
function normalizeDevices(payload) {
  const data = (payload && payload.data) || []
  const out = []
  for (const acc of Array.isArray(data) ? data : []) {
    if (!acc || !acc.account_id) continue
    const accountName = acc.account_name || acc.account_id
    for (const dev of Array.isArray(acc.devices) ? acc.devices : []) {
      if (!dev || !dev.deviceID) continue
      out.push({
        accountId: acc.account_id,
        accountName,
        deviceId: dev.deviceID,
        name: dev.name || dev.alias || dev.model || '未命名音箱',
        model: dev.model || '',
        presence: dev.presence || '',
      })
    }
  }
  return out
}

export async function loadCastDevices() {
  const listEl = document.getElementById('castDeviceList')
  const hintEl = document.getElementById('castHint')
  if (!listEl) return
  listEl.innerHTML = '<div class="empty-state">正在获取音箱…</div>'
  if (hintEl) hintEl.style.display = 'none'
  let devices
  try {
    const payload = await hostPluginFetch(`${MIOT_BASE}/devices`)
    devices = normalizeDevices(payload)
  } catch (e) {
    listEl.innerHTML = ''
    if (hintEl) {
      hintEl.textContent = (e && e.message) || '获取音箱失败'
      hintEl.style.display = 'block'
    }
    return
  }
  if (!devices.length) {
    listEl.innerHTML = ''
    if (hintEl) {
      hintEl.textContent = '未发现音箱设备：请确认已在「智能音箱」插件登录小米账号'
      hintEl.style.display = 'block'
    }
    return
  }
  listEl.innerHTML = ''
  devices.forEach((dev) => {
    const active =
      store.cast.connected &&
      dev.accountId === store.cast.accountId &&
      dev.deviceId === store.cast.deviceId
    const item = document.createElement('div')
    item.className =
      'import-playlist-item cast-device-item' + (active ? ' active' : '')
    item.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
        <path d="M17 2H7c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-5 2c1.1 0 2 .9 2 2s-.9 2-2 2-2-.9-2-2 .9-2 2-2zm0 15c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>
      </svg>
      <div class="cast-dev-meta">
        <div class="cast-dev-name">${escapeHtml(dev.name)}${active ? '（已连接）' : ''}</div>
        <div class="cast-dev-sub">${escapeHtml([dev.model, dev.presence].filter(Boolean).join(' · '))}</div>
      </div>`
    item.onclick = () => {
      if (!active) connectDevice(dev)
    }
    listEl.appendChild(item)
  })
}

// ---------- 连接 / 断开 ----------

async function connectDevice(dev) {
  store.cast = {
    connected: true,
    accountId: dev.accountId,
    deviceId: dev.deviceId,
    deviceName: dev.name,
  }
  persistCastState()
  updateCastButton()
  closeCastPanel()
  startPolling()
  initVolumeUI()
  showSnackbar(`已连接「${dev.name}」，播放将转由音箱发声`)
  // 本地正在播：立即转移到音箱（MiNA 无 seek，音箱从当前曲开头播）
  const audio = getAudio()
  if (audio.src && !audio.paused) {
    const song = store.queue[store.currentIndex]
    if (song) {
      await castPlaySong(song)
      return
    }
  }
  audio.pause()
}

// 断开连接：取音箱最后进度 → 停音箱 → 本地从该进度无缝续播
export async function disconnectCast() {
  if (!store.cast.connected) return
  const song = store.queue[store.currentIndex]
  const st = await fetchStatusOnce() // 必须在 stop 之前取：stop 会把设备位置清零
  const pos = st && Number(st.position) > 0 ? Number(st.position) : 0
  const wasActive =
    cast.playing || (st && (st.state === 'playing' || st.state === 'paused'))
  stopPolling()
  await miotPost('stop', {
    account_id: store.cast.accountId,
    device_id: store.cast.deviceId,
  })
  cast.playing = false
  cast.awaitingPlay = false
  store.cast.connected = false
  persistCastState()
  updateCastButton()
  if (wasActive && song) {
    // 复用本地续播机制：startAudio 在元数据就绪后 seek 到 pos
    showSnackbar('已断开音箱，本地续播中…')
    startAudio(song, 0, pos)
  } else {
    showSnackbar('已断开音箱')
  }
}

// ---------- 播放指令（player.js 经 store.castHooks 调用） ----------

// 投放播歌：本地静音 → 生成音箱可达直链 → miot play-url → 轮询接管进度/歌词
async function castPlaySong(song) {
  // 本地立刻静音并停止取流，避免连接/切歌瞬间双声
  const audio = getAudio()
  if (audio.src) {
    audio.pause()
    audio.removeAttribute('src')
    try {
      audio.load()
    } catch {
      /* ignore */
    }
  }
  updateNowPlaying(song, song.cover || '')
  setPlayIcon(true) // 乐观显示，随后由轮询按实际状态校正
  let url = null
  try {
    const j = await API.castStreamUrl(song)
    url = j && j.url
  } catch (e) {
    showSnackbar('生成音箱播放地址失败：' + ((e && e.message) || e))
    setPlayIcon(false)
    return
  }
  if (!url) {
    showSnackbar(
      '无法生成音箱可访问的地址：请在「插件设置 → 对外可达地址」填写局域网地址',
    )
    setPlayIcon(false)
    return
  }
  const ok = await miotPost('play-url', {
    account_id: store.cast.accountId,
    device_id: store.cast.deviceId,
    url,
  })
  if (!ok) {
    showSnackbar('投放到音箱失败，请检查音箱是否在线')
    setPlayIcon(false)
    return
  }
  cast.playing = true
  cast.awaitingPlay = true
  cast.issuedAt = Date.now()
  startPolling()
}

async function castToggle() {
  if (cast.playing) {
    const ok = await miotPost('pause', {
      account_id: store.cast.accountId,
      device_id: store.cast.deviceId,
    })
    if (ok) {
      cast.playing = false
      setPlayIcon(false)
    }
    return
  }
  // 先看设备态：paused → resume 续播；stopped/unknown → 重新下发当前曲（从开头播）
  const st = await fetchStatusOnce()
  if (st && st.state === 'paused') {
    const ok = await miotPost('resume', {
      account_id: store.cast.accountId,
      device_id: store.cast.deviceId,
    })
    if (ok) {
      cast.playing = true
      setPlayIcon(true)
    }
    return
  }
  const song = store.queue[store.currentIndex]
  if (song) await castPlaySong(song)
}

// stopPlay 分支：停音箱 + 复位 UI（连接保持；本地持久化状态一并清除，与本地停播一致）
async function castStopAll() {
  stopPolling()
  cast.playing = false
  cast.awaitingPlay = false
  setPlayIcon(false)
  clearPlaybackState()
  resetNowPlayingUI()
  miotPost('stop', {
    account_id: store.cast.accountId,
    device_id: store.cast.deviceId,
  }) // 尽力而为，不阻塞 UI
}

// 音量/静音映射到音箱全局音量（投放模式下本地 <audio> 不出声，无可 mute）
async function castToggleMute() {
  let vol = cast.lastVolume
  if (vol == null) {
    const st = await fetchStatusOnce()
    vol = st && st.volume != null ? Number(st.volume) : 50
  }
  if (!cast.muted) {
    if (vol > 0) cast.lastVolume = vol
    const ok = await miotPost('volume', {
      account_id: store.cast.accountId,
      device_id: store.cast.deviceId,
      volume: 0,
    })
    if (ok) {
      cast.muted = true
      setVolumeIcon(false)
      setVolumeUI(0)
    }
  } else {
    const v = cast.lastVolume && cast.lastVolume > 0 ? cast.lastVolume : 50
    const ok = await miotPost('volume', {
      account_id: store.cast.accountId,
      device_id: store.cast.deviceId,
      volume: v,
    })
    if (ok) {
      cast.muted = false
      setVolumeIcon(true)
      setVolumeUI(v)
    }
  }
}

function setVolumeIcon(up) {
  const icon = document.getElementById('fpVolumeIcon')
  if (icon) icon.textContent = up ? 'volume_up' : 'volume_off'
}

// ---------- 面板内音量滑杆 ----------
// 音箱音量是设备全局值（0-100 整数），走 miot /mina/volume 云端 API：
// 拖动中不能每个刻度都打一次云端，采用「600ms 节流 + 松手(change)立即按最终值下发」。

let volSendTimer = null
let volLastSent = 0
let volumeInteractedAt = 0 // 用户最近一次操作滑杆的时间；4s 内轮询不回写，避免拖动被云端回值打断

function setVolumeUI(v) {
  const slider = document.getElementById('castVolumeSlider')
  const label = document.getElementById('castVolumeValue')
  if (!slider || !label) return
  slider.value = v
  label.textContent = v + '%'
}

function updateVolumeRowVisibility() {
  const row = document.getElementById('castVolumeRow')
  if (row) row.style.display = store.cast.connected ? 'flex' : 'none'
}

// 打开面板/刚连接时初始化滑杆：优先用轮询已知的音量，否则查一次状态
async function initVolumeUI() {
  updateVolumeRowVisibility()
  if (!store.cast.connected) return
  if (cast.lastVolume != null) {
    setVolumeUI(cast.lastVolume)
    return
  }
  const st = await fetchStatusOnce()
  if (st && st.volume != null) {
    cast.lastVolume = Number(st.volume)
    setVolumeUI(cast.lastVolume)
  }
}

function doSendVolume(v) {
  const val = Math.max(0, Math.min(100, Math.round(v)))
  miotPost('volume', {
    account_id: store.cast.accountId,
    device_id: store.cast.deviceId,
    volume: val,
  }).then((ok) => {
    if (ok) {
      cast.lastVolume = val
      cast.muted = val === 0
      setVolumeIcon(val > 0)
    } else {
      showSnackbar('音量设置失败，请检查音箱是否在线')
    }
  })
}

function onVolumeInput() {
  const slider = document.getElementById('castVolumeSlider')
  if (!slider) return
  const v = Number(slider.value)
  volumeInteractedAt = Date.now()
  cast.lastVolume = v
  setVolumeUI(v) // 刻度实时上屏
  const wait = Math.max(0, 600 - (Date.now() - volLastSent))
  clearTimeout(volSendTimer)
  volSendTimer = setTimeout(() => {
    volLastSent = Date.now()
    doSendVolume(Number(slider.value))
  }, wait)
}

function onVolumeChange() {
  const slider = document.getElementById('castVolumeSlider')
  if (!slider) return
  volumeInteractedAt = Date.now()
  clearTimeout(volSendTimer)
  volLastSent = Date.now()
  doSendVolume(Number(slider.value))
}

// ---------- 状态轮询：进度条/歌词/播完自动切歌 ----------

function startPolling() {
  if (pollTimer) return
  pollTimer = setInterval(pollOnce, POLL_MS)
  pollOnce()
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  pollInFlight = false
}

async function pollOnce() {
  if (pollInFlight || !store.cast.connected) return
  pollInFlight = true
  try {
    const st = await fetchStatusOnce()
    if (!st || !store.cast.connected) return
    if (st.volume != null) {
      const v = Number(st.volume)
      if (v > 0) {
        cast.lastVolume = v
        if (cast.muted) cast.muted = false // 音箱端音量被外部调高则解除静音标记
      }
      setVolumeIcon(v > 0)
      // 滑杆同步：用户 4s 内操作过则不覆盖（避免拖动中被云端回值打断，4s 与 miot 音量锁定期对齐）
      if (Date.now() - volumeInteractedAt > 4000) setVolumeUI(v)
    }
    // play-url 下发后的确认/失败判定
    if (cast.awaitingPlay) {
      if (st.state === 'playing') {
        cast.awaitingPlay = false
      } else if (
        st.state === 'stopped' &&
        Date.now() - cast.issuedAt > PLAY_CONFIRM_MS
      ) {
        cast.awaitingPlay = false
        cast.playing = false
        setPlayIcon(false)
        showSnackbar('音箱未能播放该歌曲（音源可能已失效），可换一首试试')
      }
    }
    // 播完自动切下一首：期望播放中但设备报 stopped（已排除启动失败窗口）
    if (cast.playing && !cast.awaitingPlay && st.state === 'stopped') {
      cast.playing = false
      nextSong()
      return
    }
    renderCastProgress(st)
    if (!cast.awaitingPlay) setPlayIcon(st.is_playing === true)
  } finally {
    pollInFlight = false
  }
}

// 用音箱状态驱动进度条/时间/歌词（音频元素未参与，等价于本地 syncProgress）
function renderCastProgress(st) {
  const song = store.queue[store.currentIndex]
  const pos = Number(st.position) || 0
  store.castPosition = pos
  const dur = Number(song && song.duration) || 0
  const pct = dur > 0 ? Math.min((pos / dur) * 100, 100) : 0
  setBar('pbFill', 'pbThumb', pct)
  setBar('fpProgressFill', 'fpProgressThumb', pct)
  const cs = fmtTime(pos)
  const ts = fmtTime(dur)
  const setText = (id, v) => {
    const el = document.getElementById(id)
    if (el) el.textContent = v
  }
  setText('pbCurrent', cs)
  setText('pbTotal', ts)
  setText('fpCurrentTime', cs)
  setText('fpTotalTime', ts)
  // 歌词高亮与迷你条歌词行（与本地播放共用同一套逻辑）
  if (store.fpLyrics.length) highlightLyric(pos)
}

// ---------- 面板与入口 ----------

let panelOutsideBound = false

export function openCastPanel() {
  const panel = document.getElementById('castPanel')
  if (!panel) return
  panel.classList.add('show')
  loadCastDevices()
  updateCastButton()
  initVolumeUI()
  if (!panelOutsideBound) {
    panelOutsideBound = true
    setTimeout(() => {
      document.addEventListener('click', onCastPanelOutside, true)
      document.addEventListener('keydown', onCastPanelEsc, true)
    }, 0)
  }
}

function onCastPanelOutside(e) {
  const panel = document.getElementById('castPanel')
  if (panel && panel.classList.contains('show') && !panel.contains(e.target)) {
    closeCastPanel()
  }
}

function onCastPanelEsc(e) {
  if (e.key === 'Escape') closeCastPanel()
}

export function closeCastPanel() {
  const panel = document.getElementById('castPanel')
  if (panel) panel.classList.remove('show')
  document.removeEventListener('click', onCastPanelOutside, true)
  document.removeEventListener('keydown', onCastPanelEsc, true)
  panelOutsideBound = false
}

function updateCastButton() {
  const btn = document.getElementById('castBtn')
  if (btn) btn.classList.toggle('cast-active', !!store.cast.connected)
  const discBtn = document.getElementById('castDisconnectBtn')
  if (discBtn)
    discBtn.style.display = store.cast.connected ? 'inline-block' : 'none'
  updateVolumeRowVisibility()
}

// 初始化：恢复连接选择、注册播放传输钩子、绑定面板事件
export function initCast() {
  const saved = readStoredJson(CAST_KEY)
  if (saved && saved.deviceId) {
    store.cast = {
      connected: !!saved.connected,
      accountId: saved.accountId || '',
      deviceId: saved.deviceId,
      deviceName: saved.deviceName || '',
    }
  }
  store.castHooks = {
    play: (song) => castPlaySong(song),
    toggle: castToggle,
    stop: castStopAll,
    toggleMute: castToggleMute,
  }
  const castBtn = document.getElementById('castBtn')
  if (castBtn) castBtn.onclick = openCastPanel
  const discBtn = document.getElementById('castDisconnectBtn')
  if (discBtn)
    discBtn.onclick = () => {
      closeCastPanel()
      disconnectCast()
    }
  const closeBtn = document.getElementById('castCloseBtn')
  if (closeBtn) closeBtn.onclick = closeCastPanel
  const volSlider = document.getElementById('castVolumeSlider')
  if (volSlider) {
    volSlider.addEventListener('input', onVolumeInput)
    volSlider.addEventListener('change', onVolumeChange)
  }
  updateCastButton()
  if (store.cast.connected) startPolling()
}
