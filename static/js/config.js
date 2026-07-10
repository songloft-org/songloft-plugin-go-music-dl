// config.js — 配置加载/保存
import { store, ALL_SOURCES, SOURCE_LABELS } from './state.js'
import { API, testConnection, friendlyError } from './api.js'
import { showSnackbar } from './util.js'

export async function loadConfig() {
  try {
    store.config = await API.config()
  } catch {
    /* 使用默认值 */
  }
  document.getElementById('configBaseUrl').value = store.config.baseUrl || ''
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
  const sources = Array.from(
    document.querySelectorAll('#configSources input:checked'),
  ).map((cb) => cb.value)
  const defaultQuality =
    document.getElementById('configDefaultQuality').value || 'exhigh'
  store.config = { ...store.config, baseUrl, sources, defaultQuality }
  store.currentQuality = defaultQuality
  store.recommendLoaded = false // 配置变更后，下次进入首页重新拉取推荐
  try {
    await API.saveConfig(store.config)
    showSnackbar('配置已保存')
    testConnection()
  } catch (e) {
    showSnackbar(friendlyError(e, '保存失败'))
  }
}
