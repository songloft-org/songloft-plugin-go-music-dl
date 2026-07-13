// api.js — 网络/HTTP 层
import { store } from './state.js'

// go-music-dl 接口都在 /music 前缀下，根地址自动补上，避免拼出 /search 之类 404
export function normalizeBaseUrl(raw) {
  let u = (raw || '').trim().replace(/\/+$/, '')
  if (!u) return ''
  if (!/\/music$/.test(u)) u += '/music'
  return u
}

// 判定 hostname 是否为内网（私有/回环）地址：用于「外网访问自动切换 go-music-dl 地址」
export function isInternalHostname(h) {
  if (!h) return true
  h = String(h).toLowerCase()
  return (
    h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' ||
    /^192\.168\./.test(h) || /^10\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  )
}
// 当前是否以外网方式访问主程序（浏览器 hostname 非内网）
export function isExternalAccess() {
  return !isInternalHostname(location.hostname)
}

// 宿主会把 access_token 注入 localStorage['songloft-auth']，插件 API 需要带 Bearer 头
function getAuthHeaders() {
  const headers = { 'Content-Type': 'application/json' }
  try {
    const raw = localStorage.getItem('songloft-auth')
    if (raw) {
      const auth = JSON.parse(raw)
      if (auth && auth.accessToken) {
        headers['Authorization'] = 'Bearer ' + auth.accessToken
      }
    }
  } catch (e) {}
  return headers
}

export async function fetchAuth(url, opts = {}) {
  const res = await fetch(url, {
    headers: getAuthHeaders(),
    ...opts,
  })
  if (res.status === 401) {
    throw new Error('401 未授权：请刷新插件页面后重试')
  }
  if (!res.ok) {
    // 后端会把真实错误放在 { error: "..." } 里，优先展示它
    let msg = `HTTP ${res.status}`
    try {
      const j = await res.json()
      if (j && j.error) msg = j.error
    } catch (e) {}
    throw new Error(msg)
  }
  return res.json()
}

// 把音源原始封面 CDN 地址转成 go-music-dl 的 /music/cover_proxy 代理地址，
// 规避网易云/QQ 等封面的防盗链 403 裂图（代理在中转时去掉了 Referer 限制）。
// 幂等：已代理地址 / data: / blob: / 空值 直接返回原值，避免重复代理。
export function buildCoverUrl(raw) {
  if (!raw) return ''
  if (/^(data:|blob:)/i.test(raw)) return raw
  const base = normalizeBaseUrl(store.config.baseUrl)
  if (!base) return raw
  if (raw.startsWith(base)) return raw // 已是本实例代理地址
  return `${base}/cover_proxy?url=${encodeURIComponent(raw)}`
}

export const API = {
  config: () => fetchAuth('./config'),
  saveConfig: (cfg) =>
    fetchAuth('./config', { method: 'POST', body: JSON.stringify(cfg) }),
  search: (q, type, page = 1) =>
    fetchAuth(
      `./search?q=${encodeURIComponent(q)}${
        type ? `&type=${encodeURIComponent(type)}` : ''
      }&page=${page}`,
    ),
  import: (item) =>
    fetchAuth('./import', {
      method: 'POST',
      body: JSON.stringify({ item }),
    }),
  // 批量导入：一次请求写整批歌曲（后端抽样校验 + 一次性批量写宿主），
  // 替代逐首串行 /import，把大歌单从「分钟级」压到「秒级」。
  importBatch: (items) =>
    fetchAuth('./import/batch', {
      method: 'POST',
      body: JSON.stringify({ items }),
    }),
}

// 宿主歌单 API：经插件后端代理（/playlists...）调用，避免 common.js 的
// API_BASE='.' 把 /api/v1 拼成相对路径导致 404。插件后端用宿主绝对地址转发。
export const Host = {
  playlists: {
    // 带 _t 防缓存：每次打开面板都拉最新歌单，避免浏览器缓存了创建前的旧列表
    list: () => window.SongloftPlugin.apiGet('/playlists?_t=' + Date.now()),
    create: (playlist) => window.SongloftPlugin.apiPost('/playlists', playlist),
    addSongs: (id, songIds) =>
      window.SongloftPlugin.apiPost(`/playlists/${id}/songs`, {
        song_ids: songIds,
      }),
  },
}

// go-music-dl 是跨域 HTTP 服务；WebView 默认可能附带凭据发起跨域请求，
// 而服务端同时返回 `Access-Control-Allow-Origin: *` 与 `Allow-Credentials: true`，
// 浏览器对「凭据请求 + *」组合会直接拒绝 CORS。显式 credentials:'omit' 让请求变为
// 非凭据，使 * 生效，规避「due to access control checks」报错。
export function gmdFetch(url, opts = {}) {
  return fetch(url, { credentials: 'omit', ...opts })
}

// 判断 fetch 失败是否为网络层错误（地址错误/服务未启动/CORS 等），便于给出友好提示
export function isNetworkError(e) {
  return !!e && (e.name === 'TypeError' || /failed to fetch|network request failed/i.test(e.message || ''))
}

// 失败原因分类：网络 / 鉴权 / 音源失效 / 未知
export const ERR_NETWORK = 'network'
export const ERR_AUTH = 'auth'
export const ERR_SOURCE = 'source'
export const ERR_UNKNOWN = 'unknown'

// 把异常归为四类之一，并返回原始 detail（后端真实错误信息），供上层拼装友好文案
export function classifyError(e) {
  const msg = e && e.message ? String(e.message) : ''
  const name = (e && e.name) || ''
  // 1) 鉴权失效：401 未授权 / 登录态过期 / cookie 失效
  if (/401|未授权|未登录|登录失效|鉴权|token|cookie/i.test(msg) || name === 'AuthError') {
    return { category: ERR_AUTH, detail: msg }
  }
  // 2) 音源失效：后端明确告知音源不可用 / 已下架
  if (/音源已失效|资源已失效|链接失效|已下架|无可用音源|版权/i.test(msg)) {
    return { category: ERR_SOURCE, detail: msg }
  }
  // 3) 网络层：fetch 抛 TypeError（CORS/地址错/服务未启）、超时/Abort
  if (isNetworkError(e) || name === 'AbortError' || /timeout|超时|aborted/i.test(msg)) {
    return { category: ERR_NETWORK, detail: msg }
  }
  return { category: ERR_UNKNOWN, detail: msg }
}

// 把错误转成「带分类 + 修复建议」的友好文案，统一失败提示口径
export function friendlyError(e, fallback) {
  const { category, detail } = classifyError(e)
  const tail = detail ? `（${detail}）` : ''
  switch (category) {
    case ERR_NETWORK:
      return `网络异常，无法连接服务${tail}请检查服务地址是否正确、go-music-dl 是否已启动`
    case ERR_AUTH:
      return `鉴权失效${tail}请刷新插件页面后重试`
    case ERR_SOURCE:
      return `音源失效，该音源已不可用${tail}已自动尝试换源`
    default:
      return (fallback || '操作失败') + tail
  }
}

// 轻量探测服务是否可达：GET 带结尾斜杠的 /music/ 地址，避免裸 /music 触发 301
// 重定向（重定向响应无 CORS 头会被浏览器拦截）；带 4s 超时。
export async function probeService(base) {
  const norm = normalizeBaseUrl(base)
  if (!norm) return { ok: false }
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 4000)
    const res = await gmdFetch(norm + '/', {
      method: 'GET',
      signal: ctrl.signal,
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
    clearTimeout(timer)
    return { ok: true, status: res.status }
  } catch (e) {
    return { ok: false }
  }
}

export function setConnStatus(text, kind) {
  const el = document.getElementById('connStatus')
  if (!el) return
  el.textContent = text
  el.className = 'conn-status ' + (kind || '')
}

// 设置页「测试连接」：内网与外网地址并发探测，分别显示结果（外网为空则提示共用内网）
export async function testConnection() {
  const internal = (store.config.internalBaseUrl || store.config.baseUrl || '').trim()
  const external = (store.config.externalBaseUrl || '').trim()
  if (!internal) {
    setConnStatus('请先填写内网/默认服务地址', 'err')
    return
  }
  setConnStatus('正在连接…', 'pending')
  const [ri, re] = await Promise.all([
    probeService(internal),
    external ? probeService(external) : Promise.resolve(null),
  ])
  const parts = [ri.ok ? '内网 ✓' : '内网 ✗']
  if (external) parts.push(re && re.ok ? '外网 ✓' : '外网 ✗')
  else parts.push('外网 未填（共用内网）')
  const allOk = ri.ok && (external ? re && re.ok : true)
  setConnStatus(parts.join(' ｜ '), allOk ? 'ok' : 'err')
}

// 调 /switch_source 找可播替代音源。
// opts.current: 需排除的当前源（多轮换源时传上一次换到的源，服务端据此找下一个源）
// opts.target: 指定目标音源
// 返回：成功->新歌对象, 无可用->false, 网络错误->null
export async function switchSource(song, opts = {}) {
  const base = normalizeBaseUrl(store.config.baseUrl)
  if (!base) return null
  const p = new URLSearchParams({
    name: song.name || '',
    artist: song.artist || '',
    source: song.source || '',
    current: opts.current || song.source || '',
    duration: song.duration || 0,
  })
  if (opts.target) p.set('target', opts.target)
  try {
    const res = await gmdFetch(`${base}/switch_source?${p.toString()}`, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
    if (res.status === 404) return false
    if (!res.ok) return null
    const j = await res.json()
    if (!j || !j.id) return false
    return {
      id: j.id,
      source: j.source,
      name: j.name,
      artist: j.artist,
      album: j.album,
      cover: j.cover,
      duration: j.duration,
      extra: j.extra || {},
    }
  } catch {
    return null
  }
}
