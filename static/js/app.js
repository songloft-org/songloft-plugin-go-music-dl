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
  search: (q) => fetchAuth(`./search?q=${encodeURIComponent(q)}`),
  import: (item) =>
    fetchAuth('./import', {
      method: 'POST',
      body: JSON.stringify({ item }),
    }),
}

function showSnackbar(msg) {
  const el = document.getElementById('snackbar')
  el.textContent = msg
  el.className = 'snackbar show'
  setTimeout(() => {
    el.className = 'snackbar'
  }, 2500)
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
  } catch (e) {
    showSnackbar('保存失败: ' + e.message)
  }
}

async function doSearch() {
  const q = document.getElementById('searchInput').value.trim()
  if (!q) return
  const list = document.getElementById('browserList')
  list.innerHTML = '<div class="empty-state">搜索中...</div>'
  document.getElementById('recommendCard').style.display = 'none'
  document.getElementById('listCard').style.display = 'block'
  try {
    const songs = await API.search(q)
    if (!Array.isArray(songs) || songs.length === 0) {
      list.innerHTML = '<div class="empty-state">未找到结果</div>'
      return
    }
    queue = songs
    list.innerHTML = ''
    songs.forEach((s, i) => list.appendChild(renderSong(s, i)))
    scheduleInspect(list)
  } catch (e) {
    list.innerHTML = `<div class="empty-state">搜索失败: ${escapeHtml(e.message)}</div>`
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
    const res = await fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
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
    listEl.innerHTML = `<div class="empty-state">加载失败: ${escapeHtml(e.message)}</div>`
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
    const res = await fetch(`${base}/inspect?${p.toString()}`, {
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
    const res = await fetch(`${base}/switch_source?${p.toString()}`, {
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
  const showImport = opts.showImport !== false
  const card = document.createElement('div')
  card.className = 'song-row'
  cardData.set(card, { song: s, index })
  const cover = s.cover || FALLBACK_COVER
  const importBtnHtml = showImport
    ? '<button class="btn-filled" data-act="dl">导入到库</button>'
    : ''
  card.innerHTML = `
    <img src="${cover}" class="song-cover" referrerpolicy="no-referrer" onerror="this.src='${FALLBACK_COVER}'">
    <div class="song-meta">
      <div class="song-title">${escapeHtml(s.name)}</div>
      <div class="song-sub">${escapeHtml(s.artist)} · ${escapeHtml(s.album || '')} · ${escapeHtml(sourceLabel(s.source))}</div>
      <span class="song-status status-pending">待检测</span>
    </div>
    <div class="song-actions">
      <button class="btn-text" data-act="play">试听</button>
      ${importBtnHtml}
    </div>`
  card.querySelector('[data-act="play"]').onclick = (e) => {
    e.stopPropagation()
    const d = cardData.get(card)
    if (d) playSong(d.song, d.index)
  }
  const dlBtn = card.querySelector('[data-act="dl"]')
  if (dlBtn)
  dlBtn.onclick = async (e) => {
    e.stopPropagation()
    const d = cardData.get(card)
    if (!d) return
    const s2 = d.song
    const btn = dlBtn
    try {
      showSnackbar('正在导入到曲库...')
      const r = await API.import({
        id: s2.id,
        name: s2.name,
        artist: s2.artist,
        album: s2.album,
        cover: s2.cover,
        source: s2.source,
        duration: s2.duration,
        extra: s2.extra,
      })
      if (r && r.success) {
        showSnackbar(r.already_local ? '已在曲库中' : '已导入到曲库')
      } else {
        showSnackbar('导入失败')
      }
    } catch (e) {
      const msg = e && e.message ? e.message : ''
      if (msg.indexOf('音源已失效') >= 0) {
        // 导入前校验发现该音源已失效：标红卡片并禁用，避免反复点失败
        setSongStatus(card, 'fail', '音源已失效')
        setCardEnabled(card, false)
        showSnackbar('导入失败：音源已失效')
      } else {
        showSnackbar('导入失败: ' + msg)
      }
    }
  }
  // 点击整行：直接播放（迷你播放条常驻底部；点播放条本身可展开全屏播放器）
  card.onclick = () => {
    const d = cardData.get(card)
    if (d) playSong(d.song, d.index)
  }
  return card
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
    out.push({ id, source, title, cover, creator, count, tag })
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
  const tag = escapeHtml(sourceLabel(pl.tag) || pl.tag || '')
  card.innerHTML = `
    <div class="playlist-cover">
      <img src="${cover}" referrerpolicy="no-referrer" onerror="this.onerror=null; this.src='${FALLBACK_COVER}'">
      ${tag ? `<span class="playlist-source-tag">${tag}</span>` : ''}
    </div>
    <div class="playlist-meta">
      <div class="playlist-title">${escapeHtml(pl.title)}</div>
      <div class="playlist-sub">${escapeHtml(pl.creator) || '未知'} · 共 ${escapeHtml(pl.count)} 首</div>
    </div>`
  card.onclick = () => openPlaylist(pl)
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
    const res = await fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
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
    listEl.innerHTML = `<div class="empty-state">加载失败: ${escapeHtml(e.message)}</div>`
  }
}

async function openPlaylist(pl) {
  document.getElementById('myPlaylistView').style.display = 'none'
  document.getElementById('mySongsView').style.display = 'block'
  document.getElementById('mySongsTitle').textContent = pl.title || '歌单歌曲'
  const listEl = document.getElementById('mySongsList')
  listEl.innerHTML = '<div class="empty-state">加载中…</div>'
  const base = normalizeBaseUrl(config.baseUrl)
  if (!base) {
    listEl.innerHTML = '<div class="empty-state">未配置服务地址</div>'
    return
  }
  try {
    const url = `${base}/playlist?id=${encodeURIComponent(pl.id)}&source=${encodeURIComponent(pl.source)}`
    const res = await fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
    if (!res.ok) {
      listEl.innerHTML = `<div class="empty-state">加载失败: HTTP ${res.status}</div>`
      return
    }
    const html = await res.text()
    const songs = parsePlaylistSongs(html)
    if (!songs.length) {
      listEl.innerHTML = '<div class="empty-state">该歌单暂无歌曲</div>'
      return
    }
    queue = songs
    listEl.innerHTML = ''
    songs.forEach((s, i) => listEl.appendChild(renderSong(s, i, { showImport: false })))
    scheduleInspect(listEl)
  } catch (e) {
    listEl.innerHTML = `<div class="empty-state">加载失败: ${escapeHtml(e.message)}</div>`
  }
}

function backToPlaylists() {
  document.getElementById('mySongsView').style.display = 'none'
  document.getElementById('myPlaylistView').style.display = 'block'
}

function initTabs() {
  document.querySelectorAll('.tab-item').forEach((tab) => {
    tab.onclick = () => {
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
      showSnackbar(`加载失败，正在重试 (${audioRetry}/${MAX_AUDIO_RETRY})…`)
      setTimeout(() => startAudio(song, audioRetry), 700 * audioRetry)
      return
    }
    // 原样重试仍失败 → 自动换源再播（增强体验，无需用户手动操作）
    if (audioSwitchRetry < MAX_AUDIO_SWITCH) {
      audioSwitching = true
      audioSwitchRetry++
      showSnackbar(
        `当前音源不可播放，正在自动换源 (${audioSwitchRetry}/${MAX_AUDIO_SWITCH})…`,
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
  document.getElementById('saveConfigBtn').onclick = saveConfig
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
})
