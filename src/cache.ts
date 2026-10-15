// 进程内 TTL 缓存（QuickJS 单线程，Map 足够）。
// 用途：搜索/歌词/封面等热路径结果短期复用，减少对 go-music-dl 的重复请求
// （上游单曲搜索是「全量搜完再内存切片」，相同关键词重复搜索代价高）。
// 插件被宿主空闲驱逐重载后缓存随 VM 一起重建，无需持久化。

export class TTLCache<V> {
  private map = new Map<string, { value: V; expires: number }>()

  constructor(
    private ttlMs: number,
    private maxEntries = 100,
    private now: () => number = () => Date.now(),
  ) {}

  /** 命中且未过期返回值并刷新 LRU 顺序；过期/未命中返回 undefined 并清除过期项。 */
  get(key: string): V | undefined {
    const hit = this.map.get(key)
    if (!hit) return undefined
    if (hit.expires <= this.now()) {
      this.map.delete(key)
      return undefined
    }
    // 命中刷新为最近使用（Map 保持插入序，先删后插 = 移到末尾）
    this.map.delete(key)
    this.map.set(key, hit)
    return hit.value
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, { value, expires: this.now() + this.ttlMs })
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }

  clear(): void {
    this.map.clear()
  }
}
