// fullscreen.js — 全屏播放器控制
import { store } from './state.js'
import { syncProgress, getAudio } from './player.js'
import { showSnackbar } from './util.js'

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
    // 投放模式：静音映射到音箱全局音量（本地 <audio> 不出声，无可 mute）
    if (store.cast.connected && store.castHooks) {
      store.castHooks.toggleMute()
      return
    }
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
    // 投放模式：MiNA 云端无 seek 命令，禁用拖动（可用暂停/重播当前曲替代）
    if (store.cast.connected) {
      showSnackbar('投放模式下不支持拖动进度（音箱不支持 seek）')
      return
    }
    const audio = getAudio()
    if (!audio.duration) return
    const rect = track.getBoundingClientRect()
    const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1)
    audio.currentTime = ratio * audio.duration
  })
}
