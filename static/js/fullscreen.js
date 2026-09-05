// fullscreen.js — 全屏播放器控制
import { store } from './state.js'
import { syncProgress, getAudio } from './player.js'

export function openFullscreenPlayer() {
  const el = document.getElementById('fullscreenPlayer')
  if (!el || store.isFpOpen) return
  store.isFpOpen = true
  el.classList.add('open')
  document.body.style.overflow = 'hidden'
  const cur = store.queue[store.currentIndex]
  syncProgress()
}

export function closeFullscreenPlayer() {
  const el = document.getElementById('fullscreenPlayer')
  if (!el || !store.isFpOpen) return
  store.isFpOpen = false
  el.classList.remove('open')
  document.body.style.overflow = ''
}

// 音量控制：顶栏喇叭按钮点击直接切换静音，图标随状态切换 volume_off / volume_up。
export function initVolumeControl() {
  const btn = document.getElementById('fpVolumeBtn')
  const icon = document.getElementById('fpVolumeIcon')
  if (!btn || !icon) return
  const audio = getAudio()

  function updateIcon() {
    icon.textContent = audio.muted || audio.volume === 0 ? 'volume_off' : 'volume_up'
  }

  btn.addEventListener('click', () => {
    audio.muted = !audio.muted
    updateIcon()
  })
  audio.addEventListener('volumechange', updateIcon)
  updateIcon()
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
