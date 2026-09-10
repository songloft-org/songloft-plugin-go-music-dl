// 同步引擎纯函数测试：diff / 绑定 / dedup_key（由 npm test 预先用 esbuild 转译到 tests/.gen/sync.mjs）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bindingKeyOf,
  dedupKeyOf,
  diffRemoteAgainstLocal,
  mergeBinding,
  SYNC_STEP_CHUNK,
} from './.gen/sync.mjs'

test('SYNC_STEP_CHUNK：每步导入批量保持在网关安全范围内', () => {
  // 并发 8、单首探测最长 8s：chunk 越界会导致单步请求可能超过网关 30s 默认上限
  assert.ok(SYNC_STEP_CHUNK > 0 && SYNC_STEP_CHUNK <= 32)
})

test('bindingKeyOf / dedupKeyOf 键格式（dedup_key 与 import-core toRemoteSongRequest 同格式）', () => {
  assert.equal(bindingKeyOf('netease', '8751963'), 'netease__pl__8751963')
  assert.equal(dedupKeyOf('netease', '123'), 'go-music-dl_netease_123')
  assert.equal(dedupKeyOf('qq', 'a b'), 'go-music-dl_qq_a b')
})

test('diffRemoteAgainstLocal：已存在歌被过滤，仅返回新增', () => {
  const remote = [
    { id: '1', source: 'netease', name: 'A' },
    { id: '2', source: 'netease', name: 'B' },
    { id: '3', source: 'qq', name: 'C' },
  ]
  const local = new Set([
    'go-music-dl_netease_1',
    'go-music-dl_qq_3',
  ])
  const diff = diffRemoteAgainstLocal(remote, local)
  assert.equal(diff.length, 1)
  assert.equal(diff[0].id, '2')
})

test('diffRemoteAgainstLocal：跨源同 id 不串位（netease_123 ≠ qq_123）', () => {
  const remote = [{ id: '123', source: 'qq', name: 'X' }]
  const local = new Set(['go-music-dl_netease_123'])
  const diff = diffRemoteAgainstLocal(remote, local)
  assert.equal(diff.length, 1) // 源不同 → 视为新增
})

test('diffRemoteAgainstLocal：dedup_key 为空的手动歌不入集合，远端同 id 歌仍按 key 精确匹配', () => {
  // 用户手动把一首本地歌加进了绑定歌单（dedup_key 为空），远端列表里另有同 id 的 remote 歌：
  // 本地集合中没有该 key → 会被当作新增导入（幂等安全：宿主按 dedup_key 去重不会重复入曲库）
  const remote = [
    { id: '9', source: 'kugou', name: '手动歌同 id' },
    { id: '10', source: 'kugou', name: '新歌' },
  ]
  const local = new Set(['some-other-dedup-key']) // 手动歌 dedup_key 为空未加入集合
  const diff = diffRemoteAgainstLocal(remote, local)
  assert.deepEqual(
    diff.map((s) => s.id).sort(),
    ['10', '9'],
  )
})

test('diffRemoteAgainstLocal：缺 id/缺 source 的坏数据被丢弃', () => {
  const remote = [
    { id: '', source: 'netease', name: 'no id' },
    { id: '5', source: '', name: 'no source' },
    null,
    { id: '6', source: 'netease', name: 'ok' },
  ]
  const diff = diffRemoteAgainstLocal(remote, new Set())
  assert.equal(diff.length, 1)
  assert.equal(diff[0].id, '6')
})

test('mergeBinding：新增与覆盖，不影响其他绑定', () => {
  const existing = {
    'netease__pl__1': {
      source: 'netease',
      remoteId: '1',
      remoteName: 'A',
      remoteCover: '',
      localPlaylistId: 11,
      lastSyncAt: 100,
      lastAdded: 3,
      lastStatus: 'ok',
    },
  }
  const updated = mergeBinding(existing, {
    ...existing['netease__pl__1'],
    lastSyncAt: 200,
    lastAdded: 0,
  })
  const added = mergeBinding(updated, {
    source: 'qq',
    remoteId: '2',
    remoteName: 'B',
    remoteCover: 'c',
    localPlaylistId: 22,
    lastSyncAt: 300,
    lastAdded: 5,
    lastStatus: 'ok',
  })
  assert.equal(Object.keys(added).length, 2)
  assert.equal(added['netease__pl__1'].lastSyncAt, 200)
  assert.equal(added['qq__pl__2'].localPlaylistId, 22)
  // mergeBinding 为纯函数：不修改原对象
  assert.equal(existing['netease__pl__1'].lastSyncAt, 100)
})