// config.js — 配置加载/保存
import { store, ALL_SOURCES, SOURCE_LABELS } from './state.js'
import { API, testConnection, friendlyError, isExternalAccess } from './api.js'
import { showSnackbar } from './util.js'

export async function loadConfig() {
  let raw = {}
  try {
    raw = (await API.config()) || {}
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
  if (gpEl) {
    // 后端不再回显已保存口令：留空 = 保持不变，填新值才覆盖
    gpEl.value = ''
    gpEl.placeholder = raw.hasGmdAuthPass ? '已保存，留空保持不变' : '未配置（可选）'
  }
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
    // 保存后同步口令占位提示：填了新值 / 原本已保存都显示「留空保持不变」
    const gpEl = document.getElementById('configGmdAuthPass')
    if (gpEl) {
      gpEl.value = ''
      gpEl.placeholder =
        gmdAuthPass || store.config.hasGmdAuthPass
          ? '已保存，留空保持不变'
          : '未配置（可选）'
    }
    testConnection()
  } catch (e) {
    showSnackbar(friendlyError(e, '保存失败'))
  }
}

/** 服务/凭据体检：只读展示，不做任何自动修复或上游写入。 */
export async function runDiagnostics() {
  const status = document.getElementById('diagnoseStatus')
  const detail = document.getElementById('diagnoseDetail')
  if (status) {
    status.textContent = '正在检测…'
    status.className = 'conn-status pending'
  }
  if (detail) detail.textContent = ''
  try {
    const r = await API.diagnostics()
    if (status) {
      status.textContent = r.ok ? '服务可达' : '不可达'
      status.className = 'conn-status ' + (r.ok ? 'ok' : 'err')
    }
    if (detail) detail.textContent = r.message || ''
  } catch (e) {
    if (status) {
      status.textContent = '检测失败'
      status.className = 'conn-status err'
    }
    if (detail) detail.textContent = friendlyError(e, '体检失败')
  }
}

/** 显式清除已保存的管理员密码（留空保存只表示「保持不变」）。 */
export async function clearGmdAuthPass() {
  try {
    const res = await API.saveConfig({ clearGmdAuthPass: true })
    store.config.hasGmdAuthPass = !!(res && res.config && res.config.hasGmdAuthPass)
    const el = document.getElementById('configGmdAuthPass')
    if (el) {
      el.value = ''
      el.placeholder = '未配置（可选）'
    }
    showSnackbar('已清除保存的管理员密码')
  } catch (e) {
    showSnackbar(friendlyError(e, '清除失败'))
  }
}
