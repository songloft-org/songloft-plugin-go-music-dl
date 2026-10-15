// qrcode.js — 内置二维码生成器（canvas 绘制）。
// 算法与 go-music-dl 网页端内嵌实现一致（byte 模式、EC level M、版本 1-6、mask 0），
// 覆盖扫码登录 URL（含超长的汽水/网易链接）绰绰有余且无外部依赖（离线可用）。
// 独立模块：与上游 app.js 不共享文件（插件 WebView 无法引用 gmd 静态资源）。

const VERSION_SPECS = [
  null,
  { data: 19, ecc: 7, blocks: 1, align: [] },
  { data: 34, ecc: 10, blocks: 1, align: [6, 18] },
  { data: 55, ecc: 15, blocks: 1, align: [6, 22] },
  { data: 80, ecc: 20, blocks: 1, align: [6, 26] },
  { data: 108, ecc: 26, blocks: 1, align: [6, 30] },
  { data: 136, ecc: 18, blocks: 2, align: [6, 34] },
]

function utf8Bytes(text) {
  if (window.TextEncoder) return Array.from(new TextEncoder().encode(text))
  return Array.from(unescape(encodeURIComponent(text)), (ch) => ch.charCodeAt(0))
}

function appendBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i--) bits.push(((value >>> i) & 1) !== 0)
}

function pickVersion(byteLength) {
  for (let v = 1; v < VERSION_SPECS.length; v++) {
    if (byteLength <= Math.floor((VERSION_SPECS[v].data * 8 - 12) / 8)) return v
  }
  throw new Error('二维码内容过长')
}

function gfMul(x, y) {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = ((z << 1) ^ ((z >>> 7) * 0x11d)) & 0xff
    if (((y >>> i) & 1) !== 0) z ^= x
  }
  return z
}

function rsGenerator(degree) {
  const result = new Array(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root)
      if (j + 1 < degree) result[j] ^= result[j + 1]
    }
    root = gfMul(root, 2)
  }
  return result
}

function rsRemainder(data, generator) {
  const result = new Array(generator.length).fill(0)
  data.forEach((value) => {
    const factor = value ^ result.shift()
    result.push(0)
    for (let i = 0; i < result.length; i++) result[i] ^= gfMul(generator[i], factor)
  })
  return result
}

function codewords(text) {
  const bytes = utf8Bytes(text)
  const version = pickVersion(bytes.length)
  const spec = VERSION_SPECS[version]
  const bits = []
  appendBits(bits, 0x4, 4)
  appendBits(bits, bytes.length, 8)
  bytes.forEach((v) => appendBits(bits, v, 8))
  const maxBits = spec.data * 8
  if (bits.length > maxBits) throw new Error('二维码内容过长')
  for (let i = 0, n = Math.min(4, maxBits - bits.length); i < n; i++) bits.push(false)
  while (bits.length % 8 !== 0) bits.push(false)
  const data = []
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0
    for (let j = 0; j < 8; j++) value = (value << 1) | (bits[i + j] ? 1 : 0)
    data.push(value)
  }
  for (let pad = 0xec; data.length < spec.data; pad ^= 0xfd) data.push(pad)
  const generator = rsGenerator(spec.ecc)
  const blockLen = spec.data / spec.blocks
  const blocks = []
  for (let i = 0; i < spec.blocks; i++) {
    const block = data.slice(i * blockLen, (i + 1) * blockLen)
    blocks.push({ data: block, ecc: rsRemainder(block, generator) })
  }
  const result = []
  for (let i = 0; i < blockLen; i++) blocks.forEach((b) => result.push(b.data[i]))
  for (let i = 0; i < spec.ecc; i++) blocks.forEach((b) => result.push(b.ecc[i]))
  return { version, codewords: result }
}

function setModule(qr, x, y, dark, fixed = false) {
  if (x < 0 || y < 0 || x >= qr.size || y >= qr.size) return
  qr.modules[y][x] = !!dark
  if (fixed) qr.fixed[y][x] = true
}

function addFinder(qr, cx, cy) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy))
      setModule(qr, cx + dx, cy + dy, dist !== 2 && dist !== 4, true)
    }
  }
}

function addAlignment(qr, cx, cy) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy))
      setModule(qr, cx + dx, cy + dy, dist === 0 || dist === 2, true)
    }
  }
}

// EC level M（01）+ mask 0 的格式位，含 BCH 纠错与掩码 0x5412
function formatBits(mask) {
  const data = (1 << 3) | mask
  let bits = data << 10
  for (let i = 14; i >= 10; i--) {
    if (((bits >>> i) & 1) !== 0) bits ^= 0x537 << (i - 10)
  }
  return ((data << 10) | (bits & 0x3ff)) ^ 0x5412
}

function placeFormat(qr, mask) {
  const bits = formatBits(mask)
  const n = qr.size
  for (let i = 0; i <= 5; i++) setModule(qr, 8, i, ((bits >>> i) & 1) !== 0, true)
  setModule(qr, 8, 7, ((bits >>> 6) & 1) !== 0, true)
  setModule(qr, 8, 8, ((bits >>> 7) & 1) !== 0, true)
  setModule(qr, 7, 8, ((bits >>> 8) & 1) !== 0, true)
  for (let i = 9; i < 15; i++) setModule(qr, 14 - i, 8, ((bits >>> i) & 1) !== 0, true)
  for (let i = 0; i < 8; i++) setModule(qr, n - 1 - i, 8, ((bits >>> i) & 1) !== 0, true)
  for (let i = 8; i < 15; i++) setModule(qr, 8, n - 15 + i, ((bits >>> i) & 1) !== 0, true)
  setModule(qr, 8, n - 8, true, true)
}

/** 生成二维码模块矩阵 { size, modules }（modules[y][x] = 是否为暗模块） */
export function buildQRMatrix(text) {
  const { version, codewords: cw } = codewords(text)
  const size = 17 + version * 4
  const qr = {
    size,
    modules: Array.from({ length: size }, () => new Array(size).fill(false)),
    fixed: Array.from({ length: size }, () => new Array(size).fill(false)),
  }
  addFinder(qr, 3, 3)
  addFinder(qr, size - 4, 3)
  addFinder(qr, 3, size - 4)
  for (let i = 8; i < size - 8; i++) {
    setModule(qr, i, 6, i % 2 === 0, true)
    setModule(qr, 6, i, i % 2 === 0, true)
  }
  VERSION_SPECS[version].align.forEach((cy) => {
    VERSION_SPECS[version].align.forEach((cx) => {
      if (!qr.fixed[cy][cx]) addAlignment(qr, cx, cy)
    })
  })
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      setModule(qr, 8, i, false, true)
      setModule(qr, i, 8, false, true)
    }
  }
  for (let i = 0; i < 8; i++) setModule(qr, size - 1 - i, 8, false, true)
  for (let i = 0; i < 7; i++) setModule(qr, 8, size - 1 - i, false, true)
  setModule(qr, 8, size - 8, true, true)
  const bits = []
  cw.forEach((v) => appendBits(bits, v, 8))
  let bitIndex = 0
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right--
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert
      for (let j = 0; j < 2; j++) {
        const x = right - j
        if (qr.fixed[y][x]) continue
        let dark = bitIndex < bits.length ? bits[bitIndex] : false
        bitIndex++
        if ((x + y) % 2 === 0) dark = !dark
        setModule(qr, x, y, dark, false)
      }
    }
    upward = !upward
  }
  placeFormat(qr, 0)
  return qr
}

/** 把二维码画到 canvas（白底深色模块，自适应 devicePixelRatio） */
export function drawQRToCanvas(text, canvas, logicalSize = 220) {
  const qr = buildQRMatrix(text)
  const dpr = Math.max(1, window.devicePixelRatio || 1)
  canvas.width = logicalSize * dpr
  canvas.height = logicalSize * dpr
  canvas.style.width = logicalSize + 'px'
  canvas.style.height = logicalSize + 'px'
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, logicalSize, logicalSize)
  const border = 4
  const scale = Math.max(1, Math.floor(logicalSize / (qr.size + border * 2)))
  const offset =
    Math.floor((logicalSize - (qr.size + border * 2) * scale) / 2) + border * scale
  ctx.fillStyle = '#0f172a'
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y][x]) ctx.fillRect(offset + x * scale, offset + y * scale, scale, scale)
    }
  }
}
