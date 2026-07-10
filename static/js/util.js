// util.js — 纯 UI 工具函数（依赖 DOM，不依赖业务模块）
let snackbarTimer = null
// showSnackbar(msg, sticky, type)
//  - sticky=true：不自动消失，用于「导入中/换源中」等进行态，并在文字前显示旋转指示
//  - type：'success' | 'error' | 'warning'，用于配色（不传则默认中性色）
export function showSnackbar(msg, sticky, type) {
  const el = document.getElementById('snackbar')
  if (!el) return
  // 未显式指定 type 且非进行态时，按消息语义自动推断配色
  if (!type && !sticky) {
    if (/失败|错误|无法|出错|失效/.test(msg)) type = 'error'
    else if (/已导入|已保存|已在|已添加|成功/.test(msg)) type = 'success'
  }
  const cls = ['snackbar', 'show']
  if (type) cls.push(type)
  el.className = cls.join(' ')
  if (sticky) {
    // 进行态：spinner + 文本（文本用 textContent 防注入）
    el.innerHTML = '<span class="snackbar-spinner" aria-hidden="true"></span><span class="snackbar-text"></span>'
    el.querySelector('.snackbar-text').textContent = msg
  } else {
    el.textContent = msg
  }
  if (snackbarTimer) clearTimeout(snackbarTimer)
  if (!sticky) {
    snackbarTimer = setTimeout(() => {
      el.className = 'snackbar'
    }, 2500)
  }
}
export function hideSnackbar() {
  if (snackbarTimer) clearTimeout(snackbarTimer)
  const el = document.getElementById('snackbar')
  if (el) el.className = 'snackbar'
}

export function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  )
}

export function fmtTime(sec) {
  if (!sec || sec < 0 || isNaN(sec)) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return m + ':' + (s < 10 ? '0' : '') + s
}

// 把 "320 kbps" 归一为简洁徽标文案；无有效值返回空串
export function formatBitrateBadge(bitrate) {
  if (!bitrate || bitrate === '-') return ''
  const m = String(bitrate).match(/(\d+)/)
  if (!m) return ''
  const kbps = parseInt(m[1], 10)
  if (!kbps) return ''
  if (kbps >= 1000) return 'Hi-Res'
  if (kbps >= 800) return '无损'
  return `${kbps} kbps`
}

// 在卡片上显示/更新音质徽标
export function setSongBitrate(card, bitrate) {
  const el = card.querySelector('.song-bitrate')
  if (!el) return
  const text = formatBitrateBadge(bitrate)
  if (text) {
    el.textContent = text
    el.style.display = 'inline-block'
  } else {
    el.textContent = ''
    el.style.display = 'none'
  }
}
