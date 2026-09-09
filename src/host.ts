// 代理宿主 API：用插件运行时拿到的宿主绝对地址 + token 调用，
// 避免前端直连时因 common.js 的 API_BASE='.' 把 /api/v1 拼成相对路径而 404。
// 自 router.ts 抽出，供歌单同步（sync.ts）等模块复用，逻辑保持不变。
export async function callHostApi(
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const hostUrl = await (globalThis as any).songloft.plugin.getHostUrl()
  const token = await (globalThis as any).songloft.plugin.getToken()
  const res = await fetch(`${hostUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    throw new Error(
      `Host API ${method} ${path} failed: ${await res.text()}`,
    )
  }
  const text = await res.text()
  return text ? JSON.parse(text) : null
}
