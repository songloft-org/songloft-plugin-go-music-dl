// persist.js — 播放状态持久化（localStorage）
// 目标：页面刷新/重开后恢复上次播放的队列、当前歌曲与进度（恢复为暂停态，不自动出声）。
// 注意：插件页与宿主及所有其他插件同源，共享同一份 localStorage，
// 键名必须带 gmd- 前缀避免冲突；所有读写包 try/catch，存储不可用时静默降级，
// 绝不影响正常播放。
import { store } from './state.js'

const STATE_KEY = 'gmd-playback-state' // 队列 + 当前索引（切歌时写全量）
const PROGRESS_KEY = 'gmd-playback-progress' // 当前曲播放进度（节流写，带歌曲标识防串位）
const VERSION = 1
// 持久化队列上限：超出时以当前曲为中心截窗口（保证恢复后上一首/下一首仍可用），
// 防止 extra 很大的队列（百首级）逼近 localStorage 配额。
const MAX_PERSIST_QUEUE = 200

function songKeyOf(s) {
  return `${s.source || ''}__${s.id != null ? s.id : ''}`
}

function isValidSong(s) {
  return !!(s && s.id && s.source)
}

function readJson(key) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const val = JSON.parse(raw)
    // 带版本号：结构升级后旧数据直接丢弃，避免按旧结构恢复出错
    return val && val.v === VERSION ? val : null
  } catch {
    return null
  }
}

function writeJson(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val))
  } catch {
    /* 隐私模式/配额满：放弃持久化 */
  }
}

// 全量保存播放队列与当前索引。换源后 store.queue 已是换源结果，序列化即保留。
export function savePlaybackState() {
  const cur = store.queue[store.currentIndex]
  if (!isValidSong(cur)) return
  let queue = store.queue.filter(isValidSong)
  let index = queue.indexOf(cur) // filter 保留对象引用，indexOf 即原索引的校正位
  if (index < 0) return
  if (queue.length > MAX_PERSIST_QUEUE) {
    const start = Math.max(
      0,
      Math.min(
        index - Math.floor(MAX_PERSIST_QUEUE / 2),
        queue.length - MAX_PERSIST_QUEUE,
      ),
    )
    queue = queue.slice(start, start + MAX_PERSIST_QUEUE)
    index -= start
  }
  writeJson(STATE_KEY, { v: VERSION, queue, currentIndex: index })
}

// 保存当前曲进度。携带歌曲标识，恢复时校验，避免切歌瞬间的旧进度串到新歌上。
export function savePlaybackProgress(position) {
  const cur = store.queue[store.currentIndex]
  if (!isValidSong(cur) || !(position > 0)) return
  writeJson(PROGRESS_KEY, {
    v: VERSION,
    key: songKeyOf(cur),
    position: Math.floor(position),
  })
}

// 读取上次播放快照 { queue, currentIndex, position }；无有效数据返回 null
export function loadPlaybackSnapshot() {
  const st = readJson(STATE_KEY)
  if (!st || !Array.isArray(st.queue) || !st.queue.length) return null
  const idx = Number(st.currentIndex)
  if (!(idx >= 0 && idx < st.queue.length)) return null
  const song = st.queue[idx]
  if (!isValidSong(song)) return null
  const prog = readJson(PROGRESS_KEY)
  const position =
    prog && prog.key === songKeyOf(song) && Number(prog.position) > 0
      ? Number(prog.position)
      : 0
  return { queue: st.queue, currentIndex: idx, position }
}

// 队列播完自动停止（stopPlay）后调用：与「暂无播放」UI 保持一致，不留恢复入口
export function clearPlaybackState() {
  try {
    localStorage.removeItem(STATE_KEY)
    localStorage.removeItem(PROGRESS_KEY)
  } catch {
    /* ignore */
  }
}

// 绑定进度节流保存与页面收尾 flush。audio 由调用方传入，避免 persist ↔ player 循环依赖。
export function initPlaybackPersist(audio) {
  let lastSave = 0
  audio.addEventListener('timeupdate', () => {
    const now = Date.now()
    if (audio.paused || !(audio.currentTime > 0)) return
    if (now - lastSave < 5000) return
    lastSave = now
    savePlaybackProgress(audio.currentTime)
  })
  // 暂停时立刻存一次：timeupdate 节流间隔内可能丢最后一次位置
  audio.addEventListener('pause', () => {
    if (audio.currentTime > 0) savePlaybackProgress(audio.currentTime)
  })
  // WebView 里刷新/销毁不一定触发 beforeunload，pagehide + visibilitychange 才是可靠收尾时机
  const flush = () => {
    if (audio.currentTime > 0) savePlaybackProgress(audio.currentTime)
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flush()
  })
  window.addEventListener('pagehide', flush)
}
