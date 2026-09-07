#!/usr/bin/env node
/**
 * Phase-0「抓真实运行原始帧」：用与扩展完全相同的 spawn/握手/发消息方式，把 DSH
 * jsonrpc runtime 的**每一条入站 JSON-RPC 行**原样落到 JSONL，供与 ui-conversation
 * conversation-node 期望的事件词汇表对拍（Phase 1 信任基础）。
 *
 * 触发路径复刻 chatViewProvider._makeSpawnRequest / _doConnectLive / _runLive：
 *   command = node(v24) --import tsx/esm <entry> <cordis.yml>
 *   initialize { cwd, provider, model } → session/prompt { sessionId, contentBlocks }
 *
 * 密钥：DEEPSEEK_API_KEY（env）优先，否则回退 credentialsFile（同扩展 regex）。
 * 只注入子进程 env；**绝不打印 / 绝不写入日志**（本脚本只在终端回显掩码尾 4 位）。
 *
 * 用法： node scripts/capture-dsh-frames.mjs [out.jsonl]
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const outFile = process.argv[2]
  ?? join(repo, 'logs', 'dsh-frames', `frames-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)

// ---- 机器专属 DSH 路径全部走环境变量（不落仓库；缺省即未配置，运行前按下方提示设好） ----
//   DSH_CAP_NODE    = node 可执行文件（v18+，支持 --import）
//   DSH_CAP_ENTRY   = DSH jsonrpc-agent 入口脚本（如 …/jsonrpc-demo/src/bin.ts）
//   DSH_CAP_CONFIG  = runtime 部署配置 cordis.yml
//   DSH_CAP_RUNCWD  = 子进程工作目录（保证 tsx / @deepseek-ai/* 能解析）
//   DSH_CAP_TSCONFIG= tsx 用的 tsconfig
//   DSH_CAP_CRED    = 回退读取 DEEPSEEK_API_KEY 的 YAML 文件（可选）
const NODE = process.env.DSH_CAP_NODE ?? ''
const ENTRY = process.env.DSH_CAP_ENTRY ?? ''
const CONFIG = process.env.DSH_CAP_CONFIG ?? ''
const RUNCWD = process.env.DSH_CAP_RUNCWD ?? ''
const TSCONFIG = process.env.DSH_CAP_TSCONFIG ?? ''
const LOADER = 'tsx/esm'
const PROVIDER = process.env.DSH_CAP_PROVIDER ?? 'deepseek-official'
const MODEL = process.env.DSH_CAP_MODEL ?? 'deepseek-v4-flash'
// 工具真实工作目录：默认跑在扩展仓库根；echo-only 提示词，零副作用
const TOOLCWD = process.env.DSH_CAP_TOOLCWD ?? repo

// ---- 密钥解析（绝不打印值） ----
function readApiKey() {
  const fromEnv = process.env.DEEPSEEK_API_KEY
  if (fromEnv) return fromEnv
  const file = process.env.DSH_CAP_CRED ?? ''
  if (!file || !existsSync(file)) return undefined
  const text = readFileSync(file, 'utf8')
  const m = text.match(/^\s*DEEPSEEK_API_KEY\s*[:=]\s*(.+?)\s*$/m)
  if (!m || !m[1]) return undefined
  let v = m[1].trim()
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    v = v.slice(1, -1)
  }
  return v || undefined
}

function maskTail(key) {
  if (!key) return '(未找到)'
  return '****' + key.slice(-4)
}

// ---- 探针缺文件快速失败 ----
for (const [name, p] of [['node', NODE], ['entry', ENTRY], ['config', CONFIG], ['runCwd', RUNCWD], ['tsconfig', TSCONFIG]]) {
  if (!p || !existsSync(p)) {
    console.error(
      `✗ ${name} ${p ? '不存在' : '未设置'}：${p}\n` +
      `  请在环境变量里设好（本仓库不含机器路径）：DSH_CAP_${name.toUpperCase().padEnd(8, ' ')}` +
      (p ? '\n  或改为你的真实 DSH 路径。' : '')
    )
    process.exit(2)
  }
}

const key = readApiKey()
console.log(`API key: ${maskTail(key)}`)

const sessionRoot = join(os.tmpdir(), 'dsh-capture-sessions')
mkdirSync(sessionRoot, { recursive: true })
mkdirSync(dirname(outFile), { recursive: true })

const sessionId = `capture-${Date.now()}`
const promptText = '请用 bash 工具执行命令 `echo DSH-FRAME-CAPTURE-OK`，然后只回复命令的输出内容。不要做别的操作。'

// ---- spawn（同扩展；stdout 全保留给 JSON-RPC） ----
const child = spawn(NODE, ['--import', LOADER, ENTRY, CONFIG], {
  cwd: RUNCWD,
  env: {
    ...process.env,
    DSH_CORDIS_CONFIG: CONFIG,
    TSX_TSCONFIG_PATH: TSCONFIG,
    DSH_SESSION_ROOT: sessionRoot,
    DSH_CWD: TOOLCWD,
    DEEPSEEK_API_KEY: key ?? '',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})

let lines = 0
const order = [] // 人类可读的入站顺序摘要
const rawLines = []
const pending = new Map() // id -> method（为了在响应当口标注）
let nextId = 0
let sawEvent = false
let finished = false

function send(method, params) {
  const id = ++nextId
  pending.set(id, method)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  order.push(`→ send ${method}`)
  console.log(`→ send ${method}`)
  return id
}

function finish(reason) {
  if (finished) return
  finished = true
  try {
    child.stdin.end()
  } catch { /* 已关 */ }
  try {
    child.kill()
  } catch { /* 已退出 */ }
  writeFileSync(outFile, rawLines.join('\n') + '\n', 'utf8')
  console.log(`\n✎ ${lines} 条入站行 → ${outFile}\n`)
  console.log('--- 入站顺序摘要 ---')
  for (const o of order) console.log('  ' + o)
  setTimeout(() => process.exit(0), 100)
}

child.on('error', (err) => {
  console.error('✗ spawn 失败：', err.message)
  process.exit(2)
})
child.stderr.on('data', (d) => {
  const s = String(d)
  if (s.trim()) process.stderr.write(`[child:stderr] ${s}`)
})

const rl = createInterface({ input: child.stdout })
rl.on('line', (line) => {
  lines += 1
  rawLines.push(line)
  let obj
  try {
    obj = JSON.parse(line)
  } catch {
    order.push(`! 非 JSON 行`)
    return
  }
  const m = obj
  if (typeof m?.id === 'number' && m.method === undefined) {
    const method = pending.get(m.id) ?? '?'
    pending.delete(m.id)
    const ok = m.error === undefined
    const tag = ok ? 'ok' : `err ${JSON.stringify(m.error).slice(0, 160)}`
    order.push(`← resp#${m.id} ${method} ${tag}`)
    console.log(`← resp#${m.id} ${method} ${tag}`)
    return
  }
  if (typeof m?.method === 'string' && m.params && typeof m.params === 'object') {
    const method = m.method
    const p = m.params
    if (method === 'session.status') {
      order.push(`← notify session.status ${p.status}`)
      console.log(`← notify session.status ${p.status}`)
      if (p.status === 'idle' && sawEvent) setTimeout(() => finish('status idle'), 400)
      return
    }
    if (method === 'session.event') {
      sawEvent = true
      const ev = p.event ?? {}
      const kind = typeof ev.type === 'string' ? ev.type : '?'
      const sub = ev.type === 'assistant/chunk'
        ? ` chunk=${ev.data?.chunk?.type}`
        : ev.type === 'turn/end'
          ? ` reason=${ev.data?.reason?.kind}`
          : ''
      order.push(`← event ${kind}${sub}`)
      console.log(`← event ${kind}${sub}`)
      return
    }
    order.push(`← notify ${method}`)
    console.log(`← notify ${method}`)
    return
  }
  order.push(`← (其它 JSON)`)
})

// ---- 握手 → 发一轮 → 等收尾 ----
send('initialize', { cwd: TOOLCWD, provider: PROVIDER, model: MODEL })
const watchdog = setTimeout(() => finish('watchdog'), 240_000)

// 等 initialize 回执后发 prompt
const poller = setInterval(() => {
  if (finished) {
    clearInterval(poller)
    return
  }
  if (pending.size === 0 && order.some((o) => o.includes('resp#1 initialize'))) {
    clearInterval(poller)
    send('session/prompt', {
      sessionId,
      contentBlocks: [{ type: 'text', text: promptText }],
    })
  }
}, 100)
