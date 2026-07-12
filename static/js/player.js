// player.js — 播放队列 + 音频 + 进度
import {
  store,
  effectiveQuality,
  FALLBACK_COVER,
} from './state.js'
import { normalizeBaseUrl, buildCoverUrl, gmdFetch } from './api.js'
import { fmtTime, formatBitrateBadge } from './util.js'
import { loadLyrics, highlightLyric } from './lyrics.js'

export function getAudio() {
  return document.getElementById('audio')
}

// 构建试听直链（浏览器内直接播放，走 go-music-dl /music/download?stream=1）
export function buildStreamUrl(s) {
  const base = normalizeBaseUrl(store.config.baseUrl)
  // 把音质档位写进 extra.level，后端会透传到 model.Song.Extra，
  // 网易云据此按指定音质取链（standard/exhigh/lossless/hires）；其他音源忽略该字段。
  const extra = { ...(s.extra || {}) }
  if (s.source === 'netease') extra.level = effectiveQuality()
  const p = new URLSearchParams({
    id: s.id,
    source: s.source,
    stream: '1',
    name: s.name || '',
    artist: s.artist || '',
    album: s.album || '',
    extra: JSON.stringify(extra),
  })
  return `${base}/download?${p.toString()}`
}

export function setPlayIcon(playing) {
  const icons = [
    document.querySelector('#pbPlayBtn .material-symbols-outlined'),
    document.querySelector('#fpPlayBtn .material-symbols-outlined'),
  ]
  icons.forEach((ic) => {
    if (ic) ic.textContent = playing ? 'pause' : 'play_arrow'
  })
}

export function setBar(fillId, thumbId, pct) {
  const f = document.getElementById(fillId)
  const t = document.getElementById(thumbId)
  if (f) f.style.width = pct + '%'
  if (t) t.style.left = pct + '%'
}

export function syncProgress() {
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
  if (store.fpLyrics.length) highlightLyric(p)
}

// 查询 go-music-dl /inspect 拿当前歌曲实际比特率（网易云按当前音质档位透传 level），
// 与列表卡片 inspect 同款逻辑，仅取 bitrate。用于播放条自动识别当前音质。
async function fetchBitrate(song) {
  const base = normalizeBaseUrl(store.config.baseUrl)
  if (!base) return ''
  const extra = { ...(song.extra || {}) }
  if (song.source === 'netease') extra.level = effectiveQuality()
  const p = new URLSearchParams({
    id: song.id,
    source: song.source,
    duration: song.duration || 0,
    extra: JSON.stringify(extra),
  })
  try {
    const res = await gmdFetch(`${base}/inspect?${p.toString()}`, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
    if (!res.ok) return ''
    const j = await res.json()
    return (j && j.bitrate) || ''
  } catch {
    return ''
  }
}

export function updateNowPlaying(song, cover) {
  document.getElementById('pbTitle').textContent = song.name || '未知歌曲'
  document.getElementById('pbArtist').textContent = song.artist || '-'
  document.getElementById('fpSongTitle').textContent = song.name || '未知歌曲'
  document.getElementById('fpSongArtist').textContent = song.artist || '-'

  const pbCover = document.getElementById('pbCover')
  const fpCover = document.getElementById('fpCoverImg')
  const bg = document.getElementById('fpBgImage')
  const coverUrl = cover ? buildCoverUrl(cover) : ''
  if (coverUrl) {
    if (pbCover) {
      pbCover.onerror = () => { pbCover.src = FALLBACK_COVER }
      pbCover.src = coverUrl
    }
    if (fpCover) {
      fpCover.onerror = () => { fpCover.removeAttribute('src') }
      fpCover.src = coverUrl
    }
    if (bg) bg.style.backgroundImage = `url("${coverUrl}")`
  } else {
    // 无封面：迷你播放条与全屏播放器均显示占位音符（music_note）
    if (pbCover) { pbCover.onerror = null; pbCover.removeAttribute('src') }
    if (fpCover) { fpCover.removeAttribute('src'); fpCover.onerror = null }
    if (bg) bg.style.backgroundImage = ''
  }
  setPlayIcon(true)
  syncProgress()
  loadLyrics(song)
  highlightCurrentInList()
  // 自动识别当前歌曲实际比特率：异步查询，不阻塞播放；切音质后也会随 startAudio 重新触发
  fetchBitrate(song).then((br) => {
    const el = document.getElementById('pbBitrate')
    if (el) el.textContent = formatBitrateBadge(br)
  })
}

export function playSong(song, index) {
  if (!song) return
  store.currentIndex = index
  store.audioRetry = 0
  store.audioSwitchRetry = 0
  startAudio(song)
}

// 真正给 <audio> 赋值并播放。retry 时通过 _r 参数绕开网关对 404/504 的缓存。
export function startAudio(song, retry) {
  const audio = getAudio()
  let url = buildStreamUrl(song)
  if (retry) url += (url.includes('?') ? '&' : '?') + '_r=' + retry
  audio.src = url
  audio.load()
  updateNowPlaying(song, song.cover || '')
  audio.play().catch(() => {})
}

export function togglePlay() {
  const audio = getAudio()
  if (!audio.src) return
  if (audio.paused) audio.play().catch(() => {})
  else audio.pause()
}

export function stopPlay() {
  const audio = getAudio()
  audio.pause()
  audio.currentTime = 0
  setPlayIcon(false)
  syncProgress()
  // 停止后无歌曲播放：封面露出音符占位，标题/歌手/歌词回到「暂无播放 / - / 暂无歌词」，
  // 迷你播放条保持常驻（不直接隐藏），让底部布局稳定、符合音乐 App 惯例。
  const pbCover = document.getElementById('pbCover')
  if (pbCover) { pbCover.onerror = null; pbCover.removeAttribute('src') }
  const pbTitle = document.getElementById('pbTitle')
  const pbArtist = document.getElementById('pbArtist')
  const pbLyric = document.getElementById('pbLyric')
  if (pbTitle) pbTitle.textContent = '暂无播放'
  if (pbArtist) pbArtist.textContent = '-'
  if (pbLyric) pbLyric.textContent = '暂无歌词'
}

export function playQueue(i) {
  const s = store.queue[i]
  if (s) playSong(s, i)
}

export function prevSong() {
  if (store.currentIndex > 0) playQueue(store.currentIndex - 1)
}

export function nextSong() {
  if (store.currentIndex < store.queue.length - 1) playQueue(store.currentIndex + 1)
  else stopPlay()
}

export function highlightCurrentInList() {
  document.querySelectorAll('#browserList .song-row, #mySongsList .song-row').forEach((el, i) => {
    el.style.background = i === store.currentIndex ? 'rgba(99,102,241,.10)' : ''
  })
}
