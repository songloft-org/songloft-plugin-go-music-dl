// player.js — 播放队列 + 音频 + 进度
import {
  store,
  effectiveQuality,
  QUALITY_OPTIONS,
  FALLBACK_COVER,
  PLUGIN_ICON,
} from './state.js'
import { normalizeBaseUrl, buildCoverUrl } from './api.js'
import { fmtTime, showSnackbar } from './util.js'
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

export function updateNowPlaying(song, cover) {
  document.getElementById('pbTitle').textContent = song.name || '未知歌曲'
  document.getElementById('pbArtist').textContent = song.artist || '-'
  document.getElementById('fpSongTitle').textContent = song.name || '未知歌曲'
  document.getElementById('fpSongArtist').textContent = song.artist || '-'

  const pbCover = document.getElementById('pbCover')
  const fpCover = document.getElementById('fpCoverImg')
  const bg = document.getElementById('fpBgImage')
  const placeholder = document.getElementById('fpCoverPlaceholder')
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
  refreshQualityControl(song)
  document.getElementById('playerBar').style.display = 'flex'
  audio.play().catch(() => {})
}

// 根据当前歌曲刷新底部播放条的音质选择器：网易云可切换，其他音源禁用
export function refreshQualityControl(song) {
  const sel = document.getElementById('pbQualitySelect')
  if (!sel) return
  sel.value = effectiveQuality()
  const netease = !!(song && song.source === 'netease')
  sel.disabled = !netease
  sel.title = netease
    ? '音质（仅网易云可切换）'
    : '当前音源不支持切换音质（仅网易云支持）'
}

// 用户切换音质后，重新加载当前歌曲（保留播放进度）。无正在播放的歌曲则忽略。
export function applyQualityChange() {
  const song = store.queue[store.currentIndex]
  if (!song) return
  const audio = getAudio()
  const t = audio.currentTime || 0
  const wasPlaying = !audio.paused
  startAudio(song)
  const onMeta = () => {
    try { audio.currentTime = t } catch (e) {}
    if (wasPlaying) audio.play().catch(() => {})
    audio.removeEventListener('loadedmetadata', onMeta)
  }
  audio.addEventListener('loadedmetadata', onMeta)
  const label = (QUALITY_OPTIONS.find((q) => q.value === store.currentQuality) || {}).label || store.currentQuality
  showSnackbar(`音质已切换为 ${label}`)
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
  // 停止后无歌曲播放，迷你播放条封面回退到插件图标
  const pbCover = document.getElementById('pbCover')
  if (pbCover) { pbCover.onerror = null; pbCover.src = PLUGIN_ICON }
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
