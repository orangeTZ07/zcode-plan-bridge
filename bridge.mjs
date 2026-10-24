#!/usr/bin/env node
/**
 * zcode-plan-bridge：把 ZCode「Start Plan」（account:zai-start-plan）额度桥接为
 * 本地标准 Anthropic Messages API（/v1/messages），供 ARTEX 等本机工具直接当 LLM 后端。
 *
 * 原理（对本机真实客户端请求的抓包还原 + 风控实测）：
 *   - 鉴权：~/.zcode/v2/credentials.json 里的 `zcodejwttoken`（平台 JWT），Bearer + x-api-key 双带
 *   - 风控：请求必须带全套 ZCode 特征头，且 body.system 必须**以官方提示词前两块原文开头**
 *     （前缀校验；之后可以追加调用方自己的 system 块）。缺失/被改 → 405 code=3012「unusual activity」
 *   - 无需签名（x-client-* 不参与）、无需验证码、无需项目令牌
 *
 * 本桥做的事：
 *   1. 解密 credentials.json 取平台 JWT（每次请求现读，跟随 ZCode 刷新）
 *   2. 把调用方的 body.system 规范化为块数组，前面拼上 system-marker.json（官方前两块原文）
 *   3. 带全套特征头转发到 zcode-plan/anthropic/v1/messages，流式/非流式原样回传
 *
 * 用法：node bridge.mjs  （配置 config.json 首次运行自动生成；system-marker.json 由抓包提取，
 *       ZCode 升级后若出现 405/3012 需重新提取）
 */

import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.join(HERE, 'config.json')
const MARKER_PATH = path.join(HERE, 'system-marker.json')

const UPSTREAM_ORIGIN = 'https://zcode.z.ai'
const MODEL_PATH = '/api/v1/zcode-plan/anthropic/v1/messages'
const APP_VERSION = '3.16.3' // 跟随 ~/.zcode/v2/runtime/provider 下的 builtin 运行时目录名

const log = (...a) => console.log(new Date().toISOString(), ...a)

// ── 配置 ─────────────────────────────────────────────────────────────────────
function loadConfig() {
  const defaults = {
    port: 8790,
    host: '127.0.0.1',
    // 本机调用方（ARTEX）随 api_key 传的口令，首次运行随机生成
    local_api_key: crypto.randomBytes(24).toString('base64url'),
    data_dir: os.homedir(),
    app_version: APP_VERSION,
  }
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }
  } catch {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2))
    return defaults
  }
}
const config = loadConfig()
const MARKER = JSON.parse(fs.readFileSync(MARKER_PATH, 'utf8'))

// ── ZCode 凭据解密（与 zcode.cjs resolveCredentialSecret/deriveCipherKey 一致）──
function readPlanToken() {
  const file = path.join(config.data_dir, '.zcode', 'v2', 'credentials.json')
  const secret = process.env.ZCODE_CREDENTIAL_SECRET?.trim()
    || `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${os.userInfo().username}`
  const key = crypto.createHash('sha256').update(secret).digest()
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const v = raw['zcodejwttoken']
  if (typeof v !== 'string' || !v.startsWith('enc:v1:')) throw new Error('credentials.json 里没有 zcodejwttoken（ZCode 未登录？）')
  const [iv, tag, data] = v.slice(7).split('.')
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
  d.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8')
}

// ── 请求整形 ─────────────────────────────────────────────────────────────────
/** 调用方的 system（字符串或块数组）规范化为块数组。 */
function normalizeSystem(system) {
  if (system === undefined || system === null) return []
  const blocks = typeof system === 'string' ? [{ type: 'text', text: system }] : system
  return blocks.filter((b) => b && typeof b === 'object' && typeof b.text === 'string')
}

/** body.system 必须以官方前两块原文开头（前缀风控），之后保留调用方自己的块。 */
function transformBody(bodyBuf) {
  let j
  try { j = JSON.parse(bodyBuf.toString('utf8')) } catch { return bodyBuf }
  const caller = normalizeSystem(j.system)
  j.system = [...MARKER, ...caller]
  return Buffer.from(JSON.stringify(j), 'utf8')
}

function buildHeaders(bodyLen) {
  const token = readPlanToken()
  const uuid = () => crypto.randomUUID()
  return {
    connection: 'keep-alive',
    'anthropic-version': '2023-06-01',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'http-referer': 'https://zcode.z.ai',
    'user-agent': `ZCode/${config.app_version} ai-sdk/provider-utils/4.0.27 runtime/node.js/${process.versions.node.split('.')[0]}`,
    'x-api-key': token,
    'x-client-language': 'zh-CN',
    'x-client-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
    'x-os-category': process.platform,
    'x-os-version': os.release(),
    'x-platform': `${process.platform}-${process.arch}`,
    'x-query-id': uuid(),
    'x-release-channel': 'production',
    'x-request-id': uuid(),
    'x-session-id': uuid(),
    'x-title': 'Z Code@cli',
    'x-zcode-agent': 'glm',
    'x-zcode-app-version': config.app_version,
    'x-zcode-query-source': 'main_turn',
    'x-zcode-session-type': 'main',
    'x-zcode-trace-id': uuid(),
    accept: '*/*',
    'accept-language': '*',
    'sec-fetch-mode': 'cors',
    'content-length': String(bodyLen),
  }
}

// ── 上游转发 ─────────────────────────────────────────────────────────────────
const DROP_HEADERS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade',
  'expect', 'accept-encoding', 'proxy-authorization', 'proxy-connection',
  'authorization', 'x-api-key', 'x-session-id',
])

function upstreamFetch(headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(`${UPSTREAM_ORIGIN}${MODEL_PATH}`, { method: 'POST', headers, timeout: 600_000 }, resolve)
    req.on('timeout', () => req.destroy(new Error('upstream timeout')))
    req.on('error', reject)
    req.end(body)
  })
}

function relayResponse(up, res, stream) {
  res.writeHead(up.statusCode, {
    'content-type': up.headers['content-type'] ?? 'application/json',
    'cache-control': 'no-cache',
  })
  if (stream) {
    up.pipe(res)
    up.on('error', () => res.destroy())
  } else {
    const chunks = []
    up.on('data', (c) => chunks.push(c))
    up.on('error', () => res.destroy())
    up.on('end', () => res.end(Buffer.concat(chunks)))
  }
}

// ── 本地 HTTP 服务 ───────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0]
  try {
    if (req.method === 'GET' && (url === '/health' || url === '/')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, service: 'zcode-plan-bridge', upstream: UPSTREAM_ORIGIN }))
    }
    const auth = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? req.headers['x-api-key'] ?? ''
    if (auth !== config.local_api_key) {
      res.writeHead(401, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'bridge api key 无效' } }))
    }
    if (req.method !== 'POST' || !url.endsWith('/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { type: 'not_found_error', message: `不支持 ${req.method} ${url}` } }))
    }

    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = transformBody(Buffer.concat(chunks))
    let stream = false
    try { stream = JSON.parse(body.toString('utf8')).stream === true } catch { /* 原样 */ }

    const pass = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (!DROP_HEADERS.has(k) && !k.startsWith('x-zcode-') && k !== 'anthropic-beta') pass[k] = Array.isArray(v) ? v.join(', ') : v
    }
    const headers = { ...buildHeaders(body.length), ...pass }
    headers['content-length'] = String(body.length)

    let up = await upstreamFetch(headers, body)
    // 3012 风控/401：平台 JWT 可能已轮换 → 重读一次凭据重试
    if (up.statusCode === 405 || up.statusCode === 401) {
      up.resume()
      log(`[retry] 上游 ${up.statusCode}，重读凭据重试`)
      up = await upstreamFetch(buildHeaders(body.length), body)
    }
    log(`[proxy] ${up.statusCode} ${stream ? 'SSE' : 'json'} ${body.length}B`)
    relayResponse(up, res, stream)
  } catch (err) {
    log('[error]', err?.message ?? err)
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
    if (!res.writableEnded) res.end(JSON.stringify({ error: { type: 'bridge_error', message: String(err?.message ?? err) } }))
  }
})

server.listen(config.port, config.host, () => {
  log(`[bridge] zcode-plan-bridge 已启动: http://${config.host}:${config.port}/v1/messages`)
  log(`[bridge] 本机调用密钥（ARTEX api_key 填这个）: ${config.local_api_key}`)
})
