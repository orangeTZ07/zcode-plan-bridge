#!/usr/bin/env node
/**
 * update-marker.mjs — ZCode 客户端升级后重提取 system-marker.json。
 *
 * 原理：spawn 官方 `zcode.cjs app-server --stdio`（GUI 同款环境变量），经 stdio JSON-RPC
 * 驱动一轮最小对话；用 net.Socket.prototype.write 补丁抓 TLSSocket 明文，从中取出
 * 发往 zcode-plan/anthropic 请求体里 system 的前两块（风控前缀校验的必需内容），
 * 覆盖写入本目录 system-marker.json。
 *
 * 用法：node update-marker.mjs
 * 前提：本机 ZCode 已登录且 Start Plan 可用；过程消耗一次极小的模型调用。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEMP = os.tmpdir()
const ZCODE_CJS = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs')

function resolveBuiltinRuntime() {
  const platformDir = `windows-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`
  const root = path.join(os.homedir(), '.zcode', 'v2', 'runtime', 'provider', platformDir)
  let best
  for (const ver of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const vdir = path.join(root, ver)
    if (!fs.statSync(vdir).isDirectory() || ver === '0.0.0-dev') continue
    for (const ep of fs.readdirSync(vdir)) {
      const full = path.join(vdir, ep, 'zcode-builtin.json')
      if (ep.startsWith('endpoint-') && fs.existsSync(full)) {
        const mtime = fs.statSync(full).mtimeMs
        if (!best || mtime > best.mtime) best = { version: ver, activeFilePath: full, mtime }
      }
    }
  }
  return best
}

// ① 落地抓包补丁（--require 会在主模块前执行）
const spySrc = `
const net = require('node:net'); const fs = require('node:fs'); const path = require('node:path')
const LOG = path.join(process.env.TEMP || '${TEMP.replace(/\\/g, '\\\\')}', 'zpb-capture.log')
let seq = 0
const orig = net.Socket.prototype.write
net.Socket.prototype.write = function (chunk, ...rest) {
  try {
    if (this.constructor?.name === 'TLSSocket') {
      const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      if (this.__zpb) { if (s) fs.appendFileSync(LOG, \`===NEXT \${this.__zpb}===\\n\` + s.slice(0, 300000) + '\\n') }
      else if (s.includes('zcode-plan')) { this.__zpb = ++seq; fs.appendFileSync(LOG, \`===REQ \${seq}===\\n\` + s.slice(0, 300000) + '\\n') }
    }
  } catch {}
  return orig.call(this, chunk, ...rest)
}`
const spyPath = path.join(TEMP, 'zpb-tls-spy.cjs')
fs.writeFileSync(spyPath, spySrc)
const captureLog = path.join(TEMP, 'zpb-capture.log')
try { fs.unlinkSync(captureLog) } catch {}

const builtin = resolveBuiltinRuntime()
if (!builtin) { console.error('找不到 zcode-builtin.json（ZCode 未登录/未运行过？）'); process.exit(1) }
console.log(`builtin 运行时: ${builtin.version} (${builtin.activeFilePath})`)

// ② 解密 zcodejwttoken（interaction/requestProviderRuntimeHeaders 要回它）
const secret = process.env.ZCODE_CREDENTIAL_SECRET?.trim()
  || `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${os.userInfo().username}`
const key = crypto.createHash('sha256').update(secret).digest()
const rawCreds = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.zcode', 'v2', 'credentials.json'), 'utf8'))
const dec = (v) => {
  const [iv, tag, data] = v.slice(7).split('.')
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
  d.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8')
}
const planToken = dec(rawCreds['zcodejwttoken'])

// ③ spawn app-server（抓包补丁挂上）
const child = spawn(process.execPath, ['--require', spyPath, ZCODE_CJS, 'app-server', '--surface', 'terminal', '--no-color'], {
  cwd: TEMP,
  windowsHide: true,
  env: {
    ...process.env,
    ZCODE_SERVICE_AUTHORITY_MODE: 'desktop-local',
    ZCODE_APP_VERSION: builtin.version,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin.activeFilePath,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json'),
    ZCODE_BASE_URL: 'https://zcode.z.ai',
  },
})
child.stderr.on('data', () => {})

let buf = ''
let nextId = 1
const pending = new Map()
const send = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
})
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.id !== undefined && m.method === undefined) {
      const p = pending.get(m.id)
      if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message ?? JSON.stringify(m.error))) : p.resolve(m.result) }
    } else if (m.method !== undefined && m.id !== undefined) {
      let result = {}
      if (m.method === 'session/requestRuntimePreferences') {
        result = { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true, modelContextBudgetStrategy: 'preflight-v1' }
      } else if (m.method === 'interaction/requestProviderRuntimeHeaders') {
        result = { headersApplied: true, requestAuth: { apiKey: planToken, headers: { 'http-referer': 'https://zcode.z.ai', 'user-agent': `ZCode/${builtin.version}`, 'x-zcode-app-version': builtin.version, 'x-title': 'Z Code@cli' } } }
      } else if (m.method === 'interaction/browserList') result = { browsers: [] }
      else if (/permission|browser/i.test(m.method)) result = { decision: 'allow' }
      child.stdin.write(JSON.stringify({ id: m.id, result }) + '\n')
    } else if (m.method === 'session/event') {
      const t = m.params?.type ?? m.params?.payload?.type
      if (t === 'turn.completed' || t === 'turn.failed') {
        console.log('回合结束:', t)
        setTimeout(() => { try { child.kill() } catch {} ; process.exit(0) }, 1200)
      }
    }
  }
})

// ④ 等就绪 → 注入账户 → 建会话 → 切模型 → 发一轮
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await new Promise((resolve) => {
  const timer = setTimeout(resolve, 12000)
  child.stdout.on('data', function h(c) {
    if (/startup\//.test(String(c)) && /"phase":"(ready|committing)"/.test(c)) { clearTimeout(timer); child.stdout.off('data', h); resolve() }
  })
})
const revision = JSON.parse(fs.readFileSync(builtin.activeFilePath, 'utf8')).revision
const sha = crypto.createHash('sha256').update(path.resolve(builtin.activeFilePath)).digest('hex')
await send('provider/updateAccountConfig', {
  revision: `zcode-plan-bridge:${Date.now()}`,
  basedOnZCodeBuiltinRevision: `zcode-builtin:${revision}:${sha}`,
  providers: { 'account:zai-start-plan': { access: { type: 'zhipu-account', entitled: true }, builtinModelIds: ['GLM-5.3-Flash'] } },
  states: { 'account:zai-start-plan': { availability: 'available', entitled: true, current: true } },
}).catch((e) => console.error('注入失败:', e.message))
await sleep(2000)
const created = await send('session/create', { workspace: { workspacePath: TEMP, workspaceKey: 'zcode-plan-bridge-marker' } })
const sessionId = created?.session?.sessionId
if (!sessionId) { console.error('session/create 没返回 sessionId'); process.exit(1) }
await send('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous', afterSeq: 0, includeSnapshot: true })
await send('session/setModel', { sessionId, model: { providerId: 'account:zai-start-plan', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'max' } } }).catch(() => {})
await sleep(1500)
await send('session/send', { sessionId, content: 'reply with exactly: ok' }).catch((e) => console.error('send 失败:', e.message))
setTimeout(() => { console.error('超时（120s）——检查 ZCode 登录态'); try { child.kill() } catch {}; process.exit(1) }, 120_000)

// ⑤ 进程退出后解析抓包（用 exit 钩子，因为子进程事件流结束即退）
process.on('exit', () => {
  try {
    const data = fs.readFileSync(captureLog, 'utf8')
    // 按 socket 重组：===REQ n=== 起头（请求行+头），===NEXT n=== 续（体）
    const NL = String.fromCharCode(10)
    const markerRe = new RegExp('===(REQ|NEXT) (\\d+)===' + NL, 'g')
    const marks = []
    let mm
    while ((mm = markerRe.exec(data)) !== null) marks.push({ kind: mm[1], sock: mm[2], start: markerRe.lastIndex })
    const sockData = {}
    for (let i = 0; i < marks.length; i++) {
      const end = i + 1 < marks.length ? marks[i + 1].start : data.length
      const content = data.slice(marks[i].start, end).replace(new RegExp(NL + '$'), '')
      sockData[marks[i].sock] = (sockData[marks[i].sock] ?? '') + content
    }
    const raw = Object.values(sockData).find((r) => r.includes('zcode-plan'))
    if (!raw) { console.error('没抓到发往 zcode-plan 的请求'); process.exit(1) }
    const mCl = raw.match(new RegExp('content-length: (\\d+)\\s*' + NL))
    const bodyStart = raw.indexOf('{')
    if (!mCl || bodyStart < 0) { console.error('请求结构异常'); process.exit(1) }
    // content-length 是字节数；Buffer 截取避免多字节字符错位
    const bytes = Buffer.from(raw.slice(bodyStart), 'utf8')
    const j = JSON.parse(bytes.subarray(0, Number(mCl[1])).toString('utf8'))
    if (!Array.isArray(j.system) || j.system.length < 2) { console.error('system 块不足 2 块，格式变了？'); process.exit(1) }
    const marker = j.system.slice(0, 2).map((b) => ({ type: 'text', text: b.text }))
    fs.writeFileSync(path.join(HERE, 'system-marker.json'), JSON.stringify(marker, null, 1))
    console.log('✅ system-marker.json 已更新（text 长度:', marker.map((m) => m.text.length).join(', ') + '）')
  } catch (e) {
    console.error('解析失败:', e.message)
    process.exit(1)
  }
})
