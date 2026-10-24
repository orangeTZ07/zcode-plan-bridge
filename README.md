# zcode-plan-bridge

把 **ZCode 桌面客户端**的 Start Plan / Coding Plan 订阅额度（`account:zai-start-plan`）桥接为本地标准
**Anthropic Messages API**，让 ARTEX、Claude Code、任意 OpenAPI 客户端等本机工具直接把 GLM 当 LLM 后端用。

- 端点：`http://127.0.0.1:8790/v1/messages`（Anthropic 协议：流式 SSE / `tools` 工具调用 / thinking 全支持）
- 上游：`https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`（官方客户端同款通道）
- 零第三方依赖：单文件 Node.js（≥18，建议 24），无需浏览器、无需打码、无需签名逆向复刻

## 快速开始

```cmd
git clone https://github.com/orangeTZ07/zcode-plan-bridge.git
cd zcode-plan-bridge
start-bridge.cmd        :: 首次运行自动生成 config.json（含随机 local_api_key）
```

配置 `config.json`（自动生成）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `port` / `host` | `8790` / `127.0.0.1` | 本地监听地址 |
| `local_api_key` | 随机生成 | 调用方要填的 api_key |
| `data_dir` | `%USERPROFILE%` | ZCode 凭据所在目录 |
| `app_version` | 随版本 | 特征头版本号，跟随 `~/.zcode/v2/runtime/provider/` 目录名 |

健康检查：`GET /health`。调用示例：

```bash
curl http://127.0.0.1:8790/v1/messages \
  -H "Authorization: Bearer <local_api_key>" -H "Content-Type: application/json" \
  -d '{"model":"GLM-5.3-Flash","max_tokens":64,"stream":false,
       "messages":[{"role":"user","content":"reply exactly: ok"}]}'
```

模型名原样透传：Start Plan 官方列表是 `GLM-5.3-Flash` / `GLM-5.2` / `GLM-5-Turbo`，
`GLM-5.3`（非 flash）实测也能出字，但不在官方声明列表里，额度消耗更快，自行斟酌。

## 对接 ARTEX

ARTEX WebUI → LLM 配置（或 `POST /api/llm`）：

- Provider：`anthropic`　Model：`GLM-5.3-Flash`
- Base URL：`http://127.0.0.1:8790`　API Key：`config.json` 里的 `local_api_key`

## 工作原理

对本机真实客户端的线上请求做明文抓包 + 逐字段二分实测，结论是上游只关心两件事：

1. **鉴权**：每次请求现读并解密 `~/.zcode/v2/credentials.json` 的 `zcodejwttoken`
   （AES-256-GCM，密钥 = SHA-256(机器指纹)，派生方式与 `zcode.cjs` 完全一致，跟随客户端刷新），
   `Authorization: Bearer` + `x-api-key` 双带。
2. **system 前缀校验（风控关键）**：请求体 `system` 字段必须以**官方提示词前两块的原文**开头
   （见 `system-marker.json`，缺失或改动一个字符都会被拒：
   `405 {"code":3012,"msg":"request has been blocked due to unusual activity."}`）。
   本桥把调用方的 system 规范化后**拼在 marker 之后**，模型同时看到 ZCode 身份与调用方自己的系统提示。

其余请求体（`messages` / `tools` / `thinking` / `stream`…）与响应（含 SSE 事件流）原样透传。

**不需要**：`x-client-sig` 等请求签名（抓包证实真实客户端对 zcode-plan 通道也是 unsigned）、
阿里云无痕验证码、项目令牌 / `access_tokens` 换发、Ed25519 握手。

## 维护

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| 上游 `401` | ZCode 登录态失效 | 重新登录 ZCode 桌面端 |
| 上游 `405` / `code:3012` | 官方提示词更新，前缀校验失败 | `node update-marker.mjs` 重抓 marker；必要时更新 `config.json` 的 `app_version` |
| 找不到 `zcodejwttoken` | ZCode 未登录 | 登录 ZCode |
| 端口被占 | 已有实例在跑 | 改 `config.json` 的 `port` |

`update-marker.mjs` 的工作方式：spawn 官方 `zcode.cjs app-server --stdio`（GUI 同款环境变量），经
stdio JSON-RPC 驱动一轮最小对话，用 `net.Socket.prototype.write` 的 TLSSocket 明文钩子抓下真实请求，
提取 `system` 前两块覆盖 `system-marker.json`。过程消耗一次极小的模型调用。

`config.json` / `*.log` 均在 `.gitignore`，密钥不入库。

## 致谢与背景

- [kyle123740/dsh-zcode-cli-proxy](https://github.com/kyle123740/dsh-zcode-cli-proxy)：最早公开
  app-server 通道与 `requestProviderRuntimeHeaders` → `zcodejwttoken` 链路，本项目思路受其启发
- [liu5269/zcode2api](https://github.com/liu5269/zcode2api)：验证码方案路线（本项目最终绕开了它，
  但其仓库文档对定位风控边界帮助很大）

## 免责声明

本项目仅供个人在本机把自己的订阅额度对接给自己的工具链。上游风控策略随时可能变更导致失效；
请自行评估并遵守 Z.AI / ZCode 的服务条款，勿用于商业转售或账号池等滥用场景。
