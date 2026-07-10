// playlists.js — 我的歌单、歌单/专辑详情
import {
  store,
  ALL_SOURCES,
  sourceLabel,
  FALLBACK_COVER,
  PLUGIN_ICON,
} from './state.js'
import { escapeHtml } from './util.js'
import { normalizeBaseUrl, gmdFetch, isNetworkError, buildCoverUrl } from './api.js'
import { renderSong, scheduleInspect } from './songlist.js'
import { importCollectionAsPlaylist } from './imports.js'

// 解析 /music/user_playlists 返回的 HTML：
// 优先读卡片内「导入本地」按钮的 data-external-id / data-source（显式属性，无 & 转义问题）；
// 兜底再用 onclick 里的 detailURL 正则取 id/source（部分 WebView 不解码 &amp; 会导致正则失效）。
export function parsePlaylists(html) {
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
export function diagnoseUserPlaylists(html) {
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
export function parsePlaylistSongs(html) {
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

export function renderPlaylistRow(pl) {
  const card = document.createElement('div')
  card.className = 'playlist-card'
  const cover = buildCoverUrl(pl.cover) || PLUGIN_ICON
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
export function buildPlaylistCats() {
  const bar = document.getElementById('myPlaylistCats')
  if (!bar) return
  const present = []
  const seen = new Set()
  for (const s of ALL_SOURCES) {
    if (store.allPlaylists.some((p) => p.source === s) && !seen.has(s)) {
      present.push(s)
      seen.add(s)
    }
  }
  store.allPlaylists.forEach((p) => {
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
    chip.className = 'mylist-cat' + (c.key === store.currentCat ? ' active' : '')
    chip.textContent = c.label
    chip.onclick = () => {
      store.currentCat = c.key
      buildPlaylistCats()
      renderPlaylistsByCat()
    }
    bar.appendChild(chip)
  })
}

// 按当前选中分类过滤并渲染歌单列表
export function renderPlaylistsByCat() {
  const listEl = document.getElementById('myPlaylistList')
  if (!listEl) return
  const list =
    store.currentCat === 'all'
      ? store.allPlaylists
      : store.allPlaylists.filter((p) => p.source === store.currentCat)
  if (!list.length) {
    listEl.innerHTML = '<div class="empty-state">该分类下暂无歌单</div>'
    return
  }
  listEl.innerHTML = ''
  list.forEach((pl) => listEl.appendChild(renderPlaylistRow(pl)))
}

export async function loadUserPlaylists() {
  const base = normalizeBaseUrl(store.config.baseUrl)
  const listEl = document.getElementById('myPlaylistList')
  if (!base) {
    listEl.innerHTML = '<div class="empty-state">请先在「插件设置」中填写 go-music-dl 服务地址</div>'
    return
  }
  listEl.innerHTML = '<div class="empty-state">加载中…</div>'
  try {
    const sources = (store.config.sources && store.config.sources.length) ? store.config.sources : ALL_SOURCES
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
    store.allPlaylists = playlists
    store.currentCat = 'all'
    buildPlaylistCats()
    renderPlaylistsByCat()
    store.myListLoaded = true
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
export async function openCollection(pl, endpoint, showImport) {
  store.songsBackToMyList = !!document
    .getElementById('tab-mylist')
    .classList.contains('active')
  document.getElementById('myPlaylistView').style.display = 'none'
  document.getElementById('mySongsView').style.display = 'block'
  document.getElementById('mySongsTitle').textContent =
    pl.title || (endpoint === 'album' ? '专辑歌曲' : '歌单歌曲')
  // 歌单/专辑详情页一键导入为 Songloft 歌单：复用当前详情页的歌曲队列
  const importBtn = document.getElementById('importCollectionBtn')
  if (importBtn) importBtn.onclick = () => importCollectionAsPlaylist(pl, store.queue)
  const listEl = document.getElementById('mySongsList')
  listEl.innerHTML = '<div class="empty-state">加载中…</div>'
  const base = normalizeBaseUrl(store.config.baseUrl)
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
    store.queue = songs
    listEl.innerHTML = ''
    songs.forEach((s, i) => listEl.appendChild(renderSong(s, i, { showImport })))
    scheduleInspect(listEl)
  } catch (e) {
    listEl.innerHTML = `<div class="empty-state">加载失败: ${escapeHtml(e.message)}</div>`
  }
}

export async function openPlaylist(pl) {
  return openCollection(pl, 'playlist', true)
}

export async function openAlbum(pl) {
  return openCollection(pl, 'album', true)
}

export function backToPlaylists() {
  document.getElementById('mySongsView').style.display = 'none'
  if (store.songsBackToMyList) {
    document.getElementById('myPlaylistView').style.display = 'block'
  }
}
