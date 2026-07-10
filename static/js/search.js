// search.js — 搜索、每日推荐与浏览器首页
import { store, ALL_SOURCES, sourceLabel } from './state.js'
import { escapeHtml } from './util.js'
import {
  API,
  normalizeBaseUrl,
  gmdFetch,
  isNetworkError,
  friendlyError,
} from './api.js'
import { renderSong, scheduleInspect } from './songlist.js'
import { parsePlaylists, renderPlaylistRow } from './playlists.js'
import { setSelectMode } from './imports.js'

export async function doSearch() {
  const q = document.getElementById('searchInput').value.trim()
  if (!q) return
  const list = document.getElementById('browserList')
  list.innerHTML = '<div class="empty-state">搜索中...</div>'
  document.getElementById('recommendCard').style.display = 'none'
  document.getElementById('listCard').style.display = 'block'
  try {
    const data = await API.search(q, store.currentSearchType)
    if (!Array.isArray(data) || data.length === 0) {
      list.innerHTML = '<div class="empty-state">未找到结果</div>'
      return
    }
    if (store.currentSearchType === 'song') {
      store.queue = data
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
export async function loadRecommend() {
  const base = normalizeBaseUrl(store.config.baseUrl)
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
    const sources = (store.config.sources && store.config.sources.length) ? store.config.sources : ALL_SOURCES
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
    store.recommendPlaylists = playlists
    store.recommendCat = 'all'
    buildRecommendCats()
    renderRecommendByCat()
    store.recommendLoaded = true
  } catch (e) {
    if (isNetworkError(e)) {
      listEl.innerHTML = '<div class="empty-state">无法连接到服务地址，请检查 go-music-dl 服务是否启动、地址是否正确，或在「插件设置」中点击「测试连接」。</div>'
    } else {
      listEl.innerHTML = `<div class="empty-state">推荐加载失败：${escapeHtml(friendlyError(e, '加载失败'))}</div>`
    }
  }
}

// 按实际出现的音源构建「全部 + 各平台」筛选条
export function buildRecommendCats() {
  const bar = document.getElementById('recommendCats')
  if (!bar) return
  const present = []
  const seen = new Set()
  for (const s of ALL_SOURCES) {
    if (store.recommendPlaylists.some((p) => p.source === s) && !seen.has(s)) {
      present.push(s)
      seen.add(s)
    }
  }
  store.recommendPlaylists.forEach((p) => {
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
    chip.className = 'mylist-cat' + (c.key === store.recommendCat ? ' active' : '')
    chip.textContent = c.label
    chip.onclick = () => {
      store.recommendCat = c.key
      buildRecommendCats()
      renderRecommendByCat()
    }
    bar.appendChild(chip)
  })
}

// 按当前选中平台过滤并渲染推荐歌单
export function renderRecommendByCat() {
  const listEl = document.getElementById('recommendList')
  if (!listEl) return
  const list =
    store.recommendCat === 'all'
      ? store.recommendPlaylists
      : store.recommendPlaylists.filter((p) => p.source === store.recommendCat)
  if (!list.length) {
    listEl.innerHTML = '<div class="empty-state">该平台暂无推荐歌单</div>'
    return
  }
  listEl.innerHTML = ''
  list.forEach((pl) => listEl.appendChild(renderPlaylistRow(pl)))
}

// 切换到搜索首页：未搜索时显示推荐歌单，已搜索则保留结果列表
export function showBrowserHome() {
  const recommendCard = document.getElementById('recommendCard')
  const listCard = document.getElementById('listCard')
  if (listCard.style.display === 'block') return // 已有搜索结果，保持不变
  listCard.style.display = 'none'
  recommendCard.style.display = 'block'
  if (!store.recommendLoaded) loadRecommend()
}

// 搜索结果页「返回首页」：收起结果列表、清空关键词，回到每日推荐视图（无需刷新整页）
export function backToBrowserHome() {
  if (store.selectMode) setSelectMode(false) // 退出多选，避免批量操作栏残留
  const input = document.getElementById('searchInput')
  if (input) input.value = ''
  document.getElementById('listCard').style.display = 'none'
  document.getElementById('recommendCard').style.display = 'block'
  if (!store.recommendLoaded) loadRecommend()
}
