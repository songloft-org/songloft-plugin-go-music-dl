import type { HTTPRequest, HTTPResponse } from '@songloft/plugin-sdk'
import router from './router'

// 注册重试用的定时器句柄：onDeinit 时取消，避免 VM 已被卸载/重建后
// 旧回调仍触发 comm.call（此时 service 可能已注销，只会得到无谓报错）。
let registerTimer: any = null
let disposed = false

function scheduleRegister(fn: () => void, delay: number): void {
  registerTimer = setTimeout(fn, delay)
}

function cancelRegister(): void {
  // 卸载后连「正在 await 的注册请求失败时再排一次重试」也要拦住
  disposed = true
  if (registerTimer !== null) {
    clearTimeout(registerTimer)
    registerTimer = null
  }
}

// 向 miot 注册为「外部搜索源候选」（可选增强）。
// 延迟 + 重试调用，避免与 miot 同时启动时对方尚未就绪的竞态；
// miot 未安装 / host 不支持 comm 时静默跳过，绝不阻塞自身功能。
function registerSearchProviderToMiot(): void {
  disposed = false
  let attempts = 0
  const tryRegister = async () => {
    registerTimer = null
    if (disposed) return
    attempts++
    try {
      const comm = (globalThis as any).songloft?.comm
      if (!comm || typeof comm.call !== 'function') return // 旧 host 无 comm
      await comm.call('miot', 'register-search-provider', {
        name: 'GoMusicDL',
        searchPath: '/api/search/topone',
      })
      if (disposed) return
      console.log('[Go Music DL Plugin] 已向 miot 注册搜索源候选')
    } catch (e) {
      if (disposed) return
      if (attempts < 5) {
        scheduleRegister(tryRegister, 3000)
      } else {
        console.log(
          '[Go Music DL Plugin] miot 未安装/未就绪，放弃注册: ' + String(e),
        )
      }
    }
  }
  scheduleRegister(tryRegister, 2000)
}

async function onInit(): Promise<void> {
  // 同一 VM 内若被重复 Init，先取消上一轮尚未触发的注册重试，避免重复注册。
  cancelRegister()
  console.log('[Go Music DL Plugin] Mounted')
  try {
    ;(globalThis as any).songloft.lyrics.registerProvider()
    console.log('[Go Music DL Plugin] registered as lyric provider')
  } catch (e) {
    console.error(
      '[Go Music DL Plugin] failed to register lyric provider',
      String(e),
    )
  }
  // 封面提供者：宿主对无封面歌曲调 GET /cover-search 取补全封面。
  // 旧宿主无 covers 命名空间时静默跳过，不影响其他功能。
  try {
    const covers = (globalThis as any).songloft?.covers
    if (covers && typeof covers.registerProvider === 'function') {
      covers.registerProvider()
      console.log('[Go Music DL Plugin] registered as cover provider')
    }
  } catch (e) {
    console.error(
      '[Go Music DL Plugin] failed to register cover provider',
      String(e),
    )
  }
  registerSearchProviderToMiot()

  // 自 v2026.8.9 起移除了 comm.onMessage('resolve-stream-url') 注册：
  // go-music-dl 自身实现 GET /stream/:token 路由（router.ts），
  // 直接 decode token + 302 重定向到 go-music-dl 真实直链，
  // 不再依赖 songloft-plugin-bridge 转发回源请求。
}

async function onDeinit(): Promise<void> {
  cancelRegister()
  // 这里**不**注销歌词/封面提供者，也**不**向 miot 注销「外部搜索源候选」。
  //
  // 宿主空闲驱逐（约 10 分钟无活动）同样会触发 onDeinit，但插件在 DB 里仍是 active：
  //   - 宿主 #303 特意让 UnloadPlugin 保留 lyricProviders/coverProviders，靠
  //     SearchLyrics/SearchCover → InvokeHTTP → EnsureLoaded 按需唤醒插件。若插件在
  //     onDeinit 里主动 unregisterProvider，这两张表被清空，宿主遍历空集合直接返回
  //     「no lyrics found」，且 HasLyricProvider()==false 时客户端不再发起歌词请求，
  //     也就再没有请求能唤醒插件 → 歌词/封面自动补全静默失效，直到用户手动打开插件页。
  //     用户主动禁用由宿主 DisablePlugin 显式撤销身份，无需插件自删。
  //   - miot 的外部搜索源注册表持久化在 miot storage，注销会删掉条目，导致设置页
  //     候选消失；禁用/卸载由 miot 侧 installed/active 过滤兜底。
  console.log('[Go Music DL Plugin] Unmounted')
}

async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
  return await router.handle(req)
}

;(globalThis as any).onInit = onInit
;(globalThis as any).onDeinit = onDeinit
;(globalThis as any).onHTTPRequest = onHTTPRequest
