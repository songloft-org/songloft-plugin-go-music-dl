// Go Music DL 插件前端
// 与 go-music-dl 的 GetAllSourceNames / GetSourceDescription 保持一致。
// 排除 "local"（本地音乐，非可在线搜索的音源平台）。
const SOURCE_LABELS = {
  netease: '网易云音乐',
  qq: 'QQ音乐',
  kugou: '酷狗音乐',
  kuwo: '酷我音乐',
  migu: '咪咕音乐',
  fivesing: '5sing',
  jamendo: 'Jamendo',
  joox: 'JOOX',
  qianqian: '千千音乐',
  soda: '汽水音乐',
  bilibili: 'Bilibili',
  apple: 'Apple Music',
}
const ALL_SOURCES = Object.keys(SOURCE_LABELS)

function sourceLabel(s) {
  return SOURCE_LABELS[s] || s
}

let config = {
  baseUrl: 'http://127.0.0.1:58091',
  sources: [...ALL_SOURCES],
}

// go-music-dl 接口都在 /music 前缀下，根地址自动补上，避免拼出 /search 之类 404
function normalizeBaseUrl(raw) {
  let u = (raw || '').trim().replace(/\/+$/, '')
  if (!u) return ''
  if (!/\/music$/.test(u)) u += '/music'
  return u
}

// 宿主会把 access_token 注入 localStorage['songloft-auth']，插件 API 需要带 Bearer 头
function getAuthHeaders() {
  const headers = { 'Content-Type': 'application/json' }
  try {
    const raw = localStorage.getItem('songloft-auth')
    if (raw) {
      const auth = JSON.parse(raw)
      if (auth && auth.accessToken) {
        headers['Authorization'] = 'Bearer ' + auth.accessToken
      }
    }
  } catch (e) {}
  return headers
}

async function fetchAuth(url, opts = {}) {
  const res = await fetch(url, {
    headers: getAuthHeaders(),
    ...opts,
  })
  if (res.status === 401) {
    throw new Error('401 未授权：请刷新插件页面后重试')
  }
  if (!res.ok) {
    // 后端会把真实错误放在 { error: "..." } 里，优先展示它
    let msg = `HTTP ${res.status}`
    try {
      const j = await res.json()
      if (j && j.error) msg = j.error
    } catch (e) {}
    throw new Error(msg)
  }
  return res.json()
}

const API = {
  config: () => fetchAuth('./config'),
  saveConfig: (cfg) =>
    fetchAuth('./config', { method: 'POST', body: JSON.stringify(cfg) }),
  search: (q, type) =>
    fetchAuth(
      `./search?q=${encodeURIComponent(q)}${
        type ? `&type=${encodeURIComponent(type)}` : ''
      }`,
    ),
  import: (item) =>
    fetchAuth('./import', {
      method: 'POST',
      body: JSON.stringify({ item }),
    }),
}

// 宿主歌单 API：经插件后端代理（/playlists...）调用，避免 common.js 的
// API_BASE='.' 把 /api/v1 拼成相对路径导致 404。插件后端用宿主绝对地址转发。
const Host = {
  playlists: {
    // 带 _t 防缓存：每次打开面板都拉最新歌单，避免浏览器缓存了创建前的旧列表
    list: () => window.SongloftPlugin.apiGet('/playlists?_t=' + Date.now()),
    create: (playlist) => window.SongloftPlugin.apiPost('/playlists', playlist),
    addSongs: (id, songIds) =>
      window.SongloftPlugin.apiPost(`/playlists/${id}/songs`, {
        song_ids: songIds,
      }),
  },
}

// 搜索类型：单曲 / 歌单 / 专辑（整合在搜索框的分段切换里）
let currentSearchType = 'song'

let snackbarTimer = null
// showSnackbar(msg, sticky, type)
//  - sticky=true：不自动消失，用于「导入中/换源中」等进行态，并在文字前显示旋转指示
//  - type：'success' | 'error' | 'warning'，用于配色（不传则默认中性色）
function showSnackbar(msg, sticky, type) {
  const el = document.getElementById('snackbar')
  if (!el) return
  // 未显式指定 type 且非进行态时，按消息语义自动推断配色
  if (!type && !sticky) {
    if (/失败|错误|无法|出错|失效/.test(msg)) type = 'error'
    else if (/已导入|已保存|已在|已添加|成功/.test(msg)) type = 'success'
  }
  const cls = ['snackbar', 'show']
  if (type) cls.push(type)
  el.className = cls.join(' ')
  if (sticky) {
    // 进行态：spinner + 文本（文本用 textContent 防注入）
    el.innerHTML = '<span class="snackbar-spinner" aria-hidden="true"></span><span class="snackbar-text"></span>'
    el.querySelector('.snackbar-text').textContent = msg
  } else {
    el.textContent = msg
  }
  if (snackbarTimer) clearTimeout(snackbarTimer)
  if (!sticky) {
    snackbarTimer = setTimeout(() => {
      el.className = 'snackbar'
    }, 2500)
  }
}
function hideSnackbar() {
  if (snackbarTimer) clearTimeout(snackbarTimer)
  const el = document.getElementById('snackbar')
  if (el) el.className = 'snackbar'
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  )
}

function fmtTime(sec) {
  if (!sec || sec < 0 || isNaN(sec)) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return m + ':' + (s < 10 ? '0' : '') + s
}

// 封面加载失败兜底（第三方 CDN 防盗链/证书问题），用内联 SVG 避免再次网络请求
const FALLBACK_COVER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48">' +
      '<rect width="48" height="48" rx="8" fill="#3a3a3a"/>' +
      '<text x="24" y="32" font-size="26" text-anchor="middle" fill="#9a9a9a">♪</text>' +
      '</svg>',
  )

// 未播放 / 无封面时，迷你播放条封面显示插件图标
const PLUGIN_ICON = 'static/icon.svg'

// ---------- 播放队列 + 音频 ----------
let queue = []
let currentIndex = -1
let fpLyrics = []
let lastLyricIndex = -1
let audioRetry = 0
const MAX_AUDIO_RETRY = 3
// 播放失败自动换源：原样重试耗尽后，最多再自动换 N 个音源再播
let audioSwitchRetry = 0
const MAX_AUDIO_SWITCH = 3
let audioSwitching = false
// 检测阶段失效歌曲多轮换源上限（每轮换到仍失效就换下一个源）
const MAX_SWITCH_ROUNDS = 4
let isFpOpen = false

function getAudio() {
  return document.getElementById('audio')
}

// 构建试听直链（浏览器内直接播放，走 go-music-dl /music/download?stream=1）
function buildStreamUrl(s) {
  const base = normalizeBaseUrl(config.baseUrl)
  const p = new URLSearchParams({
    id: s.id,
    source: s.source,
    stream: '1',
    name: s.name || '',
    artist: s.artist || '',
    album: s.album || '',
    extra: JSON.stringify(s.extra || {}),
  })
  return `${base}/download?${p.toString()}`
}

function setPlayIcon(playing) {
  const icons = [
    document.querySelector('#pbPlayBtn .material-symbols-outlined'),
    document.querySelector('#fpPlayBtn .material-symbols-outlined'),
  ]
  icons.forEach((ic) => {
    if (ic) ic.textContent = playing ? 'pause' : 'play_arrow'
  })
}

function setBar(fillId, thumbId, pct) {
  const f = document.getElementById(fillId)
  const t = document.getElementById(thumbId)
  if (f) f.style.width = pct + '%'
  if (t) t.style.left = pct + '%'
}

function syncProgress() {
  const audio = getAudio()
  const p = audio.currentTime || 0
  const d = audio.duration || 0
  const pct = d > 0 ? Math.min((p / d) * 100, 100) : 0
  setBar('pbFill', 'pbThumb', pct)
  setBar('fpProgressFill', 'fpProgressThumb', pct)
  const cs = fmtTime(p)
  const ts = fmtTime(d)
  const pbc = document.getElementById('pbCurrent')
  const pbt = document.getElementById('pbTotal')
  const fpc = document.getElementById('fpCurrentTime')
  const fpt = document.getElementById('fpTotalTime')
  if (pbc) pbc.textContent = cs
  if (pbt) pbt.textContent = ts
  if (fpc) fpc.textContent = cs
  if (fpt) fpt.textContent = ts
  if (fpLyrics.length) highlightLyric(p)
}

function updateNowPlaying(song, cover) {
  document.getElementById('pbTitle').textContent = song.name || '未知歌曲'
  document.getElementById('pbArtist').textContent = song.artist || '-'
  document.getElementById('fpSongTitle').textContent = song.name || '未知歌曲'
  document.getElementById('fpSongArtist').textContent = song.artist || '-'

  const pbCover = document.getElementById('pbCover')
  const fpCover = document.getElementById('fpCoverImg')
  const bg = document.getElementById('fpBgImage')
  const placeholder = document.getElementById('fpCoverPlaceholder')
  if (cover) {
    if (pbCover) {
      pbCover.onerror = () => { pbCover.src = FALLBACK_COVER }
      pbCover.src = cover
    }
    if (fpCover) {
      fpCover.onerror = () => { fpCover.removeAttribute('src') }
      fpCover.src = cover
    }
    if (bg) bg.style.backgroundImage = `url("${cover}")`
  } else {
    // 无封面：迷你播放条显示插件图标，全屏播放器仍用占位音符
    if (pbCover) { pbCover.onerror = () => { pbCover.src = FALLBACK_COVER }; pbCover.src = PLUGIN_ICON }
    if (fpCover) { fpCover.removeAttribute('src'); fpCover.onerror = null }
    if (bg) bg.style.backgroundImage = ''
  }
  setPlayIcon(true)
  syncProgress()
  loadLyrics(song)
  highlightCurrentInList()
}

function playSong(song, index) {
  if (!song) return
  currentIndex = index
  audioRetry = 0
  audioSwitchRetry = 0
  startAudio(song)
}

// 真正给 <audio> 赋值并播放。retry 时通过 _r 参数绕开网关对 404/504 的缓存。
function startAudio(song, retry) {
  const audio = getAudio()
  let url = buildStreamUrl(song)
  if (retry) url += (url.includes('?') ? '&' : '?') + '_r=' + retry
  audio.src = url
  audio.load()
  updateNowPlaying(song, song.cover || '')
  document.getElementById('playerBar').style.display = 'flex'
  audio.play().catch(() => {})
}

function togglePlay() {
  const audio = getAudio()
  if (!audio.src) return
  if (audio.paused) audio.play().catch(() => {})
  else audio.pause()
}

function stopPlay() {
  const audio = getAudio()
  audio.pause()
  audio.currentTime = 0
  setPlayIcon(false)
  syncProgress()
  // 停止后无歌曲播放，迷你播放条封面回退到插件图标
  const pbCover = document.getElementById('pbCover')
  if (pbCover) { pbCover.onerror = null; pbCover.src = PLUGIN_ICON }
}

function playQueue(i) {
  const s = queue[i]
  if (s) playSong(s, i)
}

function prevSong() {
  if (currentIndex > 0) playQueue(currentIndex - 1)
}

function nextSong() {
  if (currentIndex < queue.length - 1) playQueue(currentIndex + 1)
  else stopPlay()
}

function highlightCurrentInList() {
  document.querySelectorAll('#browserList .song-row, #mySongsList .song-row').forEach((el, i) => {
    el.style.background = i === currentIndex ? 'rgba(99,102,241,.10)' : ''
  })
}

// ---------- 歌词 ----------
function parseLrc(text) {
  if (!text) return []
  const out = []
  const timeRe = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
  for (const line of text.split(/\r?\n/)) {
    timeRe.lastIndex = 0
    const times = []
    let m
    while ((m = timeRe.exec(line))) {
      const min = parseInt(m[1], 10)
      const sec = parseInt(m[2], 10)
      const frac = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) : 0
      times.push(min * 60 + sec + frac / 1000)
    }
    if (!times.length) continue
    const txt = line.replace(timeRe, '').trim()
    for (const t of times) out.push({ time: t, text: txt })
  }
  out.sort((a, b) => a.time - b.time)
  return out
}

function renderLyrics(lines) {
  const c = document.getElementById('fpLyricsContainer')
  if (!c) return
  lastLyricIndex = -1
  if (!lines || !lines.length) {
    c.innerHTML = '<div class="fp-lyrics-empty">暂无歌词</div>'
    return
  }
  c.innerHTML = ''
  lines.forEach((l) => {
    const d = document.createElement('div')
    d.className = 'fp-lyric-line'
    d.textContent = l.text || '...'
    c.appendChild(d)
  })
}

function highlightLyric(t) {
  if (!fpLyrics.length) return
  let idx = -1
  for (let i = 0; i < fpLyrics.length; i++) {
    if (fpLyrics[i].time <= t) idx = i
    else break
  }
  if (idx === lastLyricIndex) return
  lastLyricIndex = idx
  const els = document.querySelectorAll('#fpLyricsContainer .fp-lyric-line')
  els.forEach((el) => el.classList.remove('active'))
  if (idx >= 0 && els[idx]) {
    els[idx].classList.add('active')
    els[idx].scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
}

function loadLyrics(song) {
  fpLyrics = []
  lastLyricIndex = -1
  renderLyrics([])
  const p = new URLSearchParams({
    id: song.id,
    source: song.source,
    name: song.name || '',
    artist: song.artist || '',
    album: song.album || '',
    duration: song.duration || 0,
    extra: JSON.stringify(song.extra || {}),
  })
  fetchAuth('./api/lyric?' + p.toString())
    .then((j) => {
      fpLyrics = parseLrc(j && j.lyric ? j.lyric : '')
      renderLyrics(fpLyrics)
    })
    .catch(() => {})
}

// ---------- 全屏 ----------
function openFullscreenPlayer() {
  const el = document.getElementById('fullscreenPlayer')
  if (!el || isFpOpen) return
  isFpOpen = true
  el.classList.add('open')
  document.body.style.overflow = 'hidden'
  syncProgress()
}

function closeFullscreenPlayer() {
  const el = document.getElementById('fullscreenPlayer')
  if (!el || !isFpOpen) return
  isFpOpen = false
  el.classList.remove('open')
  document.body.style.overflow = ''
}

function toggleLyricPage() {
  const pages = document.getElementById('fpPages')
  if (!pages) return
  const showLyrics = pages.scrollLeft < pages.clientWidth / 2
  pages.scrollTo({ left: showLyrics ? pages.clientWidth : 0, behavior: 'smooth' })
  const dots = document.querySelectorAll('#fpPageIndicator .fp-dot')
  dots.forEach((d, i) => d.classList.toggle('active', i === (showLyrics ? 1 : 0)))
}

function bindSeek(trackId) {
  const track = document.getElementById(trackId)
  if (!track) return
  track.addEventListener('click', (e) => {
    const audio = getAudio()
    if (!audio.duration) return
    const rect = track.getBoundingClientRect()
    const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1)
    audio.currentTime = ratio * audio.duration
  })
}

// ---------- 配置 / 搜索 ----------
async function loadConfig() {
  try {
    config = await API.config()
  } catch {
    /* 使用默认值 */
  }
  document.getElementById('configBaseUrl').value = config.baseUrl || ''
  const box = document.getElementById('configSources')
  box.innerHTML = ''
  for (const s of ALL_SOURCES) {
    const label = document.createElement('label')
    label.className = 'md-checkbox'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.value = s
    cb.checked = (config.sources || []).includes(s)
    label.appendChild(cb)
    label.appendChild(document.createTextNode(' ' + (SOURCE_LABELS[s] || s)))
    box.appendChild(label)
  }
}

// 全选 / 清空 搜索音源勾选
function setAllSources(checked) {
  document
    .querySelectorAll('#configSources input[type=checkbox]')
    .forEach((cb) => { cb.checked = checked })
}

async function saveConfig() {
  const baseUrl = document.getElementById('configBaseUrl').value.trim()
  const sources = Array.from(
    document.querySelectorAll('#configSources input:checked'),
  ).map((cb) => cb.value)
  config = { ...config, baseUrl, sources }
  recommendLoaded = false // 配置变更后，下次进入首页重新拉取推荐
  try {
    await API.saveConfig(config)
    showSnackbar('配置已保存')
    testConnection()
  } catch (e) {
    showSnackbar(friendlyError(e, '保存失败'))
  }
}

// go-music-dl 是跨域 HTTP 服务；WebView 默认可能附带凭据发起跨域请求，
// 而服务端同时返回 `Access-Control-Allow-Origin: *` 与 `Allow-Credentials: true`，
// 浏览器对「凭据请求 + *」组合会直接拒绝 CORS。显式 credentials:'omit' 让请求变为
// 非凭据，使 * 生效，规避「due to access control checks」报错。
function gmdFetch(url, opts = {}) {
  return fetch(url, { credentials: 'omit', ...opts })
}

// 判断 fetch 失败是否为网络层错误（地址错误/服务未启动/CORS 等），便于给出友好提示
function isNetworkError(e) {
  return !!e && (e.name === 'TypeError' || /failed to fetch|network request failed/i.test(e.message || ''))
}

// 失败原因分类：网络 / 鉴权 / 音源失效 / 未知
const ERR_NETWORK = 'network'
const ERR_AUTH = 'auth'
const ERR_SOURCE = 'source'
const ERR_UNKNOWN = 'unknown'

// 把异常归为四类之一，并返回原始 detail（后端真实错误信息），供上层拼装友好文案
function classifyError(e) {
  const msg = e && e.message ? String(e.message) : ''
  const name = (e && e.name) || ''
  // 1) 鉴权失效：401 未授权 / 登录态过期 / cookie 失效
  if (/401|未授权|未登录|登录失效|鉴权|token|cookie/i.test(msg) || name === 'AuthError') {
    return { category: ERR_AUTH, detail: msg }
  }
  // 2) 音源失效：后端明确告知音源不可用 / 已下架
  if (/音源已失效|资源已失效|链接失效|已下架|无可用音源|版权/i.test(msg)) {
    return { category: ERR_SOURCE, detail: msg }
  }
  // 3) 网络层：fetch 抛 TypeError（CORS/地址错/服务未启）、超时/Abort
  if (isNetworkError(e) || name === 'AbortError' || /timeout|超时|aborted/i.test(msg)) {
    return { category: ERR_NETWORK, detail: msg }
  }
  return { category: ERR_UNKNOWN, detail: msg }
}

// 把错误转成「带分类 + 修复建议」的友好文案，统一失败提示口径
function friendlyError(e, fallback) {
  const { category, detail } = classifyError(e)
  const tail = detail ? `（${detail}）` : ''
  switch (category) {
    case ERR_NETWORK:
      return `网络异常，无法连接服务${tail}请检查服务地址是否正确、go-music-dl 是否已启动`
    case ERR_AUTH:
      return `鉴权失效${tail}请刷新插件页面后重试`
    case ERR_SOURCE:
      return `音源失效，该音源已不可用${tail}已自动尝试换源`
    default:
      return (fallback || '操作失败') + tail
  }
}

// 轻量探测服务是否可达：GET 带结尾斜杠的 /music/ 地址，避免裸 /music 触发 301
// 重定向（重定向响应无 CORS 头会被浏览器拦截）；带 4s 超时。
async function probeService(base) {
  const norm = normalizeBaseUrl(base)
  if (!norm) return { ok: false }
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 4000)
    const res = await gmdFetch(norm + '/', {
      method: 'GET',
      signal: ctrl.signal,
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
    clearTimeout(timer)
    return { ok: true, status: res.status }
  } catch (e) {
    return { ok: false }
  }
}

function setConnStatus(text, kind) {
  const el = document.getElementById('connStatus')
  if (!el) return
  el.textContent = text
  el.className = 'conn-status ' + (kind || '')
}

// 设置页「测试连接」：探测服务可达性并显示状态
async function testConnection() {
  const base = (config.baseUrl || '').trim()
  if (!base) {
    setConnStatus('请先填写服务地址', 'err')
    return
  }
  setConnStatus('正在连接…', 'pending')
  const r = await probeService(base)
  if (r.ok) setConnStatus('连接成功 ✓', 'ok')
  else setConnStatus('无法连接，请检查地址或服务是否启动', 'err')
}

async function doSearch() {
  const q = document.getElementById('searchInput').value.trim()
  if (!q) return
  const list = document.getElementById('browserList')
  list.innerHTML = '<div class="empty-state">搜索中...</div>'
  document.getElementById('recommendCard').style.display = 'none'
  document.getElementById('listCard').style.display = 'block'
  try {
    const data = await API.search(q, currentSearchType)
    if (!Array.isArray(data) || data.length === 0) {
      list.innerHTML = '<div class="empty-state">未找到结果</div>'
      return
    }
    if (currentSearchType === 'song') {
      queue = data
      list.innerHTML = ''
      data.forEach((s, i) => list.appendChild(renderSong(s, i)))
      scheduleInspect(list)
    } else {
      // 歌单 / 专辑：渲染卡片网格
      const grid = document.createElement('div')
      grid.className = 'playlist-grid'
      grid.style.paddingTop = '4px'
      data.forEach((pl) => grid.appendChild(renderPlaylistRow(pl)))
      list.innerHTML = ''
      list.appendChild(grid)
    }
  } catch (e) {
    list.innerHTML = `<div class="empty-state">搜索失败：${escapeHtml(friendlyError(e, '搜索失败'))}</div>`
  }
}

// 首页：加载 go-music-dl 的每日推荐歌单（/recommend，与我的歌单同结构，parsePlaylists 可直接复用）
let recommendLoaded = false
let recommendPlaylists = []
let recommendCat = 'all'

async function loadRecommend() {
  const base = normalizeBaseUrl(config.baseUrl)
  const listEl = document.getElementById('recommendList')
  const catsEl = document.getElementById('recommendCats')
  if (!base) {
    if (catsEl) catsEl.innerHTML = ''
    listEl.innerHTML = '<div class="empty-state">请先在「插件设置」中填写 go-music-dl 服务地址</div>'
    return
  }
  listEl.innerHTML = '<div class="empty-state">加载中…</div>'
  if (catsEl) catsEl.innerHTML = ''
  try {
    const sources = (config.sources && config.sources.length) ? config.sources : ALL_SOURCES
    const url = `${base}/recommend?sources=${sources.map(encodeURIComponent).join('&sources=')}`
    const res = await gmdFetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
    if (!res.ok) {
      listEl.innerHTML = `<div class="empty-state">加载失败: HTTP ${res.status}</div>`
      return
    }
    const html = await res.text()
    const playlists = parsePlaylists(html)
    if (!playlists.length) {
      listEl.innerHTML = '<div class="empty-state">暂无推荐歌单（部分平台需先在网页端登录）。</div>'
      return
    }
    recommendPlaylists = playlists
    recommendCat = 'all'
    buildRecommendCats()
    renderRecommendByCat()
    recommendLoaded = true
  } catch (e) {
    if (isNetworkError(e)) {
      listEl.innerHTML = '<div class="empty-state">无法连接到服务地址，请检查 go-music-dl 服务是否启动、地址是否正确，或在「插件设置」中点击「测试连接」。</div>'
    } else {
      listEl.innerHTML = `<div class="empty-state">推荐加载失败：${escapeHtml(friendlyError(e, '加载失败'))}</div>`
    }
  }
}

// 按实际出现的音源构建「全部 + 各平台」筛选条
function buildRecommendCats() {
  const bar = document.getElementById('recommendCats')
  if (!bar) return
  const present = []
  const seen = new Set()
  for (const s of ALL_SOURCES) {
    if (recommendPlaylists.some((p) => p.source === s) && !seen.has(s)) {
      present.push(s)
      seen.add(s)
    }
  }
  recommendPlaylists.forEach((p) => {
    if (!seen.has(p.source)) {
      present.push(p.source)
      seen.add(p.source)
    }
  })
  const cats = [{ key: 'all', label: '全部' }]
  present.forEach((s) => cats.push({ key: s, label: sourceLabel(s) || s }))
  bar.innerHTML = ''
  cats.forEach((c) => {
    const chip = document.createElement('button')
    chip.className = 'mylist-cat' + (c.key === recommendCat ? ' active' : '')
    chip.textContent = c.label
    chip.onclick = () => {
      recommendCat = c.key
      buildRecommendCats()
      renderRecommendByCat()
    }
    bar.appendChild(chip)
  })
}

// 按当前选中平台过滤并渲染推荐歌单
function renderRecommendByCat() {
  const listEl = document.getElementById('recommendList')
  if (!listEl) return
  const list =
    recommendCat === 'all'
      ? recommendPlaylists
      : recommendPlaylists.filter((p) => p.source === recommendCat)
  if (!list.length) {
    listEl.innerHTML = '<div class="empty-state">该平台暂无推荐歌单</div>'
    return
  }
  listEl.innerHTML = ''
  list.forEach((pl) => listEl.appendChild(renderPlaylistRow(pl)))
}

// 切换到搜索首页：未搜索时显示推荐歌单，已搜索则保留结果列表
function showBrowserHome() {
  const recommendCard = document.getElementById('recommendCard')
  const listCard = document.getElementById('listCard')
  if (listCard.style.display === 'block') return // 已有搜索结果，保持不变
  listCard.style.display = 'none'
  recommendCard.style.display = 'block'
  if (!recommendLoaded) loadRecommend()
}

// 搜索结果页「返回首页」：收起结果列表、清空关键词，回到每日推荐视图（无需刷新整页）
function backToBrowserHome() {
  if (selectMode) setSelectMode(false) // 退出多选，避免批量操作栏残留
  const input = document.getElementById('searchInput')
  if (input) input.value = ''
  document.getElementById('listCard').style.display = 'none'
  document.getElementById('recommendCard').style.display = 'block'
  if (!recommendLoaded) loadRecommend()
}

// 卡片与歌曲数据的绑定（避免挂在 DOM 上导致类型/序列化问题）
const cardData = new WeakMap()

function songKey(s) {
  return `${(s.name || '').toLowerCase()}:::${(s.artist || '').toLowerCase()}`
}

function setSongStatus(card, kind, text) {
  const el = card.querySelector('.song-status')
  if (!el) return
  el.className = 'song-status status-' + kind
  el.textContent = text
}

function setCardEnabled(card, enabled) {
  card.querySelectorAll('.song-actions button').forEach((b) => {
    b.disabled = !enabled
  })
  card.classList.toggle('song-dead', !enabled)
}

// 直接调 go-music-dl 的 /inspect（CORS 已开放 *）：true=可播, false=失效, null=网络/请求错误
async function inspectSong(song) {
  const base = normalizeBaseUrl(config.baseUrl)
  if (!base) return null
  const p = new URLSearchParams({
    id: song.id,
    source: song.source,
    duration: song.duration || 0,
    extra: JSON.stringify(song.extra || {}),
  })
  try {
    const res = await gmdFetch(`${base}/inspect?${p.toString()}`, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
    if (!res.ok) return false
    const j = await res.json()
    return !!(j && j.valid === true)
  } catch {
    return null
  }
}

// 调 /switch_source 找可播替代音源。
// opts.current: 需排除的当前源（多轮换源时传上一次换到的源，服务端据此找下一个源）
// opts.target: 指定目标音源
// 返回：成功->新歌对象, 无可用->false, 网络错误->null
async function switchSource(song, opts = {}) {
  const base = normalizeBaseUrl(config.baseUrl)
  if (!base) return null
  const p = new URLSearchParams({
    name: song.name || '',
    artist: song.artist || '',
    source: song.source || '',
    current: opts.current || song.source || '',
    duration: song.duration || 0,
  })
  if (opts.target) p.set('target', opts.target)
  try {
    const res = await gmdFetch(`${base}/switch_source?${p.toString()}`, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
    if (res.status === 404) return false
    if (!res.ok) return null
    const j = await res.json()
    if (!j || !j.id) return false
    return {
      id: j.id,
      source: j.source,
      name: j.name,
      artist: j.artist,
      album: j.album,
      cover: j.cover,
      duration: j.duration,
      extra: j.extra || {},
    }
  } catch {
    return null
  }
}

// 把换到的可播版本同步到卡片 DOM 与队列/卡片数据
function applySwitchedSong(card, alt) {
  const d = cardData.get(card)
  if (d) {
    d.song = alt
    if (d.index >= 0) queue[d.index] = alt
  }
  const t = card.querySelector('.song-title')
  if (t) t.textContent = alt.name || ''
  const sub = card.querySelector('.song-sub')
  if (sub)
    sub.innerHTML = `${escapeHtml(alt.artist)} · ${escapeHtml(
      alt.album || '',
    )} · ${escapeHtml(sourceLabel(alt.source))}`
  const coverImg = card.querySelector('.song-cover')
  if (coverImg && alt.cover) coverImg.src = alt.cover
}

// 失效后多轮换源（贴合 go-music-dl 的闭环）：每轮换到候选都重新 inspect 验证，
// 仍失效则把 current 设为刚换到的源、换下一个源，直到成功 / 无更多可播源 / 达上限。
async function switchUntilPlayable(card, song, validByKey) {
  let current = song.source
  let lastAttempted = song
  for (let round = 0; round < MAX_SWITCH_ROUNDS; round++) {
    setSongStatus(
      card,
      'checking',
      round === 0 ? '失效，正在换源…' : `仍失效，再换源 (${round})…`,
    )
    const alt = await switchSource(lastAttempted, { current })
    if (!(alt && typeof alt === 'object')) break // 无更多可播源或网络错误
    const ok = await inspectSong(alt)
    if (ok === true) {
      applySwitchedSong(card, alt)
      validByKey.set(songKey(song), true)
      setSongStatus(card, 'ok', '已换源 · ' + sourceLabel(alt.source))
      setCardEnabled(card, true)
      return
    }
    if (ok === null) {
      // 换源接口本身已校验可播，仅检测端连不上时保守采用，避免误杀
      applySwitchedSong(card, alt)
      validByKey.set(songKey(song), true)
      setSongStatus(
        card,
        'pending',
        '已换源（检测超时）· ' + sourceLabel(alt.source),
      )
      setCardEnabled(card, true)
      return
    }
    // 换到的仍失效，继续换下一个源
    current = alt.source
    lastAttempted = alt
  }
  setSongStatus(card, 'fail', '已失效')
  setCardEnabled(card, false)
}

async function inspectCard(card, validByKey) {
  const d = cardData.get(card)
  if (!d) return
  const song = d.song
  setSongStatus(card, 'checking', '检测中…')
  const valid = await inspectSong(song)
  if (valid === null) {
    setSongStatus(card, 'pending', '检测失败')
    return
  }
  if (valid) {
    validByKey.set(songKey(song), true)
    setSongStatus(card, 'ok', '可播放')
    setCardEnabled(card, true)
    return
  }
  // 失效：本页已有同一首的可播版本则直接标记，不再换源（优先保留可播版本）
  if (validByKey.has(songKey(song))) {
    setSongStatus(card, 'fail', '已失效（本页有可播版本）')
    setCardEnabled(card, false)
    return
  }
  // 失效：多轮换源（每轮换到都重新检测，仍失效则换下一个源，贴合 go-music-dl 闭环）
  await switchUntilPlayable(card, song, validByKey)
}

// 渲染完搜索结果后逐卡错峰检测（80ms/张），避免一次性打爆 go-music-dl 与上游
function scheduleInspect(list) {
  if (!config.baseUrl) return
  const validByKey = new Map()
  Array.from(list.children).forEach((card, i) => {
    setTimeout(() => inspectCard(card, validByKey), i * 80)
  })
}

function renderSong(s, index, opts = {}) {
  const showImport = opts.showImport !== false && !selectMode
  const card = document.createElement('div')
  card.className = 'song-row'
  cardData.set(card, { song: s, index })
  const cover = s.cover || FALLBACK_COVER
  const key = songKey(s)
  const sel = selectMode && selectedSongs.has(key)
  const checkHtml = selectMode
    ? `<div class="song-check" data-act="check"><span class="song-check-box${sel ? ' checked' : ''}">${sel ? '✓' : ''}</span></div>`
    : ''
  const importBtnHtml = showImport
    ? `<button class="song-more-btn" data-act="dl" title="导入" aria-label="导入">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/>
        </svg>
      </button>`
    : ''
  card.innerHTML = `
    ${checkHtml}
    <img src="${cover}" class="song-cover" referrerpolicy="no-referrer" onerror="this.src='${FALLBACK_COVER}'">
    <div class="song-meta">
      <div class="song-title">${escapeHtml(s.name)}</div>
      <div class="song-sub">${escapeHtml(s.artist)} · ${escapeHtml(s.album || '')} · ${escapeHtml(sourceLabel(s.source))}</div>
      <span class="song-status status-pending">待检测</span>
    </div>
    <div class="song-actions">
      ${importBtnHtml}
    </div>`
  if (selectMode) card.classList.toggle('selected', sel)
  const checkEl = card.querySelector('[data-act="check"]')
  if (checkEl)
    checkEl.onclick = (e) => {
      e.stopPropagation()
      e.preventDefault()
      toggleSelect(s, card)
    }
  const dlBtn = card.querySelector('[data-act="dl"]')
  if (dlBtn)
    dlBtn.onclick = (e) => {
      e.stopPropagation()
      e.preventDefault()
      const d = cardData.get(card)
      if (d) openImportPanel(d.song, dlBtn)
    }
  // 点击整行：多选模式下切换勾选；否则直接播放
  card.onclick = () => {
    if (selectMode) {
      toggleSelect(s, card)
      return
    }
    const d = cardData.get(card)
    if (d) playSong(d.song, d.index)
  }
  return card
}

// ---------- 导入到歌单对话框 ----------
// 当前待导入的歌曲（模块级，供对话框各分支复用）
let pendingImportItem = null
let newPlaylistCallback = null
// 歌单列表（模块级缓存，建歌单后本地 push 即时显示，无需等重新拉取）
let importPlaylists = []

// ---------- 多选 / 批量导入 ----------
let selectMode = false
// 已选歌曲：key(source_id) -> song 对象，避免同歌重复勾选
let selectedSongs = new Map()
// 批量导入进行中：打开导入面板后，选歌单/新建歌单都按整批处理
let batchImport = false
let batchList = []

function songKey(s) {
  return `${s.source || ''}__${(s.id != null ? s.id : '')}`
}

function toggleSelect(s, card) {
  const key = songKey(s)
  if (selectedSongs.has(key)) selectedSongs.delete(key)
  else selectedSongs.set(key, s)
  const on = selectedSongs.has(key)
  if (card) {
    card.classList.toggle('selected', on)
    const box = card.querySelector('.song-check-box')
    if (box) {
      box.classList.toggle('checked', on)
      box.textContent = on ? '✓' : ''
    }
  }
  updateBatchBar()
}

function updateBatchBar() {
  const bar = document.getElementById('batchBar')
  if (!bar) return
  const n = selectedSongs.size
  bar.style.display = n > 0 ? 'flex' : 'none'
  const countEl = document.getElementById('batchCount')
  if (countEl) countEl.textContent = `已选 ${n} 首`
}

function setSelectMode(on) {
  selectMode = on
  const btn = document.getElementById('batchToggleBtn')
  if (btn) {
    btn.textContent = on ? '完成' : '多选'
    btn.classList.toggle('active', on)
  }
  if (!on) {
    selectedSongs.clear()
    batchImport = false
    batchList = []
    updateBatchBar()
  }
  // 重新渲染当前搜索结果，切换勾选框显隐（仅单曲结果需要，歌单/专辑不涉及）
  if (currentSearchType === 'song') {
    const list = document.getElementById('browserList')
    if (list && queue.length) {
      list.innerHTML = ''
      queue.forEach((s, i) => list.appendChild(renderSong(s, i)))
      scheduleInspect(list)
    }
  }
}

function exitBatchMode() {
  selectedSongs.clear()
  batchImport = false
  batchList = []
  updateBatchBar()
}

function openImportPanelForBatch() {
  if (!selectedSongs.size) return
  batchImport = true
  batchList = [...selectedSongs.values()]
  const panel = document.getElementById('importPlaylistPanel')
  if (!panel) return
  panel.classList.remove('in')
  panel.classList.add('show')
  loadImportPlaylists()
  panel.style.top = '50%'
  panel.style.left = '50%'
  panel.style.transform = 'translate(-50%, -50%)'
  // 居中弹出：.in 提供淡入（transform 由内联居中控制）
  requestAnimationFrame(() => panel.classList.add('in'))
  setTimeout(() => {
    document.addEventListener('click', onImportPanelOutside, true)
    document.addEventListener('keydown', onImportPanelEsc, true)
  }, 0)
}

// 把一批歌曲依次导入曲库，返回统计；带逐条进度提示
async function batchImportToLibrary() {
  if (!beginImport()) return
  const songs = [...batchList]
  try {
    closeImportPanel()
    let ok = 0
    let already = 0
    let failed = 0
    const failCats = {} // 统计失败类别，用于汇总时给出原因
    for (let i = 0; i < songs.length; i++) {
      showSnackbar(`正在导入到曲库 ${i + 1}/${songs.length}…`, true)
      try {
        const r = await importSongToLibrary(songs[i])
        if (r && r.success) {
          if (r.already_local) already++
          else ok++
        } else failed++
      } catch (e) {
        failed++
        failCats[classifyError(e).category] =
          (failCats[classifyError(e).category] || 0) + 1
      }
    }
    let msg = `已导入 ${ok} 首到曲库`
    if (already) msg += `，${already} 首已在曲库`
    if (failed) msg += `，${failed} 首失败` + batchFailHint(failCats, failed)
    showSnackbar(msg)
    exitBatchMode()
  } finally {
    endImport()
  }
}

// 把一批歌曲依次导入指定歌单，返回统计
async function addSongsBatchToPlaylist(playlistId, songs) {
  let ok = 0
  let skipped = 0
  let failed = 0
  const failCats = {}
  for (let i = 0; i < songs.length; i++) {
    showSnackbar(`正在导入到歌单 ${i + 1}/${songs.length}…`, true)
    try {
      const r = await importSongToLibrary(songs[i])
      if (r && r.song && r.song.id) {
        const res = await Host.playlists.addSongs(playlistId, [r.song.id])
        if (res && res.skipped > 0 && !res.added) skipped++
        else ok++
      } else failed++
    } catch (e) {
      failed++
      failCats[classifyError(e).category] =
        (failCats[classifyError(e).category] || 0) + 1
    }
  }
  return { ok, skipped, failed, failHint: batchFailHint(failCats, failed) }
}

// 根据失败类别统计生成汇总提示后缀：单一原因时给明确原因，混合时给概览
function batchFailHint(failCats, failed) {
  if (!failed) return ''
  const cats = Object.keys(failCats)
  if (cats.length === 1) {
    const c = cats[0]
    if (c === ERR_NETWORK) return '（多为网络异常，请检查服务是否启动）'
    if (c === ERR_AUTH) return '（鉴权失效，请刷新插件页面后重试）'
    if (c === ERR_SOURCE) return '（多为音源失效，已尝试自动换源）'
    return '（多为操作失败）'
  }
  return '（多为音源失效或网络异常）'
}

async function batchImportToPlaylist(playlistId) {
  if (!beginImport()) return
  const songs = [...batchList]
  try {
    closeImportPanel()
    const { ok, skipped, failed, failHint } = await addSongsBatchToPlaylist(playlistId, songs)
    let msg = `已导入 ${ok} 首到歌单`
    if (skipped) msg += `，${skipped} 首已在歌单中`
    if (failed) msg += `，${failed} 首失败` + (failHint || '')
    showSnackbar(msg)
    exitBatchMode()
  } finally {
    endImport()
  }
}

function openImportPanel(song, anchor) {
  pendingImportItem = song
  // 单首导入：退出批量模式
  batchImport = false
  batchList = []
  const panel = document.getElementById('importPlaylistPanel')
  if (!panel) return
  // 即时显示面板（内部先展示「加载中…」），不再等网络、不再盖全屏遮罩
  panel.classList.remove('in')
  panel.classList.add('show')
  loadImportPlaylists()
  // 下一帧加 .in 触发滑入过渡（从 display:none 直接改样式不会触发 transition）
  requestAnimationFrame(() => panel.classList.add('in'))

  // 贴着三点按钮定位（对齐主程序 PopupMenuButton 的原地下拉范式）
  // 先显示再测量，避免尺寸为 0
  const pr = panel.getBoundingClientRect()
  const ar = anchor ? anchor.getBoundingClientRect() : null
  if (ar) {
    // 清除可能残留的居中内联 transform，让 CSS 的滑入动画（translateY/scale）生效
    panel.style.transform = ''
    const margin = 8
    let top = ar.bottom + 4
    if (top + pr.height > window.innerHeight - margin) {
      // 下方空间不足，翻到按钮上方
      top = ar.top - 4 - pr.height
    }
    top = Math.max(margin, top)
    // 默认右对齐按钮右缘；右侧放不下则改为左对齐按钮左缘
    let left = ar.right - pr.width
    if (left < margin) left = Math.min(ar.left, window.innerWidth - pr.width - margin)
    left = Math.max(margin, left)
    panel.style.top = top + 'px'
    panel.style.left = left + 'px'
  } else {
    panel.style.top = '50%'
    panel.style.left = '50%'
    panel.style.transform = 'translate(-50%, -50%)'
  }

  // 点外部 / Esc 关闭
  setTimeout(() => {
    document.addEventListener('click', onImportPanelOutside, true)
    document.addEventListener('keydown', onImportPanelEsc, true)
  }, 0)
}

function onImportPanelOutside(e) {
  const panel = document.getElementById('importPlaylistPanel')
  if (panel && panel.classList.contains('show') && !panel.contains(e.target)) {
    closeImportPanel()
  }
}
function onImportPanelEsc(e) {
  if (e.key === 'Escape') closeImportPanel()
}

function closeImportPanel() {
  const panel = document.getElementById('importPlaylistPanel')
  if (panel) {
    // 先移除 .in 播放淡出/上收动画，动画结束后再移除 .show 真正隐藏
    panel.classList.remove('in')
    setTimeout(() => {
      // 若期间未重新打开（未再次加 in）才隐藏，避免竞态误关
      if (!panel.classList.contains('in')) panel.classList.remove('show')
    }, 180)
  }
  document.removeEventListener('click', onImportPanelOutside, true)
  document.removeEventListener('keydown', onImportPanelEsc, true)
}

async function loadImportPlaylists() {
  const listEl = document.getElementById('importPlaylistList')
  if (!listEl) return
  listEl.innerHTML = '<div class="empty-state">加载中…</div>'
  try {
    const result = await Host.playlists.list()
    importPlaylists =
      Array.isArray(result) ? result : (result && result.playlists) || []
    renderImportPlaylistList()
  } catch (e) {
    if (listEl) listEl.innerHTML = `<div class="empty-state">歌单加载失败：${escapeHtml(friendlyError(e, '加载失败'))}</div>`
  }
}

function renderImportPlaylistList() {
  const listEl = document.getElementById('importPlaylistList')
  if (!listEl) return
  const playlists = importPlaylists || []
  listEl.innerHTML = ''
  if (!playlists.length) {
    listEl.innerHTML = '<div class="empty-state">暂无歌单，可新建</div>'
    return
  }
  playlists.forEach((pl) => {
    const div = document.createElement('div')
    div.className = 'import-playlist-item'
    div.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
      </svg>
      <span>${escapeHtml(pl.name || '未命名')}</span>`
    div.onclick = () => importToPlaylist(pl.id)
    listEl.appendChild(div)
  })
}

// 先把单首歌曲 import 进曲库拿 song.id（含音源失效自动换源重试）。
// 抽出为独立函数，供单首导入与批量导入复用。
async function importSongToLibrary(song) {
  let s = song
  let lastErr = null
  for (let round = 0; round <= MAX_SWITCH_ROUNDS; round++) {
    try {
      return await API.import({
        id: s.id, name: s.name, artist: s.artist, album: s.album,
        cover: s.cover, source: s.source, duration: s.duration, extra: s.extra,
      })
    } catch (e) {
      const msg = e && e.message ? e.message : ''
      if (msg.indexOf('音源已失效') >= 0 && round < MAX_SWITCH_ROUNDS) {
        const alt = await switchSource(s, { current: s.source })
        if (alt && typeof alt === 'object' && alt.id) {
          s = alt
          // 同步到 pendingImportItem，使后续「加歌到歌单」拿到换源后的 song.id
          if (pendingImportItem && pendingImportItem === song) pendingImportItem = alt
          // 进行态：带旋转指示，明确告知正在换源
          showSnackbar('音源已失效，正在换源重试…', true)
          continue
        }
      }
      lastErr = e
      break
    }
  }
  throw lastErr || new Error('导入失败')
}

// 单首导入：复用 importSongToLibrary
async function doImportToLibrary() {
  return importSongToLibrary(pendingImportItem)
}

// 导入进行中锁：防止重复点击导致并发导入
let isImporting = false
function beginImport() {
  if (isImporting) {
    showSnackbar('正在导入中，请稍候…')
    return false
  }
  isImporting = true
  return true
}
function endImport() {
  isImporting = false
}

async function importToLibrary() {
  // 批量模式：整批导入到曲库
  if (batchImport && batchList.length) {
    await batchImportToLibrary()
    return
  }
  if (!pendingImportItem) return
  if (!beginImport()) return
  try {
    closeImportPanel()
    showSnackbar('正在导入到曲库…', true)
    const r = await doImportToLibrary()
    if (r && r.success) showSnackbar(r.already_local ? '已在曲库中' : '已导入到曲库')
    else showSnackbar('导入失败')
  } catch (e) {
    showSnackbar(friendlyError(e, '导入失败'))
  } finally {
    endImport()
  }
}

async function importToPlaylist(playlistId) {
  // 批量模式：整批导入到指定歌单
  if (batchImport && batchList.length) {
    await batchImportToPlaylist(playlistId)
    return
  }
  if (!pendingImportItem) return
  if (!beginImport()) return
  try {
    closeImportPanel()
    showSnackbar('正在导入到曲库…', true)
    const r = await doImportToLibrary()
    if (!r || !r.success || !r.song) {
      showSnackbar('导入失败')
      return
    }
    // addSongs 返回 { added, skipped }：skipped>0 表示歌曲已在该歌单中（被去重跳过）
    const res = await Host.playlists.addSongs(playlistId, [r.song.id])
    const added = (res && res.added) || 0
    const skipped = (res && res.skipped) || 0
    if (added === 0 && skipped > 0) showSnackbar('该歌曲已在歌单中')
    else if (added > 0 && r.already_local) showSnackbar('已在曲库，已导入到歌单')
    else showSnackbar('已导入到歌单')
  } catch (e) {
    showSnackbar(friendlyError(e, '导入失败'))
  } finally {
    endImport()
  }
}

function createNewPlaylist() {
  // 批量模式下无需 pendingImportItem
  if (!batchImport && !pendingImportItem) return
  closeImportPanel()
  const dialog = document.getElementById('newPlaylistDialog')
  const backdrop = document.getElementById('newPlaylistBackdrop')
  const input = document.getElementById('newPlaylistName')
  if (!dialog || !backdrop) return
  newPlaylistCallback = async (name) => {
    if (!beginImport()) return
    try {
      const playlist = await Host.playlists.create({ name: name, type: 'normal' })
      if (!playlist || !playlist.id) {
        showSnackbar('创建歌单失败')
        return
      }
      // 批量模式：把整批歌曲导入新建歌单
      if (batchImport && batchList.length) {
        showSnackbar('正在导入到曲库…', true)
        const { ok, skipped, failed, failHint } = await addSongsBatchToPlaylist(
          playlist.id,
          [...batchList],
        )
        const existed = importPlaylists.some(
          (p) => p && String(p.id) === String(playlist.id),
        )
        if (!existed) importPlaylists.push(playlist)
        renderImportPlaylistList()
        let msg = existed ? '同名歌单已存在' : '已导入到新歌单'
        if (ok) msg += `（${ok} 首）`
        if (skipped) msg += `，${skipped} 首已在歌单中`
        if (failed) msg += `，${failed} 首失败` + (failHint || '')
        showSnackbar(msg)
        exitBatchMode()
        return
      }
      // 单首模式
      showSnackbar('正在导入到曲库…', true)
      const r = await doImportToLibrary()
      if (!r || !r.success || !r.song) {
        showSnackbar('导入失败')
        return
      }
      // addSongs 返回 { added, skipped }：skipped>0 表示该歌曲早已在此歌单中
      const res = await Host.playlists.addSongs(playlist.id, [r.song.id])
      const added = (res && res.added) || 0
      const skipped = (res && res.skipped) || 0
      // 本地即时更新列表，避免重新拉取（宿主列表有缓存/一致性延迟时看不到新建项）。
      // 注意：主程序对同名歌单是幂等的——重名时会返回已存在的歌单（同一 id）而非新建，
      // 故这里必须按 id 去重，否则同一歌单会被重复 push，导致列表出现「重名两条」。
      const existed = importPlaylists.some(
        (p) => p && String(p.id) === String(playlist.id),
      )
      if (!existed) importPlaylists.push(playlist)
      renderImportPlaylistList()
      if (added === 0 && skipped > 0) {
        showSnackbar(existed ? '同名歌单已存在，且歌曲已在歌单中' : '该歌曲已在歌单中')
      } else if (existed) {
        showSnackbar('同名歌单已存在，已导入到该歌单')
      } else {
        showSnackbar('已导入到新歌单')
      }
    } catch (e) {
      showSnackbar(friendlyError(e, '导入失败'))
    } finally {
      endImport()
    }
  }
  if (input) input.value = ''
  backdrop.style.display = 'block'
  dialog.classList.add('show')
  if (input) setTimeout(() => input.focus(), 50)
}

function closeNewPlaylistDialog() {
  const dialog = document.getElementById('newPlaylistDialog')
  const backdrop = document.getElementById('newPlaylistBackdrop')
  if (dialog) dialog.classList.remove('show')
  if (backdrop) backdrop.style.display = 'none'
  newPlaylistCallback = null
}

async function confirmNewPlaylist() {
  const input = document.getElementById('newPlaylistName')
  const name = (input && input.value ? input.value : '').trim()
  if (!name) {
    showSnackbar('请输入歌单名称')
    return
  }
  const cb = newPlaylistCallback
  closeNewPlaylistDialog()
  if (cb) await cb(name)
}

// ---------- 我的歌单 ----------
let myListLoaded = false
let allPlaylists = []
let currentCat = 'all'

// 解析 /music/user_playlists 返回的 HTML：
// 优先读卡片内「导入本地」按钮的 data-external-id / data-source（显式属性，无 & 转义问题）；
// 兜底再用 onclick 里的 detailURL 正则取 id/source（部分 WebView 不解码 &amp; 会导致正则失效）。
function parsePlaylists(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const out = []
  doc.querySelectorAll('.playlist-card').forEach((card) => {
    const btn = card.querySelector('button[data-external-id]')
    let id = btn ? btn.getAttribute('data-external-id') : ''
    let source = btn ? btn.getAttribute('data-source') : ''
    if (!id || !source) {
      const onclick = card.getAttribute('onclick') || ''
      const idM = onclick.match(/[?&]id=([^&'"\s)]+)/)
      const srcM = onclick.match(/[?&]source=([^&'"\s)]+)/)
      if (idM) id = id || decodeURIComponent(idM[1])
      if (srcM) source = source || srcM[1]
    }
    if (!id || !source) return
    const coverEl = card.querySelector('.playlist-cover img')
    const cover = coverEl ? coverEl.getAttribute('src') : ''
    const titleEl = card.querySelector('.playlist-title')
    const title = titleEl ? titleEl.textContent.trim() : ''
    const authorEl = card.querySelector('.playlist-author')
    const creator = authorEl ? authorEl.textContent.trim() : ''
    const countEl = card.querySelector('.playlist-count')
    const count = countEl ? countEl.textContent.replace(/\D/g, '') : '0'
    const tagEl = card.querySelector('.tag')
    const tag = tagEl ? tagEl.textContent.trim() : source
    // 判定内容类型：优先取卡片内「导入本地」按钮的 data-content-type
    // （搜索歌单/专辑时后端会写入 playlist/album）；否则从 navigateTo 路由推断，
    // 仍无则默认 playlist（每日推荐、我的歌单均为歌单）。
    let contentType = 'playlist'
    const ctBtn = card.querySelector('[data-content-type]')
    if (ctBtn) {
      const ct = ctBtn.getAttribute('data-content-type')
      if (ct === 'album') contentType = 'album'
    } else {
      const nav = card.getAttribute('onclick') || ''
      if (/\/album\b/.test(nav)) contentType = 'album'
    }
    out.push({ id, source, title, cover, creator, count, tag, contentType })
  })
  return out
}

// 诊断 user_playlists：提取每个音源 tab 的真实返回（空提示 / 报错 / 卡片数），定位"已登录却取不到歌单"的根因
function diagnoseUserPlaylists(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const text = (doc.body && doc.body.textContent) || ''
  const pages = []
  if (/登录 music-dl|初始化管理员账号|请输入用户名/.test(text)) {
    pages.push('响应是 go-music-dl 登录页：服务端鉴权已开启，插件请求未带会话 Cookie → 请在「插件设置」填入带鉴权的地址，或关闭 go-music-dl 鉴权')
  }
  if (/请先初始化管理员账号|setupRequired/.test(text)) {
    pages.push('go-music-dl 尚未初始化管理员账号（先去网页端 /setup 创建）')
  }
  const tabNameById = {}
  doc.querySelectorAll('.category-source-tab').forEach((t) => {
    const target = t.getAttribute('data-target')
    const nameEl = t.querySelector('.category-source-tab-name')
    if (target) tabNameById[target] = nameEl ? nameEl.textContent.trim() : target
  })
  const panels = []
  doc.querySelectorAll('.category-source-panel').forEach((p) => {
    const id = p.id || ''
    const name = tabNameById[id] || id
    const cards = p.querySelectorAll('.playlist-card').length
    let note = `找到 ${cards} 个歌单`
    if (cards === 0) {
      const emptyEl = p.querySelector('.category-source-empty')
      note = emptyEl ? emptyEl.textContent.trim() : '（panel 内无任何内容）'
    }
    panels.push({ name, cards, note })
  })
  const cards = panels.reduce((s, p) => s + p.cards, 0)
  let sampleOnclick = ''
  let sampleHtml = ''
  const firstCard = doc.querySelector('.playlist-card')
  if (firstCard) {
    sampleOnclick = firstCard.getAttribute('onclick') || ''
    sampleHtml = firstCard.outerHTML.slice(0, 500)
  }
  return { cards, panels, pages, sampleOnclick, sampleHtml }
}

// 解析 /music/playlist 返回的 HTML：.song-card 与搜索同结构，直接读 dataset
function parsePlaylistSongs(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const out = []
  doc.querySelectorAll('.song-card').forEach((card) => {
    const ds = card.dataset
    if (!ds.id) return
    let extra = {}
    if (ds.extra) {
      try { extra = JSON.parse(ds.extra) } catch (e) { extra = {} }
    }
    out.push({
      id: ds.id,
      source: ds.source || '',
      name: ds.name || '',
      artist: ds.artist || '',
      album: ds.album || '',
      cover: ds.cover || '',
      duration: Number(ds.duration) || 0,
      extra,
    })
  })
  return out
}

function renderPlaylistRow(pl) {
  const card = document.createElement('div')
  card.className = 'playlist-card'
  const cover = pl.cover || PLUGIN_ICON
  const tagText = pl.tag || pl.source || ''
  const tag = escapeHtml(sourceLabel(tagText) || tagText)
  card.innerHTML = `
    <div class="playlist-cover">
      <img src="${cover}" referrerpolicy="no-referrer" onerror="this.onerror=null; this.src='${FALLBACK_COVER}'">
      ${tag ? `<span class="playlist-source-tag">${tag}</span>` : ''}
    </div>
    <div class="playlist-meta">
      <div class="playlist-title">${escapeHtml(pl.title)}</div>
      <div class="playlist-sub">${escapeHtml(pl.creator) || '未知'} · 共 ${escapeHtml(pl.count)} 首</div>
    </div>`
  card.onclick = () => {
    if (pl.contentType === 'album') openAlbum(pl)
    else openPlaylist(pl)
  }
  return card
}

// 按当前 allPlaylists 构建分类筛选条：全部 + 各音源（按 SOURCE_LABELS 顺序，缺失音源兜底）
function buildPlaylistCats() {
  const bar = document.getElementById('myPlaylistCats')
  if (!bar) return
  const present = []
  const seen = new Set()
  for (const s of ALL_SOURCES) {
    if (allPlaylists.some((p) => p.source === s) && !seen.has(s)) {
      present.push(s)
      seen.add(s)
    }
  }
  allPlaylists.forEach((p) => {
    if (!seen.has(p.source)) {
      present.push(p.source)
      seen.add(p.source)
    }
  })
  const cats = [{ key: 'all', label: '全部' }]
  present.forEach((s) => cats.push({ key: s, label: sourceLabel(s) || s }))
  bar.innerHTML = ''
  cats.forEach((c) => {
    const chip = document.createElement('button')
    chip.className = 'mylist-cat' + (c.key === currentCat ? ' active' : '')
    chip.textContent = c.label
    chip.onclick = () => {
      currentCat = c.key
      buildPlaylistCats()
      renderPlaylistsByCat()
    }
    bar.appendChild(chip)
  })
}

// 按当前选中分类过滤并渲染歌单列表
function renderPlaylistsByCat() {
  const listEl = document.getElementById('myPlaylistList')
  if (!listEl) return
  const list =
    currentCat === 'all'
      ? allPlaylists
      : allPlaylists.filter((p) => p.source === currentCat)
  if (!list.length) {
    listEl.innerHTML = '<div class="empty-state">该分类下暂无歌单</div>'
    return
  }
  listEl.innerHTML = ''
  list.forEach((pl) => listEl.appendChild(renderPlaylistRow(pl)))
}

async function loadUserPlaylists() {
  const base = normalizeBaseUrl(config.baseUrl)
  const listEl = document.getElementById('myPlaylistList')
  if (!base) {
    listEl.innerHTML = '<div class="empty-state">请先在「插件设置」中填写 go-music-dl 服务地址</div>'
    return
  }
  listEl.innerHTML = '<div class="empty-state">加载中…</div>'
  try {
    const sources = (config.sources && config.sources.length) ? config.sources : ALL_SOURCES
    const url = `${base}/user_playlists?sources=${sources.map(encodeURIComponent).join('&sources=')}`
    const res = await gmdFetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
    if (res.status === 401) {
      listEl.innerHTML = '<div class="empty-state">go-music-dl 启用了登录鉴权，请改用无需鉴权的地址</div>'
      return
    }
    if (!res.ok) {
      listEl.innerHTML = `<div class="empty-state">加载失败: HTTP ${res.status}</div>`
      return
    }
    const html = await res.text()
    const playlists = parsePlaylists(html)
    if (!playlists.length) {
      const diag = diagnoseUserPlaylists(html)
      const extra = []
      if (diag.pages.length) extra.push(...diag.pages)
      diag.panels.forEach((p) => extra.push(`${p.name}：${p.note}`))
      const detail = extra.length
        ? `<ul style="text-align:left;margin:8px 0 0;padding-left:18px;font-size:12px;line-height:1.6;">${extra.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`
        : ''
      listEl.innerHTML = `<div class="empty-state">未获取到歌单。诊断信息：${detail}</div>`
      console.log('[我的歌单] user_playlists 响应长度', html.length, '诊断', JSON.stringify(diag))
      return
    }
    listEl.innerHTML = ''
    playlists.forEach((pl) => listEl.appendChild(renderPlaylistRow(pl)))
    allPlaylists = playlists
    currentCat = 'all'
    buildPlaylistCats()
    renderPlaylistsByCat()
    myListLoaded = true
  } catch (e) {
    if (isNetworkError(e)) {
      listEl.innerHTML = '<div class="empty-state">无法连接到服务地址，请检查 go-music-dl 服务是否启动、地址是否正确，或在「插件设置」中点击「测试连接」。</div>'
    } else {
      listEl.innerHTML = `<div class="empty-state">加载失败: ${escapeHtml(e.message)}</div>`
    }
  }
}

// 进入歌单/专辑详情：拉取歌曲列表并渲染。
// endpoint: 'playlist' | 'album'（go-music-dl 两接口同参：id/source）。
// showImport: 是否开放逐首「导入到库」。为保持一致性，搜索单曲、专辑详情、歌单详情均开放。
// 来源可能是「我的歌单」页或「搜索」页，返回时需回到对应视图（见 backToPlaylists）。
let songsBackToMyList = false

async function openCollection(pl, endpoint, showImport) {
  songsBackToMyList = !!document
    .getElementById('tab-mylist')
    .classList.contains('active')
  document.getElementById('myPlaylistView').style.display = 'none'
  document.getElementById('mySongsView').style.display = 'block'
  document.getElementById('mySongsTitle').textContent =
    pl.title || (endpoint === 'album' ? '专辑歌曲' : '歌单歌曲')
  const listEl = document.getElementById('mySongsList')
  listEl.innerHTML = '<div class="empty-state">加载中…</div>'
  const base = normalizeBaseUrl(config.baseUrl)
  if (!base) {
    listEl.innerHTML = '<div class="empty-state">未配置服务地址</div>'
    return
  }
  try {
    const url = `${base}/${endpoint}?id=${encodeURIComponent(pl.id)}&source=${encodeURIComponent(pl.source)}`
    const res = await gmdFetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
    if (!res.ok) {
      listEl.innerHTML = `<div class="empty-state">加载失败: HTTP ${res.status}</div>`
      return
    }
    const html = await res.text()
    const songs = parsePlaylistSongs(html)
    if (!songs.length) {
      listEl.innerHTML = `<div class="empty-state">该${endpoint === 'album' ? '专辑' : '歌单'}暂无歌曲</div>`
      return
    }
    queue = songs
    listEl.innerHTML = ''
    songs.forEach((s, i) => listEl.appendChild(renderSong(s, i, { showImport })))
    scheduleInspect(listEl)
  } catch (e) {
    listEl.innerHTML = `<div class="empty-state">加载失败: ${escapeHtml(e.message)}</div>`
  }
}

async function openPlaylist(pl) {
  return openCollection(pl, 'playlist', true)
}

async function openAlbum(pl) {
  return openCollection(pl, 'album', true)
}

function backToPlaylists() {
  document.getElementById('mySongsView').style.display = 'none'
  if (songsBackToMyList) {
    document.getElementById('myPlaylistView').style.display = 'block'
  }
}

function initTabs() {
  document.querySelectorAll('.tab-item').forEach((tab) => {
    tab.onclick = () => {
      // 切换 tab 时收起歌单详情全屏浮层，并把歌单列表视图恢复可见。
      // 否则若此前从「搜索」页进入详情（songsBackToMyList=false），backToPlaylists 不会恢复
      // myPlaylistView，回到「我的歌单」时列表视图仍为 display:none → 整页白屏（只能刷新）。
      document.getElementById('mySongsView').style.display = 'none'
      document.getElementById('myPlaylistView').style.display = 'block'
      document
        .querySelectorAll('.tab-item')
        .forEach((t) => t.classList.remove('active'))
      document
        .querySelectorAll('.tab-content')
        .forEach((c) => c.classList.remove('active'))
      tab.classList.add('active')
      document
        .getElementById('tab-' + tab.dataset.tab)
        .classList.add('active')
      if (tab.dataset.tab === 'mylist' && !myListLoaded) loadUserPlaylists()
      if (tab.dataset.tab === 'browser') showBrowserHome()
    }
  })
}

function initPlayer() {
  const audio = getAudio()
  audio.addEventListener('loadedmetadata', () => {
    // 加载成功：若此前显示「重试/换源中」的进行态提示（含 spinner），清除它
    const sb = document.getElementById('snackbar')
    if (sb && sb.querySelector('.snackbar-spinner')) hideSnackbar()
    audioRetry = 0
    syncProgress()
  })
  audio.addEventListener('timeupdate', syncProgress)
  audio.addEventListener('play', () => setPlayIcon(true))
  audio.addEventListener('pause', () => setPlayIcon(false))
  audio.addEventListener('ended', nextSong)
  audio.addEventListener('error', async () => {
    const song = queue[currentIndex]
    if (!song || audioSwitching) return
    // 先原样重试（处理偶发网络抖动）
    if (audioRetry < MAX_AUDIO_RETRY) {
      audioRetry++
      showSnackbar(`加载失败，正在重试 (${audioRetry}/${MAX_AUDIO_RETRY})…`, true)
      setTimeout(() => startAudio(song, audioRetry), 700 * audioRetry)
      return
    }
    // 原样重试仍失败 → 自动换源再播（增强体验，无需用户手动操作）
    if (audioSwitchRetry < MAX_AUDIO_SWITCH) {
      audioSwitching = true
      audioSwitchRetry++
      showSnackbar(
        `当前音源不可播放，正在自动换源 (${audioSwitchRetry}/${MAX_AUDIO_SWITCH})…`,
        true,
      )
      try {
        const alt = await switchSource(song, { current: song.source })
        if (alt && typeof alt === 'object') {
          queue[currentIndex] = alt
          const card = document.querySelectorAll('#browserList .song-row')[
            currentIndex
          ]
          if (card) applySwitchedSong(card, alt)
          audioRetry = 0
          startAudio(alt, 0)
          return
        }
      } catch (e) {
        /* 换源异常，落到最终提示 */
      } finally {
        audioSwitching = false
      }
    }
    showSnackbar('播放失败：已尝试换源仍无法播放，可换一首或稍后重试。')
  })

  document.getElementById('pbPlayBtn').onclick = togglePlay
  document.getElementById('pbStopBtn').onclick = stopPlay
  document.getElementById('fpPlayBtn').onclick = togglePlay
  document.getElementById('fpPrevBtn').onclick = prevSong
  document.getElementById('fpNextBtn').onclick = nextSong
  document.getElementById('fpLyricToggle').onclick = toggleLyricPage

  bindSeek('pbTrack')
  bindSeek('fpProgressTrack')

  // 供 index.html 内联 onclick 调用
  window.openFullscreenPlayer = openFullscreenPlayer
  window.closeFullscreenPlayer = closeFullscreenPlayer
  window.openImportPanel = openImportPanel
  window.closeImportPanel = closeImportPanel
  window.importToLibrary = importToLibrary
  window.importToPlaylist = importToPlaylist
  window.createNewPlaylist = createNewPlaylist
  window.closeNewPlaylistDialog = closeNewPlaylistDialog
  window.confirmNewPlaylist = confirmNewPlaylist
}

document.addEventListener('DOMContentLoaded', () => {
  initTabs()
  initPlayer()
  loadConfig().then(() => showBrowserHome())
  document.getElementById('searchBtn').onclick = doSearch
  document
    .getElementById('searchInput')
    .addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSearch()
    })
  // 搜索框「单曲 / 歌单 / 专辑」分段切换
  document.getElementById('searchTypeSwitch').querySelectorAll('.mylist-cat').forEach((btn) => {
    btn.onclick = () => {
      document
        .getElementById('searchTypeSwitch')
        .querySelectorAll('.mylist-cat')
        .forEach((b) => b.classList.remove('active'))
      btn.classList.add('active')
      currentSearchType = btn.dataset.type || 'song'
    }
  })
  document.getElementById('saveConfigBtn').onclick = saveConfig
  document.getElementById('testConnBtn').onclick = testConnection
  // 全选 / 清空：切换勾选后立即保存，免去再点「保存配置」
  document.getElementById('selectAllSourcesBtn').onclick = () => { setAllSources(true); saveConfig() }
  document.getElementById('clearAllSourcesBtn').onclick = () => { setAllSources(false); saveConfig() }
  // 单个音源勾选变动也即时保存
  document.getElementById('configSources').addEventListener('change', () => saveConfig())
  // 头部「刷新」：在搜索首页刷新推荐，否则执行搜索
  document.getElementById('refreshBtn').onclick = () => {
    const browserTab = document.querySelector('.tab-item[data-tab="browser"]')
    const isBrowser = browserTab && browserTab.classList.contains('active')
    if (isBrowser && document.getElementById('recommendCard').style.display !== 'none') {
      recommendLoaded = false
      loadRecommend()
    } else {
      doSearch()
    }
  }
  document.getElementById('refreshRecommendBtn').onclick = () => {
    recommendLoaded = false
    loadRecommend()
  }
  document.getElementById('refreshMyListBtn').onclick = loadUserPlaylists
  document.getElementById('backToPlaylistsBtn').onclick = backToPlaylists
  // 搜索结果页「返回首页」：回到每日推荐，无需刷新整页
  document.getElementById('backToHomeBtn').onclick = backToBrowserHome
  const confirmNewPlaylistBtn = document.getElementById('confirmNewPlaylist')
  if (confirmNewPlaylistBtn) confirmNewPlaylistBtn.onclick = confirmNewPlaylist
  // 批量多选：切换多选模式 + 底部批量操作栏
  const batchToggleBtn = document.getElementById('batchToggleBtn')
  if (batchToggleBtn) batchToggleBtn.onclick = () => setSelectMode(!selectMode)
  const batchToLibraryBtn = document.getElementById('batchToLibraryBtn')
  if (batchToLibraryBtn) batchToLibraryBtn.onclick = () => {
    if (!selectedSongs.size) return
    batchImport = true
    batchList = [...selectedSongs.values()]
    importToLibrary()
  }
  const batchToPlaylistBtn = document.getElementById('batchToPlaylistBtn')
  if (batchToPlaylistBtn) batchToPlaylistBtn.onclick = () => openImportPanelForBatch()
  const batchClearBtn = document.getElementById('batchClearBtn')
  if (batchClearBtn) batchClearBtn.onclick = () => {
    selectedSongs.clear()
    updateBatchBar()
  }
})
