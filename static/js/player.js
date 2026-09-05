// player.js — 播放队列 + 音频 + 进度
import {
  store,
  effectiveQuality,
  FALLBACK_COVER,
} from './state.js'
import { normalizeBaseUrl, buildCoverUrl, gmdFetch } from './api.js'
import { fmtTime, formatBitrateBadge } from './util.js'
import { loadLyrics, highlightLyric } from './lyrics.js'
import {
  savePlaybackState,
  loadPlaybackSnapshot,
  clearPlaybackState,
} from './persist.js'

// 恢复态待续播：{ position }。刷新恢复后首次点播放时取流并 seek 到该进度；
// 期间不给 <audio> 赋 src，避免每次刷新都白发一次 go-music-dl 取流请求。
let pendingResume = null

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
  pendingResume = null // 正常切歌后恢复态作废，避免残留标记被误用
  savePlaybackState()
  startAudio(song)
}

// 真正给 <audio> 赋值并播放。retry 时通过 _r 参数绕开网关对 404/504 的缓存。
// seekTo：恢复续播用——元数据就绪后再 seek，流式音频就绪前设置 currentTime 无效。
export function startAudio(song, retry, seekTo) {
  const audio = getAudio()
  let url = buildStreamUrl(song)
  if (retry) url += (url.includes('?') ? '&' : '?') + '_r=' + retry
  audio.src = url
  audio.load()
  updateNowPlaying(song, song.cover || '')
  if (typeof seekTo === 'number' && seekTo > 0) {
    const onMeta = () => {
      audio.removeEventListener('loadedmetadata', onMeta)
      audio.removeEventListener('error', onErr)
      try {
        // 元数据时长比保存进度短（时长数据不准）时钳到结尾前，避免 seek 越界触发 ended
        const d = audio.duration
        const target =
          Number.isFinite(d) && d > 0 ? Math.min(seekTo, Math.max(0, d - 0.5)) : seekTo
        audio.currentTime = target
      } catch {
        /* ignore */
      }
    }
    const onErr = () => audio.removeEventListener('loadedmetadata', onMeta)
    audio.addEventListener('loadedmetadata', onMeta)
    audio.addEventListener('error', onErr)
  }
  audio.play().catch(() => {})
}

// 恢复态首次播放：取流并续到上次进度，此后走正常播放路径
export function resumeRestored() {
  const song = store.queue[store.currentIndex]
  if (!song) return
  const pos = pendingResume ? pendingResume.position : 0
  pendingResume = null
  startAudio(song, 0, pos)
}

// 刷新/重开后恢复上次播放：队列与索引写回 store，迷你播放条恢复上次歌曲与进度（暂停态）。
// 不自动出声（WebView 自动播放策略 + 体验），不加载音频 src；歌词与比特率徽标
// 延到首次播放时由 startAudio → updateNowPlaying 正常加载。
export function restoreLastPlayback() {
  const snap = loadPlaybackSnapshot()
  if (!snap) return false
  const song = snap.queue[snap.currentIndex]
  if (!song) return false
  store.queue = snap.queue
  store.currentIndex = snap.currentIndex
  pendingResume = { position: snap.position }
  // 元数据 UI（与 updateNowPlaying 同款渲染，但不触发歌词/比特率请求）
  const pbTitle = document.getElementById('pbTitle')
  const pbArtist = document.getElementById('pbArtist')
  const fpTitle = document.getElementById('fpSongTitle')
  const fpArtist = document.getElementById('fpSongArtist')
  if (pbTitle) pbTitle.textContent = song.name || '未知歌曲'
  if (pbArtist) pbArtist.textContent = song.artist || '-'
  if (fpTitle) fpTitle.textContent = song.name || '未知歌曲'
  if (fpArtist) fpArtist.textContent = song.artist || '-'
  const coverUrl = song.cover ? buildCoverUrl(song.cover) : ''
  if (coverUrl) {
    const pbCover = document.getElementById('pbCover')
    const fpCover = document.getElementById('fpCoverImg')
    const bg = document.getElementById('fpBgImage')
    if (pbCover) {
      pbCover.onerror = () => { pbCover.src = FALLBACK_COVER }
      pbCover.src = coverUrl
    }
    if (fpCover) {
      fpCover.onerror = () => { fpCover.removeAttribute('src') }
      fpCover.src = coverUrl
    }
    if (bg) bg.style.backgroundImage = `url("${coverUrl}")`
  }
  // 进度条静态渲染：音频未加载，用持久化 position + 元数据 duration
  const dur = Number(song.duration) || 0
  const pct = dur > 0 ? Math.min((snap.position / dur) * 100, 100) : 0
  setBar('pbFill', 'pbThumb', pct)
  setBar('fpProgressFill', 'fpProgressThumb', pct)
  const cs = fmtTime(snap.position)
  const ts = fmtTime(dur)
  const setText = (id, v) => {
    const el = document.getElementById(id)
    if (el) el.textContent = v
  }
  setText('pbCurrent', cs)
  setText('pbTotal', ts)
  setText('fpCurrentTime', cs)
  setText('fpTotalTime', ts)
  setPlayIcon(false)
  return true
}

export function togglePlay() {
  const audio = getAudio()
  if (!audio.src) {
    // 恢复态：无 src 但有待续播歌曲，首次点播放取流并续到上次进度
    if (pendingResume) resumeRestored()
    return
  }
  if (audio.paused) audio.play().catch(() => {})
  else audio.pause()
}

export function stopPlay() {
  const audio = getAudio()
  audio.pause()
  audio.currentTime = 0
  setPlayIcon(false)
  syncProgress()
  // 队列播完自动停止：清掉持久化状态，与「暂无播放」UI 保持一致（不留恢复入口）
  clearPlaybackState()
  pendingResume = null
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
