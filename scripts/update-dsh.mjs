#!/usr/bin/env node
/**
 * update-dsh.mjs —— 把本地 DSH 检出当作「版本化运行时依赖」治理
 *
 * 为什么做、决策依据见 docs/runtime-dependency.md（目标 B = 稳定长期用 + 追 DSH 版本）。
 * 官方 npm 目前没有可替换「交互 stdio JSON-RPC」的成熟发行（版本分裂 + 编排插件未全发），
 * 所以先治理源码检出：锁 tag、可复现地升级、升级后冒烟，把「浮动检出」变成「vendored runtime」。
 *
 * 用法（<dsh仓库根> 为必填，如 D:\DSH\deepseek-harness）：
 *   node scripts/update-dsh.mjs <根>                 只读：校验锁点/关键结构/是否漂移
 *   node scripts/update-dsh.mjs <根> --expected <v>   断言 package.json version == v（锁版本）
 *   node scripts/update-dsh.mjs <根> --fetch          额外 git fetch --tags origin 后报告最新 tag
 *   node scripts/update-dsh.mjs <根> --to <tag|ref>   升级：checkout → pnpm install → build → 冒烟
 *   node scripts/update-dsh.mjs <根> --smoke          只跑冒烟
 *
 * 选项：
 *   --node <node.exe>  冒烟/构建用的 node（默认 process.execPath）
 *   --skip-build       --to 时跳过 pnpm run build（仅用于本地已构建的调试场景）
 *   --allow-dirty      --to 时允许工作区含已跟踪改动（默认要求干净，避免带脏升级）
 *
 * 安全：不读不写任何密钥；不触碰 DSH_CAP_* / DEEPSEEK_API_KEY；不硬编码机器路径。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'

// ---------- 参数 ----------
const argv = process.argv.slice(2)
const rootArg = argv.find((a) => !a.startsWith('--'))
const get = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (flag) => argv.includes(flag)

const win = process.platform === 'win32'

const ROOT = rootArg ? resolve(rootArg) : ''
const EXPECTED = get('--expected')
const TO_REF = get('--to')
const DO_FETCH = has('--fetch')
const DO_SMOKE = has('--smoke')
const SKIP_BUILD = has('--skip-build')
const ALLOW_DIRTY = has('--allow-dirty')

const ROOT_PKG = '@deepseek-ai/dsh-root'

function fail(msg, code = 1) {
  console.error(`✗ ${msg}`)
  process.exit(code)
}

if (!ROOT) {
  console.error(
    '用法：node scripts/update-dsh.mjs <dsh仓库根> [--expected <v>] [--fetch] [--to <tag|ref>] [--smoke] [--node <node.exe>] [--skip-build] [--allow-dirty]\n' +
      '  其中 <dsh仓库根> 是你的 DSH 检出（本仓库不含任何机器路径）。'
  )
  process.exit(2)
}
if (!existsSync(ROOT)) fail(`DSH 检出不存在：${ROOT}`, 2)
if (!existsSync(resolve(ROOT, 'package.json'))) fail(`没有 package.json，不是 DSH 检出：${ROOT}`, 2)

// ---------- 基础命令 ----------
/** Windows shell 需要把含空格/引号的参数包起来（本仓库参数无 &|<> 等，只需处理空格）。 */
function shArg(s) {
  s = String(s)
  return /[\s"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

/** spawnSync 包装：cwd 固定为 DSH 检出根。win 下拼成一条命令串走 shell（git/pnpm 的 .cmd
 *  需要）；非 win 直接传参数数组。返回 {status, stdout, stderr}。expect 给定时退出码不符即 fail。 */
function run(cmd, args, opts = {}) {
  const { cwd = ROOT, expect, timeout = 120_000 } = opts
  const r = win
    ? spawnSync([shArg(cmd), ...args.map(shArg)].join(' '), {
        cwd,
        encoding: 'utf8',
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        shell: true,
        windowsHide: true,
      })
    : spawnSync(cmd, args, {
        cwd,
        encoding: 'utf8',
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      })
  if (r.status === null) {
    fail(`\`${cmd}\` 未能启动（命令不存在或超时）：${r.error?.message ?? ''}`)
  }
  if (expect !== undefined && r.status !== expect) {
    const tail = (r.stderr || r.stdout || '').trim().slice(-600)
    fail(`\`${cmd} ${args.join(' ')}\` 退出码 ${r.status}（期望 ${expect}）${tail ? '\n  ' + tail : ''}`)
  }
  return r
}

// ---------- 读取锁点事实 ----------
function pkgJson() {
  return JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))
}
function git(args, opts) {
  return run('git', args, { expect: 0, ...opts })
}

// ---------- node 选择：--node > DSH_NODE > DSH_CAP_NODE（与抓帧工具同义）> 检出旁 tools/node-v*
//          > process.execPath。DSH 需要 ^22.19.0 || >=24.0.0，系统 PATH 的旧 node 往往不够；
//          尤其冒烟/构建要 --import（需 node ≥18.19）。----------
function bundledNodeUnder(parentTools) {
  // 布局：<node根>/tools/node-v24.19.0-win-x64/node.exe（win）或 …/tools/node-v…/bin/node
  const exeRel = win ? (n) => join(n, 'node.exe') : (n) => join(n, 'bin', 'node')
  try {
    const candidates = readdirSync(parentTools)
      .filter((n) => n.startsWith('node-v'))
      .sort()
      .reverse() // 版本号数字段等长时字典序倒排即近似“最新优先”
    for (const name of candidates) {
      const exe = exeRel(join(parentTools, name))
      if (existsSync(exe)) return exe
    }
  } catch {
    /* parentTools 不存在或不可读：走回退链 */
  }
  return undefined
}

const NODE =
  get('--node') ||
  process.env.DSH_NODE ||
  process.env.DSH_CAP_NODE ||
  bundledNodeUnder(ROOT ? join(dirname(ROOT), 'tools') : '') ||
  process.execPath

const NODE_VER = (run(NODE, ['--version']).stdout || '').trim()
const NODE_MAJOR = Number((NODE_VER.match(/^v?(\d+)/) || [])[1])
if (!NODE_MAJOR || NODE_MAJOR < 18) {
  fail(
    `所选 node 过旧：${NODE}（${NODE_VER || '(无法读取版本)'}）。\n` +
      `  --import（冒烟/构建）需 node ≥18.19，DSH engines 需 ^22.19.0 || >=24.0.0。\n` +
      `  用 --node <node.exe> 或 DSH_NODE / DSH_CAP_NODE 指向新版（如检出旁 tools/node-v24.*/node.exe），`,
    2,
  )
}

const pkg = pkgJson()
if (pkg.name !== ROOT_PKG) fail(`package.json name=${pkg.name}，不是 ${ROOT_PKG}`, 2)

console.log(`DSH 检出    : ${ROOT}`)
console.log(`package     : ${pkg.name}@${pkg.version}`)
console.log(`engines.node: ${pkg.engines?.node ?? '(未声明)'}`)
console.log(`node 使用   : ${NODE}`)
console.log(`node 版本   : ${NODE_VER}`)

if (EXPECTED !== undefined) {
  if (pkg.version === EXPECTED) console.log(`✓ --expected 锁点一致：${EXPECTED}`)
  else fail(`--expected=${EXPECTED} 但检出实际 ${pkg.version}（检出漂移或该升级了）`, 1)
}

// ---------- git 锁点 / 漂移 ----------
if (!existsSync(resolve(ROOT, '.git'))) fail('检出没有 .git，无法做版本锁点管理（vender 请带 git 历史）', 2)

const headShort = git(['rev-parse', '--short', 'HEAD']).stdout.trim()
const branch = run('git', ['branch', '--show-current']).stdout.trim()
const exactTag = run('git', ['describe', '--exact-match', '--tags', 'HEAD'], {
  expect: undefined,
  silent: true,
})
const dirtyTracked = run('git', ['status', '--porcelain', '--untracked-files=no']).stdout.trim()
console.log(`HEAD        : ${headShort}${branch ? ` (branch ${branch})` : ''}`)
if (exactTag.status === 0) console.log(`在 tag 上    : ${exactTag.stdout.trim()}  ✓ 可复现锁点`)
else console.log(`⚠ 不在任何 tag 上：${exactTag.stdout?.trim() || '(detached/漂移)'} —— 建议锁到 release tag`)

if (TO_REF === undefined && !DO_SMOKE && EXPECTED === undefined && !DO_FETCH) {
  // 纯 check 也要提示漂移
  if (dirtyTracked) console.log(`⚠ 工作区有已跟踪改动 ${dirtyTracked.split('\n').length} 处（升级前请先处理）`)
}

if (DO_FETCH) {
  console.log('…git fetch --tags origin（需要网络；若失败请自查代理）')
  const f = run('git', ['fetch', '--tags', 'origin'], { expect: undefined })
  if (f.status !== 0) {
    console.error('✗ fetch 失败。若你有本地代理，可手动执行：\n    git -c http.proxy=http://127.0.0.1:<端口> -c https.proxy=http://127.0.0.1:<端口> fetch --tags origin')
    process.exit(1)
  }
  const newest = run('git', ['tag', '--sort=-version:refname']).stdout.split('\n').map((s) => s.trim()).filter(Boolean)[0]
  console.log(`✓ fetch 完成；最新 tag（按版本序）：${newest || '(无 tag)'}`)
}

// ---------- 关键结构校验 ----------
const NEED = {
  入口: 'packages/examples/jsonrpc-demo/src/bin.ts',
  部署配置: 'examples/jsonrpc-agent/cordis.yml',
  tsconfig: 'tsconfig.json',
  pnpm锁: 'pnpm-lock.yaml',
  依赖已装: 'node_modules/.pnpm',
}
for (const [label, rel] of Object.entries(NEED)) {
  if (existsSync(resolve(ROOT, rel))) console.log(`✓ ${label} 存在：${rel}`)
  else fail(`缺 ${label}：${rel}（要先 pnpm install / 检出完整）`, 2)
}

// ---------- 冒烟：无配置跑入口，应打印 usage 到 stderr 并退出 1 ----------
function smoke() {
  console.log(`…冒烟：${NODE} --import tsx/esm ${NEED.入口}（无配置 → 期望 usage + exit 1）`)
  const r = run(NODE, ['--import', 'tsx/esm', resolve(ROOT, NEED.入口)], {
    expect: undefined,
    timeout: 30_000,
    silent: true,
  })
  const err = (r.stderr || '').trim()
  if (r.status === 1 && err.includes('usage:')) {
    console.log('✓ 冒烟通过：tsx + 入口 + app-boot 可加载，usage 正常退出')
    return true
  }
  console.error(`✗ 冒烟失败：status=${r.status}，stderr:\n${err.slice(-800) || '(空)'}`)
  return false
}

// ---------- 升级：--to ----------
if (TO_REF !== undefined) {
  if (dirtyTracked && !ALLOW_DIRTY) {
    fail(`工作区有已跟踪改动，拒绝带脏升级。提交/暂存后重试，或加 --allow-dirty 强制`, 2)
  }
  console.log(`…checkout ${TO_REF}`)
  run('git', ['fetch', '--tags', 'origin'], { expect: undefined })
  git(['checkout', TO_REF])
  const after = pkgJson()
  console.log(`✓ 已切到 ${TO_REF} → ${after.name}@${after.version}`)
  if (!SKIP_BUILD) {
    console.log('…pnpm install（可能较久）')
    run('pnpm', ['install'], { expect: 0, timeout: 900_000 })
    console.log('…pnpm run build（可能较久）')
    run('pnpm', ['run', 'build'], { expect: 0, timeout: 900_000 })
    console.log('✓ pnpm install + build 完成')
  } else {
    console.log('--skip-build：跳过构建（未验证，注意）')
  }
}

const ok = smoke()
if (TO_REF !== undefined && ok) {
  console.log('\n升级后手动冒烟清单（F5）：')
  console.log('  1. 打开扩展 → Harness 页签，状态点应转绿「在线 · <模型>」')
  console.log('  2. 发一句话，确认工具卡 + 转写正常（真实会话）')
  console.log('  3. 若本次跨了大版本，跑一次 scripts/capture-dsh-frames.mjs 核对事件词表有无漂移')
  console.log('  4. 有改动把 docs/runtime-dependency.md 的“锁定版本”更新到新版本')
}
if (!ok) process.exit(1)
