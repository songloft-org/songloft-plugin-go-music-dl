// HTTP 请求体解析（纯函数、零运行时依赖，便于独立单测）。
//
// 宿主运行时把 body 作为 string 传入（jsplugin/service.go 的 HTTPRequestData.Body；
// 非 UTF-8/multipart 时由 __dispatchHTTPB64 用 atob 还原为 latin1 字符串），
// 而 SDK 类型声明为 Uint8Array | null。两种形态都得能解析，避免各端点各自实现
// 导致「有的只认 string」这类分叉（历史：/api/music/url 曾因此漏解析）。

export interface BodyLike {
  body?: string | Uint8Array | null
}

/** 请求体 → 字符串；Uint8Array 优先按 UTF-8 解码，旧宿主无 TextDecoder 时回退逐字节。 */
export function bodyToString(req: BodyLike): string {
  const body = req?.body
  if (!body) return ''
  if (typeof body === 'string') return body
  const Decoder = (globalThis as any).TextDecoder
  if (typeof Decoder === 'function') {
    try {
      return new Decoder('utf-8').decode(body)
    } catch {
      /* 宿主实现异常时回退到下面的逐字节拼接 */
    }
  }
  // String.fromCharCode.apply 展开大数组会超出 QuickJS 的参数上限
  // （/import/batch 的 body 可达几十 KB），逐 8KB 块拼接规避。
  let out = ''
  const CHUNK = 8192
  for (let i = 0; i < body.length; i += CHUNK) {
    out += String.fromCharCode.apply(
      null,
      Array.from(body.subarray(i, i + CHUNK)) as unknown as number[],
    )
  }
  return out
}

/** 解析 JSON 请求体；空体/非法 JSON 一律返回 {}，参数校验交由各路由负责。 */
export function parseBody(req: BodyLike): any {
  if (!req?.body) return {}
  try {
    return JSON.parse(bodyToString(req))
  } catch {
    return {}
  }
}
