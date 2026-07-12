// discover.js — 「发现」页：每日推荐 + 分类歌单。
// 直接复用 go-music-dl 的 /recommend、/playlist_categories、/category_playlists，
// 并用 playlists.js 现有的 parsePlaylists / renderPlaylistRow 渲染（点卡片即可进详情+导入）。
import {
  store,
  ALL_SOURCES,
  sourceLabel,
} from './state.js'
import { normalizeBaseUrl, gmdFetch, isNetworkError } from './api.js'
import { escapeHtml } from './util.js'
import { parsePlaylists, renderPlaylistRow } from './playlists.js'

// 分类数据：{ sources: [{ source, name, groups: [{ name, categories: [{ name, query }] }] }] }
let catData = null

function base() {
  return normalizeBaseUrl(store.config.baseUrl)
}

function empty(el, msg) {
  if (el) el.innerHTML = `<div class="empty-state">${escapeHtml(msg)}</div>`
}

function activeSources() {
  return store.config.sources && store.config.sources.length
    ? store.config.sources
    : ALL_SOURCES
}

function fetchText(path, params) {
  const b = base()
  return gmdFetch(`${b}${path}?${params}`, {
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  })
}

// ---------- 每日推荐（支持平台筛选：选平台后显示对应歌单，对齐 go-music-dl 原生 tab） ----------
export async function loadDiscoverRecommend() {
  const b = base()
  const listEl = document.getElementById('discoverRecommendList')
  const catsEl = document.getElementById('discoverRecommendCats')
  if (!b) {
    empty(listEl, '请先在「插件设置」中填写 go-music-dl 服务地址')
    if (catsEl) catsEl.innerHTML = ''
    return
  }
  empty(listEl, '加载中…')
  if (catsEl) catsEl.innerHTML = ''
  try {
    const params = 'sources=' + activeSources().map(encodeURIComponent).join('&sources=')
    const res = await fetchText('/recommend', params)
    if (res.status === 401) {
      empty(listEl, 'go-music-dl 启用了登录鉴权，请改用无需鉴权的地址')
      return
    }
    if (!res.ok) {
      empty(listEl, `加载失败: HTTP ${res.status}`)
      return
    }
    const playlists = parsePlaylists(await res.text())
    if (!playlists.length) {
      empty(listEl, '暂无推荐歌单（可能该音源不支持，或未登录）')
      return
    }
    store.discoverRecommendPlaylists = playlists
    store.discoverRecommendCat = 'all'
    buildDiscoverRecommendCats()
    renderDiscoverRecommendByCat()
    store.discoverRecommendLoaded = true
  } catch (e) {
    empty(
      listEl,
      isNetworkError(e) ? '无法连接服务，请检查 go-music-dl 是否启动' : e.message,
    )
  }
}

// 按实际出现的音源构建「全部 + 各平台」筛选条
function buildDiscoverRecommendCats() {
  const bar = document.getElementById('discoverRecommendCats')
  if (!bar) return
  const present = []
  const seen = new Set()
  for (const s of ALL_SOURCES) {
    if (store.discoverRecommendPlaylists.some((p) => p.source === s) && !seen.has(s)) {
      present.push(s)
      seen.add(s)
    }
  }
  store.discoverRecommendPlaylists.forEach((p) => {
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
        ? store.discoverRecommendPlaylists.length
        : store.discoverRecommendPlaylists.filter((p) => p.source === c.key).length
    const chip = document.createElement('button')
    chip.className = 'mylist-cat' + (c.key === store.discoverRecommendCat ? ' active' : '')
    chip.textContent = `${c.label} · ${count}`
    chip.onclick = () => {
      store.discoverRecommendCat = c.key
      buildDiscoverRecommendCats()
      renderDiscoverRecommendByCat()
    }
    bar.appendChild(chip)
  })
}

// 按当前选中平台过滤并渲染推荐歌单
function renderDiscoverRecommendByCat() {
  const listEl = document.getElementById('discoverRecommendList')
  if (!listEl) return
  const list =
    store.discoverRecommendCat === 'all'
      ? store.discoverRecommendPlaylists
      : store.discoverRecommendPlaylists.filter((p) => p.source === store.discoverRecommendCat)
  if (!list.length) {
    listEl.innerHTML = '<div class="empty-state">该平台暂无推荐歌单</div>'
    return
  }
  listEl.innerHTML = ''
  list.forEach((pl) => listEl.appendChild(renderPlaylistRow(pl)))
}

// ---------- 分类歌单 ----------
export async function loadDiscoverCategories() {
  const b = base()
  const chipsEl = document.getElementById('discoverCatChips')
  const gridEl = document.getElementById('discoverCatPlaylists')
  if (!b) {
    empty(chipsEl, '请先在「插件设置」中填写 go-music-dl 服务地址')
    return
  }
  empty(chipsEl, '加载中…')
  if (gridEl) gridEl.innerHTML = '<div class="empty-state">选择上方分类查看歌单</div>'
  try {
    const params = 'sources=' + activeSources().map(encodeURIComponent).join('&sources=')
    const res = await fetchText('/playlist_categories', params)
    if (!res.ok) {
      empty(chipsEl, `加载失败: HTTP ${res.status}`)
      return
    }
    catData = parseCategories(await res.text())
    if (!catData || !catData.sources.length) {
      empty(chipsEl, '暂无可用歌单分类（可能该音源不支持分类）')
      return
    }
    renderCategorySources()
    store.discoverCatsLoaded = true
  } catch (e) {
    empty(
      chipsEl,
      isNetworkError(e) ? '无法连接服务，请检查 go-music-dl 是否启动' : e.message,
    )
  }
}

// 解析 playlist_categories 返回的 HTML：
// 每个 .category-source-panel 的 id 形如 category-panel-{source}，内含若干
// .category-group > .category-chip[href]；href 的查询段含 source/category_id/category_name。
function parseCategories(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const sources = []
  doc.querySelectorAll('.category-source-panel').forEach((panel) => {
    const source = (panel.id || '').replace('category-panel-', '')
    if (!source) return
    const groups = []
    panel.querySelectorAll('.category-group').forEach((g) => {
      const gname = g.querySelector('.category-group-title')
        ? g.querySelector('.category-group-title').textContent.trim()
        : ''
      const categories = []
      g.querySelectorAll('.category-chip').forEach((chip) => {
        const name = chip.querySelector('.category-chip-name')
          ? chip.querySelector('.category-chip-name').textContent.trim()
          : ''
        // 用 a 元素解析相对 href，取查询段（与 host 无关），拼回 base 即可
        const tmp = document.createElement('a')
        tmp.href = chip.getAttribute('href') || ''
        const q = tmp.search || ''
        if (name && q) categories.push({ name, query: q, source })
      })
      if (categories.length) groups.push({ name: gname, categories })
    })
    if (groups.length) {
      sources.push({ source, name: sourceLabel(source) || source, groups })
    }
  })
  return { sources }
}

function renderCategorySources() {
  const bar = document.getElementById('discoverCatSources')
  if (!bar || !catData) return
  bar.innerHTML = ''
  catData.sources.forEach((s, i) => {
    const chip = document.createElement('button')
    chip.className = 'mylist-cat' + (i === 0 ? ' active' : '')
    chip.textContent = s.name
    chip.onclick = () => {
      bar.querySelectorAll('.mylist-cat').forEach((c) => c.classList.remove('active'))
      chip.classList.add('active')
      renderCategoryChips(s)
    }
    bar.appendChild(chip)
  })
  renderCategoryChips(catData.sources[0])
}

function renderCategoryChips(src) {
  const chipsEl = document.getElementById('discoverCatChips')
  if (!chipsEl) return
  chipsEl.innerHTML = ''
  src.groups.forEach((g) => {
    const title = document.createElement('div')
    title.className = 'cat-group-title'
    title.textContent = g.name
    chipsEl.appendChild(title)
    const wrap = document.createElement('div')
    wrap.className = 'mylist-cats'
    wrap.style.padding = '2px 0 10px'
    g.categories.forEach((c) => {
      const chip = document.createElement('button')
      chip.className = 'mylist-cat'
      chip.textContent = c.name
      chip.onclick = () => {
        // 高亮当前选中的分类，清除其他分类 chip 的 active
        chipsEl
          .querySelectorAll('.mylist-cat')
          .forEach((c2) => c2.classList.remove('active'))
        chip.classList.add('active')
        openCategory(c)
      }
      wrap.appendChild(chip)
    })
    chipsEl.appendChild(wrap)
  })
}

async function openCategory(cat) {
  const b = base()
  const gridEl = document.getElementById('discoverCatPlaylists')
  const headerEl = document.getElementById('discoverCatHeader')
  if (!b || !gridEl) return
  gridEl.innerHTML = '<div class="empty-state">加载中…</div>'
  if (headerEl) headerEl.innerHTML = ''
  try {
    const res = await gmdFetch(`${b}/category_playlists${cat.query}`, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
    if (!res.ok) {
      gridEl.innerHTML = `<div class="empty-state">加载失败: HTTP ${res.status}</div>`
      return
    }
    const html = await res.text()
    // 渲染 go-music-dl 原生头部摘要：标题 + 找到 x 个歌单 + 分页
    // （对齐原生 playlist_grid.html 的 .list-header，避免只丢卡片而丢摘要）
    if (headerEl) {
      const h = parseCategoryHeader(html)
      const title = `${sourceLabel(cat.source) || cat.source} · ${cat.name}`
      const lines = []
      if (h && h.countText)
        lines.push(`<div class="page-summary" style="padding-top:0;">${escapeHtml(h.countText)}</div>`)
      if (h && h.summaryText)
        lines.push(`<div class="page-summary">${escapeHtml(h.summaryText)}</div>`)
      headerEl.innerHTML = `<div style="font-size:15px;font-weight:600;margin-bottom:4px;">${escapeHtml(title)}</div>${lines.join('')}`
    }
    const playlists = parsePlaylists(html)
    if (!playlists.length) {
      gridEl.innerHTML = '<div class="empty-state">该分类暂无歌单</div>'
      return
    }
    gridEl.innerHTML = ''
    playlists.forEach((pl) => gridEl.appendChild(renderPlaylistRow(pl)))
  } catch (e) {
    gridEl.innerHTML = `<div class="empty-state">${
      isNetworkError(e) ? '无法连接服务' : escapeHtml(e.message)
    }</div>`
  }
}

// 解析 /category_playlists 返回的 .list-header（对齐 go-music-dl 原生 playlist_grid 头部）：
// 「找到 x 个歌单」+「当前第 x / x 页，显示 1 - 30 / x」
function parseCategoryHeader(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const header = doc.querySelector('.list-header')
  if (!header) return null
  const countEl = header.querySelector('.result-count')
  const countText = countEl
    ? countEl.textContent.replace(/\s+/g, ' ').trim()
    : ''
  const summaryEl = header.querySelector('.page-summary')
  const summaryText = summaryEl
    ? summaryEl.textContent.replace(/\s+/g, ' ').trim()
    : ''
  return { countText, summaryText }
}
