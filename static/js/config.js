// config.js — 配置加载/保存
import { store, ALL_SOURCES, SOURCE_LABELS } from './state.js'
import { API, testConnection, friendlyError, isExternalAccess } from './api.js'
import { showSnackbar } from './util.js'

export async function loadConfig() {
  try {
    const raw = await API.config()
    store.config = { ...store.config, ...raw }
  } catch {
    /* 使用默认值 */
  }
  // 拆分内外网地址：internalBaseUrl 为用户配置的内网/默认地址，externalBaseUrl 可选
  const internal = store.config.baseUrl || ''
  const external = store.config.externalBaseUrl || ''
  store.config.internalBaseUrl = internal
  store.config.externalBaseUrl = external
  // 关键：运行时统一用「当前网络下生效」的地址（外网且有外网地址则切换，否则回退内网）
  store.config.baseUrl = isExternalAccess() && external ? external : internal
  document.getElementById('configBaseUrl').value = internal
  const extEl = document.getElementById('configExternalBaseUrl')
  if (extEl) extEl.value = external
  const bpEl = document.getElementById('configBasePath')
  if (bpEl) bpEl.value = store.config.basePath || '/music'
  const shEl = document.getElementById('configServerHost')
  if (shEl) shEl.value = store.config.serverHost || ''
  const dq = document.getElementById('configDefaultQuality')
  if (dq) dq.value = store.config.defaultQuality || 'exhigh'
  store.currentQuality = store.config.defaultQuality || 'exhigh'
  const btEl = document.getElementById('configBackendType')
  if (btEl) btEl.value = store.config.backendType || 'gmd'
  const guEl = document.getElementById('configGmdAuthUser')
  if (guEl) guEl.value = store.config.gmdAuthUser || ''
  const gpEl = document.getElementById('configGmdAuthPass')
  if (gpEl) gpEl.value = store.config.gmdAuthPass || ''
  const box = document.getElementById('configSources')
  box.innerHTML = ''
  for (const s of ALL_SOURCES) {
    const label = document.createElement('label')
    label.className = 'md-checkbox'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.value = s
    cb.checked = (store.config.sources || []).includes(s)
    label.appendChild(cb)
    label.appendChild(document.createTextNode(' ' + (SOURCE_LABELS[s] || s)))
    box.appendChild(label)
  }
}

// 全选 / 清空 搜索音源勾选
export function setAllSources(checked) {
  document
    .querySelectorAll('#configSources input[type=checkbox]')
    .forEach((cb) => { cb.checked = checked })
}

// 自动填充对外可达地址：autoFill —— 浏览器当前访问地址大概率就是音箱可达的宿主地址，
// 只填入输入框不自动保存（反代/异网访问时 origin 可能并非音箱视角），由用户确认后点「保存配置」。
export function autoFillServerHost() {
  const el = document.getElementById('configServerHost')
  if (!el) return
  const origin = window.location.origin || `${window.location.protocol}//${window.location.host}`
  if (!origin || origin === 'null') {
    showSnackbar('无法获取当前访问地址')
    return
  }
  el.value = origin
  const isLoopback = /localhost|127\.0\.0\.1|\[::1\]|(^|:)::1$/.test(origin)
  showSnackbar(isLoopback ? '已填入，但 localhost/127.0.0.1 音箱无法访问，请改为局域网地址' : '已填入当前访问地址，确认后点保存配置')
}

export async function saveConfig() {
  const baseUrl = document.getElementById('configBaseUrl').value.trim()
  const basePath = (
    document.getElementById('configBasePath')?.value || ''
  ).trim()
  const externalBaseUrl = (
    document.getElementById('configExternalBaseUrl')?.value || ''
  ).trim()
  const serverHost = (
    document.getElementById('configServerHost')?.value || ''
  ).trim()
  const sources = Array.from(
    document.querySelectorAll('#configSources input:checked'),
  ).map((cb) => cb.value)
  const defaultQuality =
    document.getElementById('configDefaultQuality').value || 'exhigh'
  const backendType =
    document.getElementById('configBackendType')?.value || 'gmd'
  // gmd 管理员凭据（可选，账号登录分组）
  const gmdAuthUser = (
    document.getElementById('configGmdAuthUser')?.value || ''
  ).trim()
  const gmdAuthPass =
    document.getElementById('configGmdAuthPass')?.value || ''
  store.config = { ...store.config, baseUrl, basePath, externalBaseUrl, serverHost, sources, defaultQuality, backendType, gmdAuthUser, gmdAuthPass }
  store.config.internalBaseUrl = baseUrl
  // 保存后立即按当前访问网络重选生效地址
  store.config.baseUrl = isExternalAccess() && externalBaseUrl ? externalBaseUrl : baseUrl
  store.currentQuality = defaultQuality
  store.recommendLoaded = false // 配置变更后，下次进入首页重新拉取推荐
  try {
    // 注意：持久化的 baseUrl 必须始终是「内网/默认地址」，不能把外网生效地址写回，
    // 否则后端（导入/取链/歌词走内网）与下次加载的输入框都会错乱。
    await API.saveConfig({
      baseUrl,
      basePath,
      externalBaseUrl,
      serverHost,
      sources,
      defaultQuality,
      backendType,
      gmdAuthUser,
      gmdAuthPass,
    })
    showSnackbar('配置已保存')
    testConnection()
  } catch (e) {
    showSnackbar(friendlyError(e, '保存失败'))
  }
}
