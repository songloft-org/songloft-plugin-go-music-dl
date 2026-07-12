// lyrics.js — 歌词解析与渲染
import { store } from './state.js'
import { fetchAuth } from './api.js'

export function parseLrc(text) {
  if (!text) return []
  const out = []
  const timeRe = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
  for (const line of text.split(/\r?\n/)) {
    timeRe.lastIndex = 0
    const times = []
    let m
    while ((m = timeRe.exec(line))) {
      const min = parseInt(m[1], 10)
      const sec = parseInt(m[2], 10)
      const frac = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) : 0
      times.push(min * 60 + sec + frac / 1000)
    }
    if (!times.length) continue
    const txt = line.replace(timeRe, '').trim()
    for (const t of times) out.push({ time: t, text: txt })
  }
  out.sort((a, b) => a.time - b.time)
  return out
}

export function renderLyrics(lines) {
  const c = document.getElementById('fpLyricsContainer')
  if (!c) return
  store.lastLyricIndex = -1
  if (!lines || !lines.length) {
    c.innerHTML = '<div class="fp-lyrics-empty">暂无歌词</div>'
    return
  }
  c.innerHTML = ''
  lines.forEach((l) => {
    const d = document.createElement('div')
    d.className = 'fp-lyric-line'
    d.textContent = l.text || '...'
    c.appendChild(d)
  })
}

export function highlightLyric(t) {
  if (!store.fpLyrics.length) return
  let idx = -1
  for (let i = 0; i < store.fpLyrics.length; i++) {
    if (store.fpLyrics[i].time <= t) idx = i
    else break
  }
  if (idx === store.lastLyricIndex) return
  store.lastLyricIndex = idx
  const els = document.querySelectorAll('#fpLyricsContainer .fp-lyric-line')
  els.forEach((el) => el.classList.remove('active'))
  if (idx >= 0 && els[idx]) {
    els[idx].classList.add('active')
    els[idx].scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
  // 同步迷你播放条歌词行（对齐 miot：播放时显示当前歌词）
  const pbLyric = document.getElementById('pbLyric')
  if (pbLyric) {
    const text = idx >= 0 && store.fpLyrics[idx] ? store.fpLyrics[idx].text : ''
    pbLyric.textContent = text ? text : '暂无歌词'
  }
}

export function loadLyrics(song) {
  store.fpLyrics = []
  store.lastLyricIndex = -1
  renderLyrics([])
  // 迷你条歌词行复位为「暂无歌词」，待歌词加载后由 highlightLyric 更新
  const pbLyric = document.getElementById('pbLyric')
  if (pbLyric) pbLyric.textContent = '暂无歌词'
  const p = new URLSearchParams({
    id: song.id,
    source: song.source,
    name: song.name || '',
    artist: song.artist || '',
    album: song.album || '',
    duration: song.duration || 0,
    extra: JSON.stringify(song.extra || {}),
  })
  fetchAuth('./api/lyric?' + p.toString())
    .then((j) => {
      store.fpLyrics = parseLrc(j && j.lyric ? j.lyric : '')
      renderLyrics(store.fpLyrics)
    })
    .catch(() => {})
}
