// imports.js — 导入到歌单对话框、多选与批量导入
import {
  store,
  MAX_SWITCH_ROUNDS,
} from './state.js'
import { showSnackbar, escapeHtml } from './util.js'
import {
  Host,
  API,
  classifyError,
  friendlyError,
  switchSource,
  ERR_NETWORK,
  ERR_AUTH,
  ERR_SOURCE,
} from './api.js'
import { renderSong, scheduleInspect, songKey } from './songlist.js'

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

export function openImportPanel(song, anchor) {
  store.pendingImportItem = song
  // 单首导入：退出批量模式
  store.batchImport = false
  store.batchList = []
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

export function onImportPanelOutside(e) {
  const panel = document.getElementById('importPlaylistPanel')
  if (panel && panel.classList.contains('show') && !panel.contains(e.target)) {
    closeImportPanel()
  }
}
export function onImportPanelEsc(e) {
  if (e.key === 'Escape') closeImportPanel()
}

export function closeImportPanel() {
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

export async function loadImportPlaylists() {
  const listEl = document.getElementById('importPlaylistList')
  if (!listEl) return
  listEl.innerHTML = '<div class="empty-state">加载中…</div>'
  try {
    const result = await Host.playlists.list()
    store.importPlaylists =
      Array.isArray(result) ? result : (result && result.playlists) || []
    renderImportPlaylistList()
  } catch (e) {
    if (listEl) listEl.innerHTML = `<div class="empty-state">歌单加载失败：${escapeHtml(friendlyError(e, '加载失败'))}</div>`
  }
}

function renderImportPlaylistList() {
  const listEl = document.getElementById('importPlaylistList')
  if (!listEl) return
  const playlists = store.importPlaylists || []
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
export async function importSongToLibrary(song) {
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
          if (store.pendingImportItem && store.pendingImportItem === song) store.pendingImportItem = alt
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
  return importSongToLibrary(store.pendingImportItem)
}

export async function importToLibrary() {
  // 批量模式：整批导入到曲库
  if (store.batchImport && store.batchList.length) {
    await batchImportToLibrary()
    return
  }
  if (!store.pendingImportItem) return
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

export async function importToPlaylist(playlistId) {
  // 批量模式：整批导入到指定歌单
  if (store.batchImport && store.batchList.length) {
    await batchImportToPlaylist(playlistId)
    return
  }
  if (!store.pendingImportItem) return
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

export function createNewPlaylist() {
  // 批量模式下无需 pendingImportItem
  if (!store.batchImport && !store.pendingImportItem) return
  closeImportPanel()
  const dialog = document.getElementById('newPlaylistDialog')
  const backdrop = document.getElementById('newPlaylistBackdrop')
  const input = document.getElementById('newPlaylistName')
  if (!dialog || !backdrop) return
  store.newPlaylistCallback = async (name) => {
    if (!beginImport()) return
    try {
      const playlist = await Host.playlists.create({ name: name, type: 'normal' })
      if (!playlist || !playlist.id) {
        showSnackbar('创建歌单失败')
        return
      }
      // 批量模式：把整批歌曲导入新建歌单
      if (store.batchImport && store.batchList.length) {
        showSnackbar('正在导入到曲库…', true)
        const { ok, skipped, failed, failHint } = await addSongsBatchToPlaylist(
          playlist.id,
          [...store.batchList],
        )
        const existed = store.importPlaylists.some(
          (p) => p && String(p.id) === String(playlist.id),
        )
        if (!existed) store.importPlaylists.push(playlist)
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
      const existed = store.importPlaylists.some(
        (p) => p && String(p.id) === String(playlist.id),
      )
      if (!existed) store.importPlaylists.push(playlist)
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

export function closeNewPlaylistDialog() {
  const dialog = document.getElementById('newPlaylistDialog')
  const backdrop = document.getElementById('newPlaylistBackdrop')
  if (dialog) dialog.classList.remove('show')
  if (backdrop) backdrop.style.display = 'none'
  store.newPlaylistCallback = null
}

export async function confirmNewPlaylist() {
  const input = document.getElementById('newPlaylistName')
  const name = (input && input.value ? input.value : '').trim()
  if (!name) {
    showSnackbar('请输入歌单名称')
    return
  }
  const cb = store.newPlaylistCallback
  closeNewPlaylistDialog()
  if (cb) await cb(name)
}

// ---------- 多选 / 批量导入 ----------

export function toggleSelect(s, card) {
  const key = songKey(s)
  if (store.selectedSongs.has(key)) store.selectedSongs.delete(key)
  else store.selectedSongs.set(key, s)
  const on = store.selectedSongs.has(key)
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

export function updateBatchBar() {
  const bar = document.getElementById('batchBar')
  if (!bar) return
  const n = store.selectedSongs.size
  bar.style.display = n > 0 ? 'flex' : 'none'
  const countEl = document.getElementById('batchCount')
  if (countEl) countEl.textContent = `已选 ${n} 首`
}

export function setSelectMode(on) {
  store.selectMode = on
  const btn = document.getElementById('batchToggleBtn')
  if (btn) {
    btn.textContent = on ? '完成' : '多选'
    btn.classList.toggle('active', on)
  }
  if (!on) {
    store.selectedSongs.clear()
    store.batchImport = false
    store.batchList = []
    updateBatchBar()
  }
  // 重新渲染当前搜索结果，切换勾选框显隐（仅单曲结果需要，歌单/专辑不涉及）
  if (store.currentSearchType === 'song') {
    const list = document.getElementById('browserList')
    if (list && store.queue.length) {
      list.innerHTML = ''
      store.queue.forEach((s, i) => list.appendChild(renderSong(s, i)))
      scheduleInspect(list)
    }
  }
}

export function exitBatchMode() {
  store.selectedSongs.clear()
  store.batchImport = false
  store.batchList = []
  updateBatchBar()
}

export function openImportPanelForBatch() {
  if (!store.selectedSongs.size) return
  store.batchImport = true
  store.batchList = [...store.selectedSongs.values()]
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
  const songs = [...store.batchList]
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
  const songs = [...store.batchList]
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
