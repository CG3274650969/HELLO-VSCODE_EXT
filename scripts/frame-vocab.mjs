#!/usr/bin/env node
/**
 * frame-vocab.mjs —— 只读盘点 DSH 抓帧 JSONL 的「入站消息词汇表」。
 *
 * 用途（第 0 步：词汇盘点）：列出某批真实帧里的通知方法 / session.event 内
 * event.type / 请求-响应行，供与「已知消费面」和 DSH 官方 known-event-types.ts
 * 对拍，找出 wire 上「已见 / 未见 / 触发后才见」的事件。零副作用：不 spawn、
 * 不写盘、不读密钥 —— 只读 logs/dsh-frames/（默认）或指定文件/目录。
 *
 * 用法：
 *   node scripts/frame-vocab.mjs                             扫描 logs/dsh-frames/ 全部帧（新→旧）
 *   node scripts/frame-vocab.mjs <file.jsonl>                只看单个文件
 *   node scripts/frame-vocab.mjs <dir>                       只看某目录下全部帧
 *   node scripts/frame-vocab.mjs <target> --baseline <base>  目标词汇 − 基线词汇 = 「新增」差集
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')

const argv = process.argv.slice(2)
const positional = argv.filter((a) => !a.startsWith('--'))
const baseIdx = argv.indexOf('--baseline')
const baselineArg = baseIdx >= 0 ? argv[baseIdx + 1] : undefined

/** 单文件盘点：通知方法计数、session.event 内 event.type 计数、非 JSON 行、请求-响应成败。 */
function inventory(lines) {
  const notif = {}
  const events = {}
  let nonJson = 0
  const resp = { ok: 0, err: 0 }
  for (const l of lines) {
    let o
    try {
      o = JSON.parse(l)
    } catch {
      nonJson += 1
      continue
    }
    if (!o || typeof o !== 'object') {
      nonJson += 1
      continue
    }
    if (typeof o.method === 'string') {
      notif[o.method] = (notif[o.method] || 0) + 1
      // wire 上事件包在 session.event 通知的 params.event 里
      if (o.method === 'session.event' && o.params?.event?.type) {
        events[o.params.event.type] = (events[o.params.event.type] || 0) + 1
      }
    } else if (typeof o.id === 'number') {
      if (o.error !== undefined) resp.err += 1
      else resp.ok += 1
    } else {
      nonJson += 1
    }
  }
  return { notif, events, nonJson, resp }
}

function linesOf(p) {
  return readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
}

function filesUnder(target) {
  if (!existsSync(target)) return []
  if (statSync(target).isDirectory()) {
    return readdirSync(target)
      .filter((n) => n.endsWith('.jsonl'))
      .sort()
      .reverse() // 文件名含时间戳，字典序倒排≈新→旧
      .map((n) => join(target, n))
  }
  return [target]
}

const key = (o) => Object.keys(o).sort()
const fmt = (o) => key(o).map((k) => `${k}=${o[k]}`).join(' ')

// ---- 目标与基线文件集 ----
const target = positional[0] ? resolve(positional[0]) : join(repo, 'logs', 'dsh-frames')
const targets = filesUnder(target)
if (!targets.length) {
  console.error(`✗ 没有可盘点的 .jsonl：${target}`)
  process.exit(2)
}

let baselineFiles = []
if (baselineArg) {
  baselineFiles = filesUnder(resolve(baselineArg))
  if (!baselineFiles.length) {
    console.error(`✗ 基线没有 .jsonl：${baselineArg}`)
    process.exit(2)
  }
}

const unionNotif = {}
const unionEvents = {}
const unionResp = { ok: 0, err: 0 }

console.log('== 逐帧词汇 ==')
for (const f of targets) {
  const inv = inventory(linesOf(f))
  for (const m of Object.keys(inv.notif)) unionNotif[m] = (unionNotif[m] || 0) + inv.notif[m]
  for (const e of Object.keys(inv.events)) unionEvents[e] = (unionEvents[e] || 0) + inv.events[e]
  unionResp.ok += inv.resp.ok
  unionResp.err += inv.resp.err
  console.log(`\n${f}`)
  console.log(`  notify : ${fmt(inv.notif) || '(无)'}`)
  console.log(`  events : ${fmt(inv.events) || '(无)'}`)
  console.log(`  resp ok=${inv.resp.ok} err=${inv.resp.err} 非JSON=${inv.nonJson}`)
}
console.log(`\n== 并集（${targets.length} 个文件）==`)
console.log(`notify : ${fmt(unionNotif) || '(无)'}`)
console.log(`events : ${fmt(unionEvents) || '(无)'}`)
console.log(`resp   : ok=${unionResp.ok} err=${unionResp.err}`)

// ---- 差集：目标 − 基线（第 0 步「已知消费面之外的新词表」） ----
if (baselineFiles.length) {
  const baseNotif = {}
  const baseEvents = {}
  for (const f of baselineFiles) {
    const inv = inventory(linesOf(f))
    for (const m of Object.keys(inv.notif)) baseNotif[m] = (baseNotif[m] || 0) + inv.notif[m]
    for (const e of Object.keys(inv.events)) baseEvents[e] = (baseEvents[e] || 0) + inv.events[e]
  }
  const newNotif = key(unionNotif).filter((m) => !(m in baseNotif))
  const newEvents = key(unionEvents).filter((e) => !(e in baseEvents))
  console.log(`\n== 新增词汇（未见于基线 ${baselineFiles.length} 个文件）==`)
  console.log(`notify : ${newNotif.join(' ') || '(无新增)'}`)
  console.log(`events : ${newEvents.join(' ') || '(无新增)'}`)
}
