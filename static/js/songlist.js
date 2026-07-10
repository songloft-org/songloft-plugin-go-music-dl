// songlist.js — 歌曲卡片渲染、检测与换源
import {
  store,
  cardData,
  effectiveQuality,
  sourceLabel,
  FALLBACK_COVER,
  MAX_SWITCH_ROUNDS,
} from './state.js'
import { escapeHtml, formatBitrateBadge, setSongBitrate } from './util.js'
import { normalizeBaseUrl, gmdFetch, switchSource, buildCoverUrl } from './api.js'
import { playSong } from './player.js'
import { toggleSelect, openImportPanel } from './imports.js'

export function songKey(s) {
  return `${s.source || ''}__${(s.id != null ? s.id : '')}`
}

export function setSongStatus(card, kind, text) {
  const el = card.querySelector('.song-status')
  if (!el) return
  el.className = 'song-status status-' + kind
  el.textContent = text
}

export function setCardEnabled(card, enabled) {
  card.querySelectorAll('.song-actions button').forEach((b) => {
    b.disabled = !enabled
  })
  card.classList.toggle('song-dead', !enabled)
}

// 直接调 go-music-dl 的 /inspect（CORS 已开放 *）
// 返回 { valid, bitrate }：valid=true 可播 / false 失效 / null 网络请求错误；bitrate 形如 "320 kbps" 或 "-"
export async function inspectSong(song) {
  const base = normalizeBaseUrl(store.config.baseUrl)
  if (!base) return { valid: null, bitrate: '' }
  // 与 buildStreamUrl 同款：网易云注入音质档位，使列表显示的 bitrate = 实际播放音质
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
    if (!res.ok) return { valid: false, bitrate: '' }
    const j = await res.json()
    return { valid: !!(j && j.valid === true), bitrate: (j && j.bitrate) || '' }
  } catch {
    return { valid: null, bitrate: '' }
  }
}

// 把换到的可播版本同步到卡片 DOM 与队列/卡片数据
export function applySwitchedSong(card, alt) {
  const d = cardData.get(card)
  if (d) {
    d.song = alt
    if (d.index >= 0) store.queue[d.index] = alt
  }
  const t = card.querySelector('.song-title')
  if (t) t.textContent = alt.name || ''
  const sub = card.querySelector('.song-sub')
  if (sub)
    sub.innerHTML = `${escapeHtml(alt.artist)} · ${escapeHtml(
      alt.album || '',
    )} · ${escapeHtml(sourceLabel(alt.source))}`
  const coverImg = card.querySelector('.song-cover')
  if (coverImg && alt.cover) coverImg.src = buildCoverUrl(alt.cover)
}

// 失效后多轮换源（贴合 go-music-dl 的闭环）：每轮换到候选都重新 inspect 验证，
// 仍失效则把 current 设为刚换到的源、换下一个源，直到成功 / 无更多可播源 / 达上限。
export async function switchUntilPlayable(card, song, validByKey) {
  let current = song.source
  let lastAttempted = song
  for (let round = 0; round < MAX_SWITCH_ROUNDS; round++) {
    setSongStatus(
      card,
      'checking',
      round === 0 ? '失效，正在换源…' : `仍失效，再换源 (${round})…`,
    )
    const alt = await switchSource(lastAttempted, { current })
    if (!(alt && typeof alt === 'object')) break // 无更多可播源或网络错误
    const { valid: ok, bitrate } = await inspectSong(alt)
    if (ok === true) {
      applySwitchedSong(card, alt)
      validByKey.set(songKey(song), true)
      setSongStatus(card, 'ok', '已换源 · ' + sourceLabel(alt.source))
      setSongBitrate(card, bitrate)
      setCardEnabled(card, true)
      return
    }
    if (ok === null) {
      // 换源接口本身已校验可播，仅检测端连不上时保守采用，避免误杀
      applySwitchedSong(card, alt)
      validByKey.set(songKey(song), true)
      setSongStatus(
        card,
        'pending',
        '已换源（检测超时）· ' + sourceLabel(alt.source),
      )
      setCardEnabled(card, true)
      return
    }
    // 换到的仍失效，继续换下一个源
    current = alt.source
    lastAttempted = alt
  }
  setSongStatus(card, 'fail', '已失效')
  setCardEnabled(card, false)
}

export async function inspectCard(card, validByKey) {
  const d = cardData.get(card)
  if (!d) return
  const song = d.song
  setSongStatus(card, 'checking', '检测中…')
  const { valid, bitrate } = await inspectSong(song)
  if (valid === null) {
    setSongStatus(card, 'pending', '检测失败')
    return
  }
  if (valid) {
    validByKey.set(songKey(song), true)
    setSongStatus(card, 'ok', '可播放')
    setSongBitrate(card, bitrate)
    setCardEnabled(card, true)
    return
  }
  // 失效：本页已有同一首的可播版本则直接标记，不再换源（优先保留可播版本）
  if (validByKey.has(songKey(song))) {
    setSongStatus(card, 'fail', '已失效（本页有可播版本）')
    setCardEnabled(card, false)
    return
  }
  // 失效：多轮换源（每轮换到都重新检测，仍失效则换下一个源，贴合 go-music-dl 闭环）
  await switchUntilPlayable(card, song, validByKey)
}

// 渲染完搜索结果后逐卡错峰检测（80ms/张），避免一次性打爆 go-music-dl 与上游
export function scheduleInspect(list) {
  if (!store.config.baseUrl) return
  const validByKey = new Map()
  Array.from(list.children).forEach((card, i) => {
    setTimeout(() => inspectCard(card, validByKey), i * 80)
  })
}

export function renderSong(s, index, opts = {}) {
  const showImport = opts.showImport !== false && !store.selectMode
  const card = document.createElement('div')
  card.className = 'song-row'
  cardData.set(card, { song: s, index })
  const cover = buildCoverUrl(s.cover) || FALLBACK_COVER
  const key = songKey(s)
  const sel = store.selectMode && store.selectedSongs.has(key)
  const checkHtml = store.selectMode
    ? `<div class="song-check" data-act="check"><span class="song-check-box${sel ? ' checked' : ''}">${sel ? '✓' : ''}</span></div>`
    : ''
  const importBtnHtml = showImport
    ? `<button class="song-more-btn" data-act="dl" title="导入" aria-label="导入">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/>
        </svg>
      </button>`
    : ''
  card.innerHTML = `
    ${checkHtml}
    <img src="${cover}" class="song-cover" referrerpolicy="no-referrer" onerror="this.src='${FALLBACK_COVER}'">
    <div class="song-meta">
      <div class="song-title">${escapeHtml(s.name)}</div>
      <div class="song-sub">${escapeHtml(s.artist)} · ${escapeHtml(s.album || '')} · ${escapeHtml(sourceLabel(s.source))}</div>
      <div class="song-tags">
        <span class="song-status status-pending">待检测</span>
        <span class="song-bitrate" style="display:none;"></span>
      </div>
    </div>
    <div class="song-actions">
      ${importBtnHtml}
    </div>`
  if (store.selectMode) card.classList.toggle('selected', sel)
  const checkEl = card.querySelector('[data-act="check"]')
  if (checkEl)
    checkEl.onclick = (e) => {
      e.stopPropagation()
      e.preventDefault()
      toggleSelect(s, card)
    }
  const dlBtn = card.querySelector('[data-act="dl"]')
  if (dlBtn)
    dlBtn.onclick = (e) => {
      e.stopPropagation()
      e.preventDefault()
      const d = cardData.get(card)
      if (d) openImportPanel(d.song, dlBtn)
    }
  // 点击整行：多选模式下切换勾选；否则直接播放
  card.onclick = () => {
    if (store.selectMode) {
      toggleSelect(s, card)
      return
    }
    const d = cardData.get(card)
    if (d) playSong(d.song, d.index)
  }
  return card
}
