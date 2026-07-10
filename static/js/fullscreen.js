// fullscreen.js — 全屏播放器控制
import { store } from './state.js'
import { refreshQualityControl, syncProgress, getAudio } from './player.js'

export function openFullscreenPlayer() {
  const el = document.getElementById('fullscreenPlayer')
  if (!el || store.isFpOpen) return
  store.isFpOpen = true
  el.classList.add('open')
  document.body.style.overflow = 'hidden'
  const cur = store.queue[store.currentIndex]
  if (cur) refreshQualityControl(cur)
  syncProgress()
}

export function closeFullscreenPlayer() {
  const el = document.getElementById('fullscreenPlayer')
  if (!el || !store.isFpOpen) return
  store.isFpOpen = false
  el.classList.remove('open')
  document.body.style.overflow = ''
}

export function toggleLyricPage() {
  const pages = document.getElementById('fpPages')
  if (!pages) return
  const showLyrics = pages.scrollLeft < pages.clientWidth / 2
  pages.scrollTo({ left: showLyrics ? pages.clientWidth : 0, behavior: 'smooth' })
  const dots = document.querySelectorAll('#fpPageIndicator .fp-dot')
  dots.forEach((d, i) => d.classList.toggle('active', i === (showLyrics ? 1 : 0)))
}

export function bindSeek(trackId) {
  const track = document.getElementById(trackId)
  if (!track) return
  track.addEventListener('click', (e) => {
    const audio = getAudio()
    if (!audio.duration) return
    const rect = track.getBoundingClientRect()
    const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1)
    audio.currentTime = ratio * audio.duration
  })
}
