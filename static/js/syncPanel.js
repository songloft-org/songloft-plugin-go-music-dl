// syncPanel.js — 歌单同步面板：手动同步 go-music-dl 已登录账号的歌单到 Songloft
// 交互：打开面板 → 列出账号歌单（复用 parsePlaylists 解析 /user_playlists HTML）
//       → 勾选（全选 / 仅未同步快捷键）→ 串行逐张调用后端 POST /sync/run。
// 同步引擎与绑定存储在后端 src/sync.ts（增量 diff + 幂等入库，重试即续传），
// 本模块只负责「选歌单 + 触发 + 进度展示」，不持有同步状态。
import { store, sourceLabel, FALLBACK_COVER, PLUGIN_ICON, ALL_SOURCES } from './state.js'
import { escapeHtml, showSnackbar } from './util.js'
import {
  API,
  normalizeBaseUrl,
  gmdFetch,
  friendlyError,
  buildCoverUrl,
} from './api.js'
import { parsePlaylists } from './playlists.js'

let panelItems = [] // [{ key, source, id, name, cover, checked, binding }]
let syncing = false
let escBound = false
let currentSourceFilter = 'all' // 'all' 或具体 source key，随「我的歌单」当前分类联动
let bodyOverflow = ''

function base() {
  return normalizeBaseUrl(store.config.baseUrl)
}

function fmtDateTime(ts) {
  const d = new Date(ts)
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// 绑定状态一行文案
function bindingLine(it) {
  const b = it.binding
  if (!b) return '<span class="sync-state none">未同步</span>'
  const when = b.lastSyncAt ? fmtDateTime(b.lastSyncAt) : ''
  const statusCls =
    b.lastStatus === 'failed'
      ? 'fail'
      : b.lastStatus === 'partial'
        ? 'partial'
        : 'ok'
  const statusText =
    b.lastStatus === 'failed'
      ? '上次失败'
      : b.lastStatus === 'partial'
        ? '上次未完成，可再同步续传'
        : '已绑定'
  const added = b.lastAdded > 0 ? ` · 新增 ${b.lastAdded} 首` : ''
  return (
    `<span class="sync-state ${statusCls}">${statusText}</span>` +
    (when ? ` · ${when}${added}` : '') +
    (b.lastError ? ` · ${escapeHtml(b.lastError)}` : '')
  )
}

// ---------- 打开 / 关闭 ----------
// 用插件自有 .dialog-overlay + .dialog 体系（fixed 遮罩 + flex 居中），
// 不依赖宿主注入的 dialog 样式；点遮罩空白处关闭（target === overlay），
// 面板内部点击不经过该分支，天然无误关。

let _opening = false
export async function openSyncPanel() {
  if (_opening || syncing) return
  _opening = true
  try {
    const overlay = document.getElementById('syncOverlay')
    if (!overlay) return
    currentSourceFilter = store.currentCat || 'all'
    setSyncDesc()
    bodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    overlay.classList.add('show')
    bindEsc()
    await loadPanel()
  } finally {
    _opening = false
  }
}

export function closeSyncPanel() {
  if (syncing) {
    // 同步进行中不关闭：中断会让「哪张完成/哪张未完成」变模糊（幂等可重试，但提示更清晰）
    showSnackbar('正在同步中，请等待本轮完成…', true)
    return
  }
  const overlay = document.getElementById('syncOverlay')
  if (overlay) overlay.classList.remove('show')
  unbindEsc()
  document.body.style.overflow = bodyOverflow
}

function setSyncDesc() {
  const el = document.querySelector('#syncOverlay .sync-desc')
  if (!el) return
  if (currentSourceFilter && currentSourceFilter !== 'all') {
    const label = sourceLabel(currentSourceFilter) || currentSourceFilter
    el.textContent = `当前仅显示「${label}」的歌单。把 go-music-dl 已登录账号的歌单同步到 Songloft（首次导入，此后增量更新）。支持网易云 / QQ / 酷狗 / 汽水。`
  } else {
    el.textContent = '把 go-music-dl 已登录账号的歌单同步到 Songloft（首次导入，此后增量更新）。支持网易云 / QQ / 酷狗 / 汽水。'
  }
}

function onOverlayClick(e) {
  // 仅点中遮罩本身（空白区域）才关闭；点 .dialog 卡片内不关
  if (e.target === e.currentTarget) closeSyncPanel()
}
function onPanelEsc(e) {
  if (e.key === 'Escape') closeSyncPanel()
}
function bindEsc() {
  const overlay = document.getElementById('syncOverlay')
  if (!overlay) return
  overlay.onclick = onOverlayClick
  if (!escBound) {
    escBound = true
    document.addEventListener('keydown', onPanelEsc, true)
  }
}
function unbindEsc() {
  escBound = false
  document.removeEventListener('keydown', onPanelEsc, true)
}

// ---------- 数据加载与渲染 ----------

async function loadPanel() {
  const listEl = document.getElementById('syncPlaylistList')
  if (!listEl) return
  if (!base()) {
    listEl.innerHTML =
      '<div class="empty-state">请先在「插件设置」中填写 go-music-dl 服务地址</div>'
    updateRunBtn()
    return
  }
  listEl.innerHTML = '<div class="empty-state">正在获取账号歌单…</div>'
  try {
    // 并行：账号歌单 HTML（前端直连，与「我的歌单」tab 同源）+ 绑定列表（插件后端）
    const sources =
      store.config.sources && store.config.sources.length
        ? store.config.sources
        : ALL_SOURCES
    const qs = sources.map(encodeURIComponent).join('&sources=')
    const url = `${base()}/user_playlists?sources=${qs}`
    const [res, bindRes] = await Promise.all([
      gmdFetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } }),
      API.syncBindings()
        .catch((e) => {
          console.warn('[syncPanel] 获取绑定列表失败:', e)
          showSnackbar('绑定信息加载失败，将显示为未同步状态', true)
          return null
        }),
    ])
    if (res.status === 401) {
      listEl.innerHTML =
        '<div class="empty-state">go-music-dl 启用了登录鉴权，请改用无需鉴权的地址</div>'
      updateRunBtn()
      return
    }
    if (!res.ok) {
      listEl.innerHTML = `<div class="empty-state">加载失败: HTTP ${res.status}</div>`
      updateRunBtn()
      return
    }
    const html = await res.text()
    let remote = parsePlaylists(html)
    if (currentSourceFilter && currentSourceFilter !== 'all') {
      remote = remote.filter((pl) => pl.source === currentSourceFilter)
    }
    if (!remote.length) {
      const emptyMsg =
        currentSourceFilter && currentSourceFilter !== 'all'
          ? `未获取到「${sourceLabel(currentSourceFilter) || currentSourceFilter}」账号歌单`
          : '未获取到账号歌单：请先在 go-music-dl 网页端扫码登录（支持网易云 / QQ / 酷狗 / 汽水），或检查服务地址'
      listEl.innerHTML = `<div class="empty-state">${escapeHtml(emptyMsg)}</div>`
      updateRunBtn()
      return
    }
    const map =
      bindRes && Array.isArray(bindRes.bindings) ? bindRes.bindings : []
    const byKey = new Map(map.map((b) => [`${b.source}__pl__${b.remoteId}`, b]))
    panelItems = remote
      .filter((pl) => pl.contentType !== 'album')
      .map((pl) => ({
        key: `${pl.source}__pl__${pl.id}`,
        source: pl.source,
        id: pl.id,
        name: pl.title || '',
        cover: pl.cover || '',
        checked: false,
        binding: byKey.get(`${pl.source}__pl__${pl.id}`) || null,
      }))
    renderList()
  } catch (e) {
    listEl.innerHTML = `<div class="empty-state">${escapeHtml(
      friendlyError(e, '加载失败'),
    )}</div>`
  }
  updateRunBtn()
}

function renderList() {
  const listEl = document.getElementById('syncPlaylistList')
  if (!listEl) return
  listEl.innerHTML = ''
  panelItems.forEach((it, idx) => {
    const row = document.createElement('label')
    row.className = 'sync-item'
    row.dataset.idx = String(idx)
    const cover = buildCoverUrl(it.cover) || PLUGIN_ICON
    row.innerHTML = `
      <input type="checkbox" ${it.checked ? 'checked' : ''} ${syncing ? 'disabled' : ''}>
      <img class="sync-cover" src="${cover}" referrerpolicy="no-referrer" onerror="this.onerror=null; this.src='${FALLBACK_COVER}'">
      <div class="sync-meta">
        <div class="sync-title">${escapeHtml(it.name || '未命名歌单')}</div>
        <div class="sync-sub" data-role="sub">${bindingLine(it)}</div>
      </div>
      <span class="sync-tag">${escapeHtml(sourceLabel(it.source) || it.source)}</span>`
    const cb = row.querySelector('input[type=checkbox]')
    cb.addEventListener('change', () => {
      it.checked = cb.checked
      updateRunBtn()
    })
    listEl.appendChild(row)
  })
  updateSelCount()
}

// 行内状态更新（同步过程中）；spinner=true 显示进行态
function setItemStatus(it, html, spinner) {
  const row = document.querySelector(
    `.sync-item[data-idx="${panelItems.indexOf(it)}"]`,
  )
  if (!row) return
  const sub = row.querySelector('[data-role="sub"]')
  if (sub)
    sub.innerHTML =
      (spinner
        ? '<span class="snackbar-spinner" aria-hidden="true"></span>'
        : '') + html
}

function updateSelCount() {
  const el = document.getElementById('syncSelCount')
  if (el) el.textContent = `已选 ${panelItems.filter((i) => i.checked).length} 张`
}

function updateRunBtn() {
  const btn = document.getElementById('syncRunBtn')
  if (!btn) return
  const n = panelItems.filter((i) => i.checked).length
  btn.disabled = syncing || !n
  btn.textContent = syncing ? '同步中…' : `开始同步${n ? ` (${n})` : ''}`
  // 全选按钮随勾选状态切换文案（toggle 语义）
  const selAllBtn = document.getElementById('syncSelAllBtn')
  if (selAllBtn)
    selAllBtn.textContent =
      panelItems.length > 0 && panelItems.every((it) => it.checked)
        ? '取消全选'
        : '全选'
}

// ---------- 快捷选择 ----------

export function selectAllSync() {
  if (syncing) return
  // toggle：已全部勾选 → 全不选；否则全选（按钮文案随状态切换，见 updateRunBtn）
  const allChecked =
    panelItems.length > 0 && panelItems.every((it) => it.checked)
  panelItems.forEach((it) => (it.checked = !allChecked))
  renderList()
}

export function selectUnsyncedSync() {
  if (syncing) return
  panelItems.forEach(
    (it) =>
      (it.checked = !it.binding || it.binding.lastStatus !== 'ok'),
  )
  renderList()
}

// ---------- 同步执行：串行逐张（单张失败不阻断后续） ----------

export async function runSync() {
  if (syncing) return
  const selected = panelItems.filter((it) => it.checked)
  if (!selected.length) return
  syncing = true
  updateRunBtn()
  renderCheckboxesDisabled()
  let okCount = 0
  let failCount = 0
  let totalAdded = 0
  let partialCount = 0
  let partialAdded = 0
  for (const it of selected) {
    setItemStatus(it, '同步中…', true)
    try {
      const res = await API.syncRun({
        source: it.source,
        id: it.id,
        name: it.name,
        cover: it.cover,
      })
      const r = (res && res.result) || {}
      const status = r.status || 'failed'
      if (status === 'ok' || status === 'partial') {
        if (status === 'ok') {
          okCount++
          totalAdded += Number(r.added) || 0
        } else {
          partialCount++
          partialAdded += Number(r.added) || 0
        }
        it.binding = {
          source: it.source,
          remoteId: it.id,
          remoteName: it.name,
          remoteCover: it.cover,
          localPlaylistId: r.localPlaylistId,
          lastSyncAt: Date.now(),
          lastAdded: Number(r.added) || 0,
          lastStatus: status,
        }
        if (status === 'ok') {
          setItemStatus(
            it,
            `<span class="sync-state ok">完成</span> · 新增 ${Number(r.added) || 0} 首` +
              (Number(r.dead) ? ` · 失效跳过 ${r.dead}` : ''),
          )
        } else {
          setItemStatus(
            it,
            `<span class="sync-state partial">部分完成</span> · 新增 ${
              Number(r.added) || 0
            } 首 · ${escapeHtml(r.message || '请再点一次同步继续')}`,
          )
        }
      } else {
        failCount++
        it.binding = Object.assign({}, it.binding, {
          lastStatus: 'failed',
          lastError: r.message || '',
        })
        setItemStatus(
          it,
          `<span class="sync-state fail">失败</span> · ${escapeHtml(
            r.message || '未知原因',
          )}`,
        )
      }
    } catch (e) {
      failCount++
      setItemStatus(
        it,
        `<span class="sync-state fail">失败</span> · ${escapeHtml(
          friendlyError(e, '同步失败'),
        )}`,
      )
    }
  }
  syncing = false
  // 重绘恢复 checkbox 可用态并展示最终绑定状态
  renderList()
  updateRunBtn()
  const parts = []
  if (okCount) parts.push(`完成 ${okCount} 张，共新增 ${totalAdded} 首`)
  if (partialCount) parts.push(`部分完成 ${partialCount} 张，共新增 ${partialAdded} 首`)
  if (failCount) parts.push(`失败 ${failCount} 张`)
  const hasIssue = partialCount || failCount
  showSnackbar(
    parts.join('，') + (hasIssue ? '（部分完成/失败原因见各行说明）' : ''),
    undefined,
    failCount ? 'error' : hasIssue ? 'warning' : 'success',
  )
}

function renderCheckboxesDisabled() {
  document
    .querySelectorAll('#syncPlaylistList .sync-item input[type=checkbox]')
    .forEach((cb) => (cb.disabled = true))
}
