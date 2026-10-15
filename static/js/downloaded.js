// downloaded.js — 「已在服务器下载」标记：拉 go-music-dl 下载记录构建匹配键集合，
// 供歌曲列表行内显示徽标（downloaded mark）。记录是增强信息：拉取失败静默降级
// （无徽标），缓存 10min，插件重载后自然重建。
import { API } from './api.js'

const TTL_MS = 10 * 60 * 1000

let marks = null // Record<key, true>，key = name|artist（小写、去空白）
let fetchedAt = 0
let pending = null

function keyOf(name, artist) {
  return `${String(name || '').trim().toLowerCase()}|${String(artist || '').trim().toLowerCase()}`
}

export function isDownloaded(song) {
  if (!marks) return false
  return !!marks[keyOf(song && song.name, song && song.artist)]
}

/** 确保记录已拉取（并发调用共享同一次请求）；失败返回 false 不抛出 */
export async function ensureDownloaded() {
  if (marks && Date.now() - fetchedAt < TTL_MS) return true
  if (pending) return pending
  pending = (async () => {
    try {
      const r = await API.downloadRecords()
      if (r && r.marks && typeof r.marks === 'object') {
        marks = r.marks
        fetchedAt = Date.now()
        return true
      }
    } catch {
      /* 静默降级 */
    }
    return false
  })()
  const ok = await pending
  pending = null
  return ok
}

/** 列表渲染后补挂徽标：Set 未就绪时先拉取，就绪后为命中的行补上标记 */
export async function markListDownloaded(listEl) {
  if (!listEl) return
  const ok = await ensureDownloaded()
  if (!ok || !marks) return
  listEl.querySelectorAll('.song-row').forEach((row) => {
    if (row.querySelector('.song-dl-tag')) return
    const tags = row.querySelector('.song-tags')
    if (!tags) return
    const d = row.__dlKey
    if (d && marks[d]) {
      const span = document.createElement('span')
      span.className = 'song-dl-tag'
      span.textContent = '已下载'
      tags.appendChild(span)
    }
  })
}

/** renderSong 时同步写入行的匹配键（data 属性），供 markListDownloaded 补挂与直接判断 */
export function downloadedKey(song) {
  return keyOf(song && song.name, song && song.artist)
}
