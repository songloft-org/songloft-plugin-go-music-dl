import { test } from 'node:test'
import assert from 'node:assert/strict'

// persist.js 在调用期才触碰 localStorage，先挂 mock 再动态导入
globalThis.localStorage = {
  _m: {},
  getItem(k) {
    return this._m[k] ?? null
  },
  setItem(k, v) {
    this._m[k] = String(v)
  },
  removeItem(k) {
    delete this._m[k]
  },
}

const { store } = await import('../static/js/state.js')
const persist = await import('../static/js/persist.js')

function seedQueue() {
  store.queue = [
    { id: '1', source: 'netease', name: 'A', artist: 'x', album: '', cover: '', duration: 180, extra: { level: 'exhigh' } },
    { id: '2', source: 'qq', name: 'B', artist: 'y', album: '', cover: '', duration: 200, extra: {} },
  ]
  store.currentIndex = 1
}

test('播放状态存取回路（队列+索引+进度）', () => {
  localStorage._m = {}
  seedQueue()
  persist.savePlaybackState()
  persist.savePlaybackProgress(95.7)
  const snap = persist.loadPlaybackSnapshot()
  assert.equal(snap.currentIndex, 1)
  assert.equal(snap.position, 95) // Math.floor
  assert.equal(snap.queue[1].id, '2')
  assert.equal(snap.queue[0].extra.level, 'exhigh') // extra 随队列持久化
})

test('进度防串位：换歌后旧进度不套用到新歌', () => {
  localStorage._m = {}
  seedQueue()
  persist.savePlaybackState()
  persist.savePlaybackProgress(95.7) // B 的进度
  store.currentIndex = 0 // 切回 A 并落盘新状态
  persist.savePlaybackState()
  assert.equal(persist.loadPlaybackSnapshot().position, 0)
})

test('队列超上限时以当前曲为中心截窗到 200', () => {
  localStorage._m = {}
  store.queue = Array.from({ length: 500 }, (_, i) => ({
    id: String(i), source: 'netease', name: 's' + i, artist: '', album: '', cover: '', duration: 1, extra: {},
  }))
  store.currentIndex = 490
  persist.savePlaybackState()
  const snap = persist.loadPlaybackSnapshot()
  assert.equal(snap.queue.length, 200)
  assert.equal(snap.queue[snap.currentIndex].id, '490')
})

test('clearPlaybackState 清空 + 坏数据/版本不匹配容错', () => {
  localStorage._m = {}
  seedQueue()
  persist.savePlaybackState()
  persist.clearPlaybackState()
  assert.equal(persist.loadPlaybackSnapshot(), null)

  localStorage.setItem('gmd-playback-state', '{bad json')
  assert.equal(persist.loadPlaybackSnapshot(), null)
  localStorage.setItem('gmd-playback-state', JSON.stringify({ v: 99, queue: [], currentIndex: 0 }))
  assert.equal(persist.loadPlaybackSnapshot(), null)
})

test('非法当前曲不落盘', () => {
  localStorage._m = {}
  store.queue = [{ id: '', source: '', name: 'bad' }]
  store.currentIndex = 0
  persist.savePlaybackState()
  assert.equal(persist.loadPlaybackSnapshot(), null)
})
