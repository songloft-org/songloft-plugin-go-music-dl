import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeBaseUrl, isInternalHostname, classifyError, friendlyError } from '../static/js/api.js'

test('normalizeBaseUrl 自动补 /music 前缀且幂等', () => {
  assert.equal(normalizeBaseUrl('http://192.168.1.190:8080'), 'http://192.168.1.190:8080/music')
  assert.equal(normalizeBaseUrl('http://192.168.1.190:8080/'), 'http://192.168.1.190:8080/music')
  assert.equal(normalizeBaseUrl('http://192.168.1.190:8080/music'), 'http://192.168.1.190:8080/music')
  assert.equal(normalizeBaseUrl(''), '')
  assert.equal(normalizeBaseUrl('   '), '')
})

test('isInternalHostname 识别内网/回环', () => {
  assert.equal(isInternalHostname('localhost'), true)
  assert.equal(isInternalHostname('127.0.0.1'), true)
  assert.equal(isInternalHostname('192.168.1.190'), true)
  assert.equal(isInternalHostname('10.0.0.3'), true)
  assert.equal(isInternalHostname('172.16.0.1'), true)
  assert.equal(isInternalHostname('172.32.0.1'), false) // 172.16-31 才是私有段
  assert.equal(isInternalHostname('example.com'), false)
  assert.equal(isInternalHostname(''), true)
})

test('classifyError 四类归因', () => {
  assert.equal(classifyError(new Error('401 未授权')).category, 'auth')
  assert.equal(classifyError(new Error('Failed to fetch')).category, 'network')
  assert.equal(classifyError(new Error('音源已失效，无法导入')).category, 'source')
  assert.equal(classifyError(new Error('其他错误')).category, 'unknown')
})

test('friendlyError 分类文案', () => {
  assert.match(friendlyError(new Error('Failed to fetch')), /网络异常/)
  assert.match(friendlyError(new Error('401 未授权')), /鉴权/)
  // unknown 类使用调用方兜底文案
  assert.match(friendlyError(new Error('其他'), '导入失败'), /^导入失败/)
})
