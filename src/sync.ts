// sync.ts — 歌单手动同步引擎（单向：go-music-dl 账号歌单 → Songloft 本地歌单）
//
// 设计要点（详见 README「歌单同步」）：
// 1. 绑定模型：每张远端歌单按 `source + remoteId` 绑定一张本地歌单，
//    只存元数据（映射 + 时间 + 状态），**不存歌曲 key 集合**——
//    增量 diff 的真源是宿主歌单内容本身（GET /playlists/:id/songs 的 dedup_key），
//    用户手动删掉的歌下次同步自动补回，入库/加歌中断后重试即续传（宿主幂等）。
// 2. 宿主加歌 INSERT OR IGNORE 幂等、remote 歌曲按 dedup_key upsert，
//    因此重复同步零副作用。
// 3. 本地歌单中用户手动添加的非本插件歌曲（dedup_key 为空/不同源）绝不参与 diff，
//    不会被删除也不会被误判。
// 4. 探测+批量入库复用 import-core（与 /import/batch 同一套并发策略）。
//    同步以「begin + 循环 step」分步协议进行（见下方引擎注释）：每步一个短请求，
//    前端逐步驱动并实时刷新进度条；每步天然远短于宿主网关 30s 默认上限
//    （前端另带 X-Plugin-Timeout-Ms 放宽头兜底），从根上规避 504。

import type { GoMusicDlConfig } from './config'
import { getConfig } from './config'
import {
  fetchCollectionSongsPage,
  buildCoverProxyUrl,
  parseSongCards,
  parsePagination,
  GoSong,
} from './client'
import { callHostApi } from './host'
import {
  SongItem,
  resolveImportableItem,
  importRemoteSongs,
  mapWithConcurrency,
} from './import-core'

// ---------- 类型与常量 ----------

/** 远端歌单引用（由前端从 user_playlists 页面解析后上传） */
export interface RemotePlaylistRef {
  source: string
  id: string
  name?: string
  cover?: string
}

/** 绑定记录：远端歌单 ↔ 本地歌单 的映射与同步元数据 */
export interface SyncBinding {
  source: string
  remoteId: string
  remoteName: string
  remoteCover: string
  localPlaylistId: number
  lastSyncAt: number
  lastAdded: number
  lastStatus: 'ok' | 'partial' | 'failed'
  lastError?: string
}

const SYNC_KEY = 'gomusicdl_sync_bindings'

// 登录/初始化页特征（与前端 diagnoseUserPlaylists 同一套特征词）：
// go-music-dl cookie 失效时，详情接口会返回登录页 HTML 而非歌曲卡片
const AUTH_PAGE_RE =
  /登录 music-dl|初始化管理员账号|请输入用户名|setupRequired/

// 跨分页抓取上限（对齐前端 loadAllCollectionSongs 的防死循环 guard）
const MAX_PAGES = 100

// ---------- 纯函数（可单测） ----------

/** 绑定存储键 */
export function bindingKeyOf(source: string, remoteId: string): string {
  return `${source}__pl__${remoteId}`
}

/** 宿主 remote 歌曲的 dedup_key（与 import-core toRemoteSongRequest 同格式） */
export function dedupKeyOf(source: string, id: string): string {
  return `go-music-dl_${source}_${id}`
}

/**
 * 增量 diff：远端全量歌曲 vs 本地歌单现有 dedup_key 集合 → 需要新增的歌曲。
 * 本地 dedup_key 为空的歌曲（用户手动添加的本地/其他来源歌）不参与匹配，
 * 永远不会被本同步触碰。
 */
export function diffRemoteAgainstLocal(
  remote: GoSong[],
  localDedupKeys: Set<string>,
): GoSong[] {
  return remote.filter(
    (s) =>
      s &&
      s.id &&
      s.source &&
      !localDedupKeys.has(dedupKeyOf(s.source, s.id)),
  )
}

/** 绑定表的合并写入（纯函数，便于单测） */
export function mergeBinding(
  map: Record<string, SyncBinding>,
  binding: SyncBinding,
): Record<string, SyncBinding> {
  return { ...map, [bindingKeyOf(binding.source, binding.remoteId)]: binding }
}

// ---------- 绑定存储（songloft.storage，驱逐/重启不丢） ----------

export async function loadBindings(): Promise<Record<string, SyncBinding>> {
  try {
    const raw = await (globalThis as any).songloft?.storage?.get(SYNC_KEY)
    if (raw) {
      const parsed = JSON.parse(raw as string)
      if (parsed && typeof parsed === 'object') return parsed
    }
  } catch (e) {
    console.error('[sync] loadBindings failed:', String(e))
  }
  return {}
}

async function saveBindings(
  map: Record<string, SyncBinding>,
): Promise<void> {
  const s = (globalThis as any).songloft?.storage
  if (s) {
    await s.set(SYNC_KEY, JSON.stringify(map))
  }
}

export async function getBinding(
  source: string,
  remoteId: string,
): Promise<SyncBinding | null> {
  const map = await loadBindings()
  return map[bindingKeyOf(source, remoteId)] || null
}

export async function listBindings(): Promise<SyncBinding[]> {
  const map = await loadBindings()
  return Object.values(map)
}

async function upsertBinding(binding: SyncBinding): Promise<void> {
  const map = await loadBindings()
  await saveBindings(mergeBinding(map, binding))
}

// ---------- 远端/本地数据抓取 ----------

/**
 * 分步抓取：每次调用抓取下一页歌单详情（HTML）并累积到 session.remote。
 * - 返回 true=本页抓到歌曲、后续还有页；false=抓取结束（末页/空页/翻页中断）；
 * - 登录失效检测（M1）：仅当首页「解析不出任何卡片」且页面命中登录页特征词时才判定，
 *   歌名/摘要含「请输入用户名」等词但首页正常有卡片时绝不误报；
 * - 翻页中断（page>1 网络错误）：以已抓到的为准（fetchTruncated 标记，下次同步
 *   由「本地歌单 dedup_key 真源 diff」自动补齐），与旧版整体抓取语义一致。
 */
async function fetchNextPage(s: SyncSession): Promise<boolean> {
  if (s.fetchDone) return false
  if (s.page > MAX_PAGES) {
    s.fetchDone = true
    return false
  }
  let html: string
  try {
    html = await fetchCollectionSongsPage(s.config, s.pl, s.page)
  } catch (e) {
    if (s.page === 1) throw e // 首页网络错误原样上抛（401/连接失败等）
    s.fetchTruncated = true // 翻页中断：以已抓到的为准（下次同步 diff 自动补齐）
    s.fetchDone = true
    return false
  }
  const songs = parseSongCards(html)
  if (s.page === 1 && songs.length === 0 && AUTH_PAGE_RE.test(html)) {
    throw new Error(
      'go-music-dl 登录已失效（接口返回登录页），请到 go-music-dl 网页端重新扫码登录后再同步',
    )
  }
  if (!songs.length) {
    s.fetchDone = true
    return false
  }
  s.remote.push(...songs)
  const p = parsePagination(html)
  if (p.inferred && p.totalPages) {
    s.totalPages = s.totalPages
      ? Math.max(s.totalPages, p.totalPages)
      : p.totalPages
  }
  // 真实解析到分页摘要且已到末页才停；摘要缺失（inferred=false）时总页数未知，
  // 继续翻页直到下一页为空（上方 !songs.length 终止），避免多页歌单静默丢歌
  if (p.inferred && p.totalPages && p.page >= p.totalPages) {
    s.fetchDone = true
    return false
  }
  s.page++
  return true
}

/**
 * 拉取本地歌单现有的 remote 歌曲去重键集合。
 * 宿主 GET /api/v1/playlists/:id/songs 支持 limit 且无上限钳制，一次拉全量。
 * 返回结构做宽松归一（数组 / {songs} / {data:{songs}}），dedup_key 为空的歌
 * （用户手动添加的本地歌等）不进集合——它们不受同步影响。
 */
export async function fetchLocalDedupKeys(
  localPlaylistId: number,
): Promise<Set<string>> {
  const data = await callHostApi(
    'GET',
    `/api/v1/playlists/${localPlaylistId}/songs?limit=10000`,
  )
  let songs: any[] = []
  if (Array.isArray(data)) songs = data
  else if (data && Array.isArray(data.songs)) songs = data.songs
  else if (data && data.data && Array.isArray(data.data.songs))
    songs = data.data.songs
  else if (data && Array.isArray(data.items)) songs = data.items
  const keys = new Set<string>()
  for (const s of songs) {
    if (s && typeof s.dedup_key === 'string' && s.dedup_key) {
      keys.add(s.dedup_key)
    }
  }
  return keys
}

/** 宿主歌单列表返回结构归一（数组或 {playlists:[...]}） */
function toPlaylistArray(result: any): any[] {
  if (Array.isArray(result)) return result
  if (result && Array.isArray(result.playlists)) return result.playlists
  if (result && result.data && Array.isArray(result.data.playlists))
    return result.data.playlists
  return []
}

/**
 * 解析本地歌单 id：已绑定则校验仍存在（被删则重建）；
 * 未绑定则同名幂等复用（与前端 importCollectionAsPlaylist 同策略），无同名才创建。
 */
async function resolveLocalPlaylist(
  config: GoMusicDlConfig,
  pl: RemotePlaylistRef,
  binding: SyncBinding | null,
): Promise<number> {
  // 1) 已绑定：校验歌单仍存在
  if (binding && binding.localPlaylistId) {
    try {
      await callHostApi('GET', `/api/v1/playlists/${binding.localPlaylistId}`)
      return binding.localPlaylistId
    } catch {
      /* 歌单已被用户删除：走下方重建 */
    }
  }
  // 2) 同名幂等复用
  const name = (pl.name || '').trim() || `${pl.source} 同步歌单`
  let candidates: any[] = []
  try {
    candidates = toPlaylistArray(
      await callHostApi('GET', '/api/v1/playlists?limit=1000'),
    )
  } catch {
    /* 拉不到列表就跳过复用，直接创建 */
  }
  const existed = candidates.find((p: any) => p && p.name === name && p.id)
  if (existed) return Number(existed.id)
  // 3) 创建（封面走 go-music-dl cover_proxy 代理，规避防盗链空白封面）
  const created = await callHostApi('POST', '/api/v1/playlists', {
    name,
    type: 'normal',
    cover_url: buildCoverProxyUrl(pl.cover || '', config.baseUrl),
  })
  if (!created || !created.id) {
    throw new Error('创建本地歌单失败')
  }
  return Number(created.id)
}

// ---------- 单张同步编排 ----------

export interface SyncOneResult {
  status: 'ok' | 'partial' | 'failed'
  source: string
  remoteId: string
  localPlaylistId?: number
  remoteTotal: number
  /** 本次实际加进歌单的歌数（宿主 added） */
  added: number
  /** 确认失效被丢弃的歌数 */
  dead: number
  /** 未成功处理完的歌数（>0 即 partial：本 chunk 作废，重试 diff 自动补齐） */
  pending: number
  message?: string
}

/**
 * 分步同步引擎（begin + step，替代旧版一次性 /sync/run 长请求）：
 * 前端先调 beginSyncSession 创建会话（含首页抓取，登录失效等错误在此快速失败），
 * 然后循环调 stepSyncSession，每步只推进一个「最小工作单元」并返回实时进度——
 *   fetch 阶段：抓 1 页远端歌单（前端显示「第 p/P 页 · 已读 n 首」）；
 *   prepare 阶段：解析/创建本地歌单 + 拉本地 dedup_key + diff 新增（一步，秒级）；
 *   import 阶段：每步探测+入库+加歌单 SYNC_STEP_CHUNK 首（前端显示 m/total 进度条）。
 * 设计动机：
 * 1. 大歌单同步长达数分钟，旧版单请求内无法向前端回报进度，用户只能干等；
 * 2. 每步都是独立短请求（最坏 ~20s，稳在网关 30s 默认上限内），彻底规避 504；
 * 3. 每 chunk 幂等提交宿主（upsert + INSERT OR IGNORE），会话即使因运行时重启丢失
 *   （返回 SYNC_SESSION_NOT_FOUND），重试也只补缺歌，已导入进度不丢。
 * 任一环节失败都以 partial/failed 收尾而非抛异常中断（错误信息进 result.message），
 * 便于前端串行多张时单张失败不阻断后续。
 */

/** import 阶段每步处理的歌曲数：并发 8、单首探测最长 8s、一批约两轮 ≈16s，
 *  加宿主写库往返后单步稳在网关默认 30s 内（前端另带 60s 放宽头兜底） */
export const SYNC_STEP_CHUNK = 16

/** 会话空闲回收时间：超时未推进的会话在下次 begin 时清理 */
const SESSION_TTL_MS = 30 * 60 * 1000

interface SyncSession {
  id: string
  pl: RemotePlaylistRef
  config: GoMusicDlConfig
  phase: 'fetch' | 'prepare' | 'import' | 'done'
  /** fetch 阶段：下一个要抓的页码（从 1 开始） */
  page: number
  /** 首页解析到的总页数；摘要缺失（inferred=false）时为 null（总页数未知） */
  totalPages: number | null
  remote: GoSong[]
  fetchDone: boolean
  /** 翻页中断（page>1 网络错误）：以已抓到的为准 */
  fetchTruncated: boolean
  localId?: number
  /** prepare 后：待导入的新增歌曲队列 */
  newSongs: GoSong[]
  /** import 阶段：已处理到 newSongs 的下标（不含失败作废的 chunk） */
  cursor: number
  added: number
  dead: number
  startedAt: number
  updatedAt: number
  result?: SyncOneResult
}

/** step 接口响应：done=false 时携带实时进度，done=true 时携带最终结果 */
export interface SyncStepResponse {
  done: boolean
  sessionId: string
  phase?: 'fetch' | 'prepare' | 'import'
  /** fetch：已抓页数 / 首页解析到的总页数（可能为 null=未知） */
  pagesDone?: number
  totalPages?: number | null
  /** fetch：已读取的歌曲数 */
  songsFetched?: number
  /** import：已处理歌数 / 待导入总数 */
  processed?: number
  total?: number
  /** 累计：实际加进歌单的歌数 / 确认失效丢弃的歌数 */
  added?: number
  dead?: number
  result?: SyncOneResult
}

/** 会话不存在（运行时重启/超时回收）：幂等设计下前端提示重试即可续传 */
export class SyncSessionNotFound extends Error {}

const sessions = new Map<string, SyncSession>()

function pruneSessions(): void {
  const now = Date.now()
  for (const [k, s] of sessions) {
    if (now - s.updatedAt > SESSION_TTL_MS) sessions.delete(k)
  }
}

/** 阶段进度视图（begin/step 共用的未完成响应） */
function stepView(s: SyncSession): SyncStepResponse {
  return {
    done: false,
    sessionId: s.id,
    phase: s.phase === 'done' ? 'import' : s.phase,
    pagesDone: Math.max(1, s.page - (s.fetchDone ? 0 : 1)),
    totalPages: s.totalPages,
    songsFetched: s.remote.length,
    processed: s.cursor,
    total: s.phase === 'import' ? s.newSongs.length : undefined,
    added: s.added,
    dead: s.dead,
  }
}
/** 收尾：写绑定（已解析出本地歌单时）+ 返回最终结果；会话保留供幂等重放 */
async function finishSession(
  s: SyncSession,
  status: SyncOneResult['status'],
  message?: string,
): Promise<SyncStepResponse> {
  const finalMessage =
    message ||
    (s.fetchTruncated
      ? '远端部分分页读取失败，本次以已读取部分为准，下次同步自动补齐'
      : status === 'partial'
        ? '部分歌曲未处理完，请再点一次同步继续'
        : undefined)
  const result: SyncOneResult = {
    status,
    source: s.pl.source,
    remoteId: s.pl.id,
    localPlaylistId: s.localId,
    remoteTotal: s.remote.length,
    added: s.added,
    dead: s.dead,
    pending:
      status === 'partial' ? Math.max(0, s.newSongs.length - s.cursor) : 0,
    message: finalMessage,
  }
  if (s.localId) {
    await upsertBinding({
      source: s.pl.source,
      remoteId: s.pl.id,
      remoteName: s.pl.name || '',
      remoteCover: s.pl.cover || '',
      localPlaylistId: s.localId,
      lastSyncAt: Date.now(),
      lastAdded: result.added,
      lastStatus: status,
      lastError: status === 'failed' ? finalMessage : undefined,
    })
  }
  s.phase = 'done'
  s.result = result
  s.updatedAt = Date.now()
  return { done: true, sessionId: s.id, result }
}

/** begin：创建会话并抓取首页（登录失效/网络错误在此快速失败，直接抛给调用方） */
export async function beginSyncSession(
  pl: RemotePlaylistRef,
): Promise<SyncStepResponse> {
  pruneSessions()
  const config = await getConfig()
  if (!config.baseUrl) {
    throw new Error('服务地址未配置，请先在插件设置中填写')
  }
  const session: SyncSession = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    pl,
    config,
    phase: 'fetch',
    page: 1,
    totalPages: null,
    remote: [],
    fetchDone: false,
    fetchTruncated: false,
    newSongs: [],
    cursor: 0,
    added: 0,
    dead: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  }
  await fetchNextPage(session)
  sessions.set(session.id, session)
  return stepView(session)
}

/** step：推进一个最小工作单元，返回实时进度或最终结果 */
export async function stepSyncSession(
  sessionId: string,
): Promise<SyncStepResponse> {
  const s = sessions.get(String(sessionId || ''))
  if (!s) {
    throw new SyncSessionNotFound(
      '同步会话已失效，请重新开始同步（已导入部分不会丢失）',
    )
  }
  s.updatedAt = Date.now()
  if (s.phase === 'done') {
    return { done: true, sessionId: s.id, result: s.result }
  }
  try {
    // 1) fetch 阶段：每步抓一页
    if (s.phase === 'fetch') {
      const more = await fetchNextPage(s)
      if (more) return stepView(s)
      s.phase = 'prepare'
    }
    // 2) prepare 阶段：解析/创建本地歌单 + diff（一步完成，宿主调用秒级）
    if (s.phase === 'prepare') {
      if (!s.remote.length) {
        return await finishSession(
          s,
          'ok',
          '远端歌单为空（或该源未返回任何歌曲）',
        )
      }
      const binding = await getBinding(s.pl.source, s.pl.id)
      s.localId = await resolveLocalPlaylist(s.config, s.pl, binding)
      const localKeys = await fetchLocalDedupKeys(s.localId)
      s.newSongs = diffRemoteAgainstLocal(s.remote, localKeys)
      if (!s.newSongs.length) {
        // 全部已同步（或远端回退了）：幂等刷新一次绑定时间戳
        return await finishSession(s, 'ok')
      }
      s.phase = 'import'
      return stepView(s)
    }
    // 3) import 阶段：每步处理 SYNC_STEP_CHUNK 首（探测 → 批量入库 → 幂等加歌单）。
    //    并发 8、单首探测最长 8s、一批约两轮 ≈16s，加宿主写库往返后，
    //    单步总耗时稳在网关默认 30s 内（前端另带 60s 放宽头兜底）。
    const chunk = s.newSongs.slice(s.cursor, s.cursor + SYNC_STEP_CHUNK)
    const results = await mapWithConcurrency(chunk, 8, (it) =>
      resolveImportableItem(it, s.config),
    )
    const okItems: SongItem[] = []
    for (const r of results) {
      if (r.item) okItems.push(r.item)
      else if (r.reason === 'dead') s.dead++
    }
    if (okItems.length) {
      const imported = await importRemoteSongs(okItems)
      const ids = imported
        .map((x: any) => x.id)
        .filter((id: unknown) => typeof id === 'number')
      if (ids.length) {
        // 幂等加歌单（INSERT OR IGNORE，已存在自动 skipped）
        const addRes = await callHostApi(
          'POST',
          `/api/v1/playlists/${s.localId}/songs`,
          { song_ids: ids },
        )
        s.added += Number(addRes && addRes.added) || 0
      }
    }
    s.cursor += chunk.length
    if (s.cursor >= s.newSongs.length) {
      return await finishSession(s, 'ok')
    }
    return stepView(s)
  } catch (e) {
    const message = String((e as Error)?.message || e)
    // 入库/加歌单失败（如宿主不可达）：本 chunk 作废（cursor 未推进），
    // 下次重试 diff 会重新补齐；已解析出本地歌单则落 partial 绑定，否则 failed。
    return await finishSession(s, s.localId ? 'partial' : 'failed', message)
  }
}
