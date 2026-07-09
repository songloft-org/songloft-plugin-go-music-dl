import type { HTTPRequest, HTTPResponse } from '@songloft/plugin-sdk'
import router from './router'

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
}

async function onDeinit(): Promise<void> {
  try {
    ;(globalThis as any).songloft.lyrics.unregisterProvider()
  } catch {
    /* ignore */
  }
  console.log('[Go Music DL Plugin] Unmounted')
}

async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
  return await router.handle(req)
}

;(globalThis as any).onInit = onInit
;(globalThis as any).onDeinit = onDeinit
;(globalThis as any).onHTTPRequest = onHTTPRequest
