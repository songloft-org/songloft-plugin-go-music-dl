// playlists.js — 我的歌单、歌单/专辑详情
import {
  store,
  ALL_SOURCES,
  sourceLabel,
  FALLBACK_COVER,
  PLUGIN_ICON,
} from './state.js'
import { escapeHtml, showSnackbar } from './util.js'
import {
  normalizeBaseUrl,
  gmdFetch,
  isNetworkError,
  buildCoverUrl,
  friendlyError,
} from './api.js'
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
    // 数量可能不可信：go-music-dl 在「我的歌单」列表里 TrackCount 经常为 0，
    // 其原生 UI 用「进入查看」回避（模板 {{ if gt .TrackCount 0 }}）。这里只提取
    // 数字；无数字（如「进入查看」）或 0 都视为未知，由渲染层显示中性文案，
    // 避免误导显示「共 0 首」。
    const countEl = card.querySelector('.playlist-count')
    const countText = countEl ? countEl.textContent : ''
    const countM = countText.match(/(\d+)/)
    const count = countM ? countM[1] : ''
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

// 解析歌单/专辑详情页 HTML 中的分页摘要（与 go-music-dl 网页端 page-summary 格式一致）：
// 「当前第 {page} / {totalPages} 页，显示 {pageStart} - {pageEnd} / {total}」
export function parsePagination(html) {
  const m = html.match(
    /当前第\s*(\d+)\s*\/\s*(\d+)\s*页，显示\s*(\d+)\s*-\s*(\d+)\s*\/\s*(\d+)/,
  )
  if (m) {
    return {
      page: Number(m[1]) || 1,
      totalPages: Number(m[2]) || 1,
      pageStart: Number(m[3]) || 0,
      pageEnd: Number(m[4]) || 0,
      total: Number(m[5]) || 0,
    }
  }
  // 摘要未渲染（单页歌单，renderIndex 在 totalPages=1 时不输出 page-summary）
  return { page: 1, totalPages: 1, pageStart: 0, pageEnd: 0, total: 0 }
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
      <div class="playlist-sub">${escapeHtml(pl.creator) || '未知'} · ${pl.count && Number(pl.count) > 0 ? `共 ${escapeHtml(pl.count)} 首` : '进入查看'}</div>
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
    const count =
      c.key === 'all'
        ? store.allPlaylists.length
        : store.allPlaylists.filter((p) => p.source === c.key).length
    const chip = document.createElement('button')
    chip.className = 'mylist-cat' + (c.key === store.currentCat ? ' active' : '')
    chip.textContent = `${c.label} · ${count}`
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
// 当前歌单/专辑详情上下文，供翻页按钮复用（翻页时不再依赖参数层层传递）
let currentCollection = null

export async function openCollection(pl, endpoint, showImport, page = 1) {
  store.songsBackToMyList = !!document
    .getElementById('tab-mylist')
    .classList.contains('active')
  currentCollection = { pl, endpoint, showImport }
  document.getElementById('myPlaylistView').style.display = 'none'
  document.getElementById('mySongsView').style.display = 'block'
  document.getElementById('mySongsTitle').textContent =
    pl.title || (endpoint === 'album' ? '专辑歌曲' : '歌单歌曲')
  const listEl = document.getElementById('mySongsList')
  hideCollectionPager()
  hideCollectionHeader()
  listEl.innerHTML = '<div class="empty-state">加载中…</div>'
  const base = normalizeBaseUrl(store.config.baseUrl)
  if (!base) {
    listEl.innerHTML = '<div class="empty-state">未配置服务地址</div>'
    return
  }
  try {
    // 歌单/专辑详情页同样按 go-music-dl 的 WebPageSize（默认 30）分页，只传 page，
    // 每页渲染约 30 首，避免一次渲染过多歌曲导致页面卡顿（与搜索页行为一致）。
    const url =
      `${base}/${endpoint}?id=${encodeURIComponent(pl.id)}` +
      `&source=${encodeURIComponent(pl.source)}&page=${page}`
    const res = await gmdFetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
    if (!res.ok) {
      listEl.innerHTML = `<div class="empty-state">加载失败: HTTP ${res.status}</div>`
      return
    }
    const html = await res.text()
    const songs = parsePlaylistSongs(html)
    const pagination = parsePagination(html)
    renderCollectionHeader(html)
    if (!songs.length) {
      listEl.innerHTML = `<div class="empty-state">该${endpoint === 'album' ? '专辑' : '歌单'}暂无歌曲</div>`
      return
    }
    store.queue = songs
    listEl.innerHTML = ''
    const start = pagination ? pagination.pageStart : 1
    songs.forEach((s, i) => listEl.appendChild(renderSong(s, i, { showImport, startIndex: start })))
    scheduleInspect(listEl)
    renderCollectionPagination(pagination)
    // 翻页后滚动回列表顶部，避免停留在上一页底部
    if (page > 1) listEl.scrollIntoView({ behavior: 'smooth', block: 'start' })
  } catch (e) {
    listEl.innerHTML = `<div class="empty-state">加载失败: ${escapeHtml(e.message)}</div>`
  }
}

// 隐藏歌单/专辑详情翻页条
function hideCollectionPager() {
  const pager = document.getElementById('collectionPager')
  if (pager) pager.style.display = 'none'
}

// 隐藏歌单/专辑详情头部摘要
function hideCollectionHeader() {
  const el = document.getElementById('mySongsSummary')
  if (el) el.style.display = 'none'
}

// 渲染歌单/专辑详情头部摘要（对齐 go-music-dl 原生 .list-header）：
// 「共 X 首」+「当前第 x / x 页，显示 x - x / x」。
// 原生头部还含排序控件与导入按钮，那部分已由 overlay-bar 的「导入歌单」承担，
// 此处只补充歌曲数量与分页摘要，避免标题重复。
function renderCollectionHeader(html) {
  const el = document.getElementById('mySongsSummary')
  if (!el) return
  const h = parseCollectionHeader(html)
  if (!h) {
    el.style.display = 'none'
    return
  }
  const m = h.countText.match(/共\s*(\d+)\s*首/)
  const lines = []
  if (m) lines.push(`<div style="font-size:14px;font-weight:600;">共 ${m[1]} 首</div>`)
  if (h.summaryText)
    lines.push(`<div class="page-summary" style="padding-top:0;">${escapeHtml(h.summaryText)}</div>`)
  if (!lines.length) {
    el.style.display = 'none'
    return
  }
  el.innerHTML = lines.join('')
  el.style.display = 'block'
}

// 解析 /playlist、/album 返回的 .list-header（对齐 go-music-dl 原生 song_list 头部）：
// result-count（共 X 首所在文本）+ page-summary（分页摘要）
function parseCollectionHeader(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const header = doc.querySelector('.list-header')
  if (!header) return null
  const countEl = header.querySelector('.result-count')
  const countText = countEl ? countEl.textContent.replace(/\s+/g, ' ').trim() : ''
  const summaryEl = header.querySelector('.page-summary')
  const summaryText = summaryEl ? summaryEl.textContent.replace(/\s+/g, ' ').trim() : ''
  return { countText, summaryText }
}

// 渲染歌单/专辑详情翻页条（与搜索页分页 UI 一致），单页或解析失败时隐藏
function renderCollectionPagination(p) {
  const pager = document.getElementById('collectionPager')
  if (!pager) return
  if (!p || !p.total || p.totalPages <= 1) {
    hideCollectionPager()
    return
  }
  pager.innerHTML = ''
  const prev = document.createElement('button')
  prev.type = 'button'
  prev.className = 'ctrl-btn primary'
  prev.innerHTML = '‹ 上一页'
  prev.disabled = p.page <= 1
  prev.onclick = () =>
    currentCollection &&
    openCollection(
      currentCollection.pl,
      currentCollection.endpoint,
      currentCollection.showImport,
      p.page - 1,
    )

  const text = document.createElement('span')
  text.className = 'pagination-text'
  text.textContent = `第 ${p.page} / ${p.totalPages} 页`

  const next = document.createElement('button')
  next.type = 'button'
  next.className = 'ctrl-btn primary'
  next.innerHTML = '下一页 ›'
  next.disabled = p.page >= p.totalPages
  next.onclick = () =>
    currentCollection &&
    openCollection(
      currentCollection.pl,
      currentCollection.endpoint,
      currentCollection.showImport,
      p.page + 1,
    )

  pager.appendChild(prev)
  pager.appendChild(text)
  pager.appendChild(next)
  pager.style.display = 'flex'
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

// 抓取歌单/专辑的全部歌曲（跨分页，最多 100 页防异常死循环），
// 复用详情页同款解析逻辑，供「整张导入」入口一次性拿到全量 songs。
async function loadAllCollectionSongs(pl, endpoint) {
  const base = normalizeBaseUrl(store.config.baseUrl)
  if (!base) return []
  const all = []
  let page = 1
  for (let guard = 0; guard < 100; guard++) {
    const url =
      `${base}/${endpoint}?id=${encodeURIComponent(pl.id)}` +
      `&source=${encodeURIComponent(pl.source)}&page=${page}`
    let html
    try {
      const res = await gmdFetch(url, {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      })
      if (!res.ok) break
      html = await res.text()
    } catch (e) {
      break
    }
    const songs = parsePlaylistSongs(html)
    if (!songs.length) break
    all.push(...songs)
    const p = parsePagination(html)
    if (!p || !p.totalPages || p.page >= p.totalPages) break
    page++
  }
  return all
}

// 歌单详情页「导入歌单」入口：读取整张歌单（全部分页）后，
// 走 importCollectionAsPlaylist（已优化为抽样校验 + 一次性批量写），把整张歌单秒级导入。
export async function importEntireCollection() {
  if (!currentCollection) return
  const { pl, endpoint } = currentCollection
  try {
    showSnackbar('正在读取歌单全部歌曲…', true)
    const songs = await loadAllCollectionSongs(pl, endpoint)
    if (!songs.length) {
      showSnackbar('歌单没有可导入的歌曲')
      return
    }
    // importCollectionAsPlaylist 内部已管理导入锁，直接委托即可
    await importCollectionAsPlaylist(pl, songs)
  } catch (e) {
    showSnackbar(friendlyError(e, '导入失败'))
  }
}
