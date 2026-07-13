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
  const internal = store.config.baseUrl || 'http://127.0.0.1:58091'
  const external = store.config.externalBaseUrl || ''
  store.config.internalBaseUrl = internal
  store.config.externalBaseUrl = external
  // 关键：运行时统一用「当前网络下生效」的地址（外网且有外网地址则切换，否则回退内网）
  store.config.baseUrl = isExternalAccess() && external ? external : internal
  document.getElementById('configBaseUrl').value = internal
  const extEl = document.getElementById('configExternalBaseUrl')
  if (extEl) extEl.value = external
  const dq = document.getElementById('configDefaultQuality')
  if (dq) dq.value = store.config.defaultQuality || 'exhigh'
  store.currentQuality = store.config.defaultQuality || 'exhigh'
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

export async function saveConfig() {
  const baseUrl = document.getElementById('configBaseUrl').value.trim()
  const externalBaseUrl = (
    document.getElementById('configExternalBaseUrl')?.value || ''
  ).trim()
  const sources = Array.from(
    document.querySelectorAll('#configSources input:checked'),
  ).map((cb) => cb.value)
  const defaultQuality =
    document.getElementById('configDefaultQuality').value || 'exhigh'
  store.config = { ...store.config, baseUrl, externalBaseUrl, sources, defaultQuality }
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
      externalBaseUrl,
      sources,
      defaultQuality,
      timeout: store.config.timeout || 15000,
    })
    showSnackbar('配置已保存')
    testConnection()
  } catch (e) {
    showSnackbar(friendlyError(e, '保存失败'))
  }
}
