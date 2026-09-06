import type { HTTPRequest, HTTPResponse } from '@songloft/plugin-sdk'
import router from './router'

// 向 miot 注册为「外部搜索源候选」（可选增强）。
// 延迟 + 重试调用，避免与 miot 同时启动时对方尚未就绪的竞态；
// miot 未安装 / host 不支持 comm 时静默跳过，绝不阻塞自身功能。
function registerSearchProviderToMiot(): void {
  let attempts = 0
  const tryRegister = async () => {
    attempts++
    try {
      const comm = (globalThis as any).songloft?.comm
      if (!comm || typeof comm.call !== 'function') return // 旧 host 无 comm
      await comm.call('miot', 'register-search-provider', {
        name: 'GoMusicDL',
        searchPath: '/api/search/topone',
      })
      console.log('[Go Music DL Plugin] 已向 miot 注册搜索源候选')
    } catch (e) {
      if (attempts < 5) {
        setTimeout(tryRegister, 3000)
      } else {
        console.log(
          '[Go Music DL Plugin] miot 未安装/未就绪，放弃注册: ' + String(e),
        )
      }
    }
  }
  setTimeout(tryRegister, 2000)
}

async function onInit(): Promise<void> {
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
  registerSearchProviderToMiot()

  // 自 v2026.8.9 起移除了 comm.onMessage('resolve-stream-url') 注册：
  // go-music-dl 自身实现 GET /stream/:token 路由（router.ts），
  // 直接 decode token + 302 重定向到 go-music-dl 真实直链，
  // 不再依赖 songloft-plugin-bridge 转发回源请求。
}

async function onDeinit(): Promise<void> {
  try {
    ;(globalThis as any).songloft.lyrics.unregisterProvider()
  } catch {
    /* ignore */
  }
  // 主动向 miot 注销「外部搜索源候选」：miot 侧 installed/active 校验虽会过滤失效项，
  // 但显式注销可避免插件禁用后残留陈旧条目（comm 不存在时静默跳过）
  try {
    const comm = (globalThis as any).songloft?.comm
    if (comm && typeof comm.call === 'function') {
      await comm.call('miot', 'unregister-search-provider', {})
    }
  } catch {
    /* miot 未安装 / 宿主无 comm：忽略 */
  }
  console.log('[Go Music DL Plugin] Unmounted')
}

async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
  return await router.handle(req)
}

;(globalThis as any).onInit = onInit
;(globalThis as any).onDeinit = onDeinit
;(globalThis as any).onHTTPRequest = onHTTPRequest
