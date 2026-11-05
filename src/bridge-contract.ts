// 历史：本文件原与 songloft-plugin-bridge 的 contract.ts 保持算法一致，
// 用于跨插件 comm 通信。自 v2026.8.9 起 go-music-dl 自身实现 /stream 路由
// 与 302 重定向，不再依赖 bridge 插件。这里仅保留 token 编解码与回环→LAN
// 重写工具，供本插件自身的 /stream/:token 路由使用。

function b64encode(s: string): string {
  const btoaFn = (globalThis as any).btoa
  if (typeof btoaFn !== 'function') {
    throw new Error('btoa unavailable in runtime')
  }
  return btoaFn(unescape(encodeURIComponent(s)))
}

function b64decode(s: string): string {
  const atobFn = (globalThis as any).atob
  if (typeof atobFn !== 'function') {
    throw new Error('atob unavailable in runtime')
  }
  return decodeURIComponent(escape(atobFn(s)))
}

/** 字符串 → URL 安全 base64url（无填充）。 */
export function encodeBase64Url(s: string): string {
  return b64encode(s)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** URL 安全 base64url → 字符串。 */
export function decodeBase64Url(s: string): string {
  return b64decode(s.replace(/-/g, '+').replace(/_/g, '/'))
}

/**
 * 把任意对象/字符串编码为 URL 安全的 base64url token（无填充）。
 * 与历史 Bridge contract 的 encodeToken 算法一致，便于已分发的旧 token 仍可解码。
 */
export function encodeToken(obj: unknown): string {
  const json = typeof obj === 'string' ? obj : JSON.stringify(obj)
  return encodeBase64Url(json)
}

/** 解码 base64url token，还原为原始对象。 */
export function decodeToken<T = unknown>(tok: string): T {
  return JSON.parse(decodeBase64Url(tok))
}

/**
 * /stream 路由回源时不能指向回环地址（音箱在另一台机器上，无法访问本机 127.0.0.1），
 * 故把 baseUrl 里的回环主机重写为本机在 LAN 上的可达 IP（取第一个网段地址）。
 * 仅当 baseUrl 确为回环时才重写，其余情况原样返回，零破坏。
 */
export async function loopbackToLan(raw: string): Promise<string> {
  try {
    const u = new URL(raw)
    const h = u.hostname.toLowerCase()
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') {
      const addrs = await (globalThis as any).songloft?.plugin?.getNetworkAddresses?.()
      const lan = addrs && addrs[0]
      if (lan) {
        u.hostname = lan
        return u.toString()
      }
    }
  } catch {
    /* 解析失败则原样返回 */
  }
  return raw
}
