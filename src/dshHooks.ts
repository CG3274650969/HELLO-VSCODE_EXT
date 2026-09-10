/**
 * C1 事前审批：生成 DSH 侧需要的三个文件（全部落在扩展 globalStorage，绝不进仓库/工作区）。
 *
 *   1. `dsh-hooks/approval-hook.mjs` —— 真正的 hook 脚本（node 跑；见文件头注释）
 *   2. `dsh-hooks/hooks.json`        —— CC 方言 hook 配置，PreToolUse + matcher:bash
 *   3. `dsh-config/cordis.yml`       —— **派生配置** = 用户那份 cordis.yml 原文 + 末尾追加
 *                                       一个 hooks-claude-code 插件块
 *
 * 为什么要派生配置：DSH 的 hooks 插件只能从 cordis.yml 里挂载，而用户那份配置是他们的
 * 东西（我们不该改）。扩展本来就拥有 `DSH_CORDIS_CONFIG` 的注入权，所以指向这份副本即可。
 * 追加前先确认根是**块状序列**（cordis.yml 的插件表就是顶层列表），不是就拒绝生成、
 * 由调用方降级 —— 绝不改写用户原文。
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

/** 生成结果：三个文件的绝对路径 + 实际下发的 hook 命令（自检也用它） */
export interface ApprovalHookFiles {
  /** 派生 cordis.yml（指向它当 DSH_CORDIS_CONFIG） */
  cordisPath: string;
  /** hooks.json（派生配置里 configPath 指它） */
  hooksPath: string;
  /** hook 脚本本体 */
  scriptPath: string;
  /** hooks.json 里那条 command（供自检/排错展示） */
  hookCommand: string;
}

/**
 * 跑 hook 的 shell 类型 —— 直接决定命令里路径该写成什么形态（实测差异很大）：
 * - `wsl`：Windows 路径**不能**当可执行文件（`D:\…\node.exe` → command not found），
 *   必须写成 `/mnt/d/…`；但传给 node.exe 的**脚本参数**又必须是 Windows 形式
 *   （`/mnt/c/…` 会被 node 当 Windows 路径解析而打不开）。→ 混着写。
 * - `posix`：Git Bash / MSYS / Cygwin 等，Windows 形式两边都能用。
 */
export type ShellKind = 'wsl' | 'posix';

export interface ApprovalHookOptions {
  /** 扩展 globalStorage 根 */
  storageDir: string;
  /** 跑 hook 脚本用的 node 绝对路径（取自 hello.dsh.nodePath） */
  nodePath: string;
  /** 由 probeShell 探到的 shell 类型（决定路径形态） */
  shellKind: ShellKind;
  /** 审批服务地址（http://127.0.0.1:PORT）与令牌 */
  url: string;
  token: string;
  /** 脚本等答复的上限（毫秒）——应略大于扩展侧的用户等待上限，让扩展先超时 */
  scriptTimeoutMs: number;
  /** DSH 侧这条 hook 的超时（秒，写进 hooks.json；DSH 到此会杀掉 hook 进程） */
  hookTimeoutSec: number;
  /** 用户的基础 cordis.yml **绝对路径**；空串 → 不派生配置（调用方据此判断本功能不可用） */
  baseConfigPath: string;
}

/**
 * 写出 hook 脚本 / hooks.json / 派生 cordis.yml。抛错 = 调用方降级（功能不启用，行为回到现状）。
 * 每次都重写：hook 脚本与 hooks.json 幂等，派生配置紧跟用户当前的基础配置。
 */
export function writeApprovalHookFiles(opts: ApprovalHookOptions): ApprovalHookFiles {
  const hooksDir = path.join(opts.storageDir, 'dsh-hooks');
  const configDir = path.join(opts.storageDir, 'dsh-config');
  fs.mkdirSync(hooksDir, { recursive: true });

  const scriptPath = path.join(hooksDir, 'approval-hook.mjs');
  fs.writeFileSync(scriptPath, HOOK_SCRIPT, 'utf8');

  const hooksPath = path.join(hooksDir, 'hooks.json');
  const hookCommand = buildHookCommand(
    opts.nodePath,
    scriptPath,
    opts.url,
    opts.token,
    opts.scriptTimeoutMs,
    opts.shellKind
  );
  const hooksJson = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'bash',
          hooks: [
            {
              type: 'command',
              command: hookCommand,
              // 秒；与扩展侧等待/脚本 socket 超时形成 600 > 560 > 540 的梯度，
              // 保证任何一种超时都是"扩展先放弃并拒绝"，而不是进程被砍在半路
              timeout: opts.hookTimeoutSec,
            },
          ],
        },
      ],
    },
  };
  fs.writeFileSync(hooksPath, JSON.stringify(hooksJson, null, 2) + '\n', 'utf8');

  if (!opts.baseConfigPath) throw new Error('未配置基础 cordis.yml（hello.dsh.config）');
  const base = fs.readFileSync(opts.baseConfigPath, 'utf8');
  if (!isBlockSequenceRoot(base)) {
    throw new Error('基础 cordis.yml 的根不是块状列表，无法安全追加（不改写用户原文）');
  }
  fs.mkdirSync(configDir, { recursive: true });
  const cordisPath = path.join(configDir, 'cordis.yml');
  fs.writeFileSync(cordisPath, base + derivedBlock(hooksPath), 'utf8');

  return { cordisPath, hooksPath, scriptPath, hookCommand };
}

/**
 * 自检：用**同一个 shell**（DSH 的 hook 也是 `bash -c <command>`）跑一遍这条 hook 命令，
 * 喂一个非 bash 工具的合成载荷（脚本会立刻 exit 0，无副作用）。
 * 失败说明 hook 起不来（典型：node 路径在 bash 里不可达）→ 审批**不会生效**，必须让用户知道，
 * 而不是安静地"看起来配好了"。
 */
export function testApprovalHook(hookCommand: string, cwd: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean, detail: string): void => {
      if (done) return;
      done = true;
      resolve({ ok, detail });
    };
    let child;
    try {
      child = spawn('bash', ['-c', hookCommand], { cwd, env: process.env, windowsHide: true });
    } catch (err) {
      finish(false, err instanceof Error ? err.message : String(err));
      return;
    }
    let out = '';
    let errOut = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      finish(false, '自检超时（15s）');
    }, 15000);
    child.stdout?.on('data', (c) => (out += String(c)));
    child.stderr?.on('data', (c) => (errOut += String(c)));
    child.on('error', (err) => {
      clearTimeout(timer);
      finish(false, err.message);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish(false, `bash 退出码 ${code}${errOut.trim() ? '：' + errOut.trim().slice(0, 300) : ''}`);
        return;
      }
      if (out.trim()) {
        // 非 bash 工具本不该产生任何决策输出
        finish(false, `自检输出异常：${out.trim().slice(0, 200)}`);
        return;
      }
      finish(true, 'ok');
    });
    child.stdin?.end(JSON.stringify({ tool_name: 'read', tool_input: { file_path: 'x' } }) + '\n');
  });
}

// ---------- 内部 ----------

/**
 * 用与 DSH 完全相同的方式（`bash -c <command>`，从扩展进程 spawn）探一次 shell。
 * DSH 子进程的 env 继承自扩展，所以这里的 `bash` 解析结果就是 hook 将要用的那个。
 */
export function probeShell(cwd: string): Promise<ShellKind> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (kind: ShellKind): void => {
      if (done) return;
      done = true;
      resolve(kind);
    };
    let child;
    try {
      child = spawn('bash', ['-c', 'uname -s'], { cwd, env: process.env, windowsHide: true });
    } catch {
      finish('posix');
      return;
    }
    let out = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      finish('posix');
    }, 8000);
    child.stdout?.on('data', (c) => (out += String(c)));
    child.on('error', () => {
      clearTimeout(timer);
      finish('posix');
    });
    child.on('close', () => {
      clearTimeout(timer);
      // WSL 的 uname 是 Linux；Git Bash/MSYS 是 MINGW*/MSYS*/CYGWIN*
      finish(/linux/i.test(out) ? 'wsl' : 'posix');
    });
  });
}

/**
 * `D:\a\b` → `/mnt/d/a/b`（WSL 里可执行的形态）。盘符小写是 WSL 的默认挂载约定。
 * 非盘符路径（UNC 等）原样返回 —— 那种情况 WSL 下本来也不通，交给自检去喊。
 */
export function toWslPath(winPath: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  if (!m) return winPath.replace(/\\/g, '/');
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

/**
 * 组装 hook 命令。令牌走参数不走 env（hook 的 env 会被 DSH 擦洗）。
 * 路径形态按 shell 而定：WSL 下 exe 必须 `/mnt/...` 才找得到，而给 node.exe 的脚本参数
 * 必须是 Windows 形式（`/mnt/...` 会被 node 当 Windows 路径解析而打不开）—— 混着写才对。
 */
function buildHookCommand(
  nodePath: string,
  scriptPath: string,
  url: string,
  token: string,
  scriptTimeoutMs: number,
  shellKind: ShellKind
): string {
  const exe = shellKind === 'wsl' ? toWslPath(nodePath) : nodePath;
  return [
    quote(exe),
    quote(scriptPath),
    '--url',
    quote(url),
    '--token',
    quote(token),
    '--timeout-ms',
    String(Math.round(scriptTimeoutMs)),
  ].join(' ');
}

/** bash 双引号包裹：里面的 `\` 只在 `$`/反引号/`"`/`\`/换行 前才是转义，Windows 路径安全。 */
function quote(s: string): string {
  return '"' + s.replace(/(["\\$`])/g, '\\$1') + '"';
}

/**
 * 派生配置追加块：只增不改。刻意用 `id` + `name` + `config` 的显式写法 ——
 * 与用户 cordis.yml 里其它条目的写法一致（README 也支持 `- dsh-hooks-claude-code:` 简写，
 * 但保持一致更不容易踩插件的解析差异）。
 * 不设 `projectDir`：默认即"会话 cwd"，也就是用户的工作区，正是 hook 该待的地方。
 */
function derivedBlock(hooksPath: string): string {
  return (
    '\n' +
    '# --- AlohaDSH 事前审批（C1）自动追加：由扩展生成，请勿手工编辑 ---\n' +
    '- id: hello-chat-approval-hooks\n' +
    "  name: '@deepseek-ai/dsh-hooks-claude-code'\n" +
    '  config:\n' +
    '    configPath: ' + yamlLiteral(hooksPath) + '\n'
  );
}

/** YAML 单引号字面量（`\` 不是转义，只有 `'` 需写成 `''`）——直接放 Windows 路径最稳。 */
function yamlLiteral(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/**
 * 根是不是**块状序列**：跳过空行与注释后，第一行必须以 `-` 开头。
 * 形如 `plugins:\n  - …` 或流式 `[…]` 的根一律拒绝（我们只会在末尾追加整条列表项）。
 */
function isBlockSequenceRoot(text: string): boolean {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    return line.startsWith('-');
  }
  return false;
}

/**
 * hook 脚本本体。用 String.raw 是因为里面全是正则与 `\s`/`\b` 这类转义 ——
 * 普通模板串会把 `\s` 吃成 `s`，正则就全废了。脚本内不使用 `${}` 插值。
 */
const HOOK_SCRIPT = String.raw`#!/usr/bin/env node
/**
 * AlohaDSH · C1 事前审批 hook（由扩展自动生成，请勿手工编辑）。
 *
 * DSH 的 hooks-claude-code 插件在每次 bash 工具调用**之前**执行本脚本，把载荷
 * （{tool_name, tool_input, tool_use_id}）从 stdin 递进来；脚本向本机的审批服务
 * 询问决策并**保持连接**，直到用户点了允许/拒绝 —— 所以 agent 那一轮真的暂停在这里。
 *
 * 输出约定（CC 风格）：
 *   放行 = 不输出任何东西、exit 0（不表态）
 *   拒绝 = stdout 输出 hookSpecificOutput.permissionDecision = 'deny' + 原因，exit 0
 *
 * 兜底（扩展不可达/超时）：按内置危险清单拒绝，其余放行 —— 既不因扩展挂掉而 sha 掉
 * 所有 bash，也不会把 rm -rf 这种放过去。
 */
import * as http from 'node:http'

const FALLBACK = [
  /\brm\b/,
  /\bmkfs(\.[a-z0-9]+)?\b/,
  /\bdd\b[^|]*\bof=/,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\bdiskpart\b/,
  /\bformat\s+[A-Za-z]:/,
  /:\s*\(\s*\)\s*\{/,
]

function argOf(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : ''
}

function readStdin() {
  return new Promise((resolve) => {
    let s = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => { s += c })
    process.stdin.on('end', () => resolve(s))
    process.stdin.on('error', () => resolve(s))
  })
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }) + '\n')
}

function ask(url, token, payload, timeoutMs) {
  return new Promise((resolve) => {
    let target
    try { target = new URL('/pre-tool-use', url) } catch { resolve(null); return }
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': body.length,
        'x-hello-token': token,
      },
    }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        if (res.statusCode !== 200) { resolve(null); return }
        try { resolve(JSON.parse(data)) } catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null) })
    req.end(body)
  })
}

async function main() {
  const raw = await readStdin()
  let payload
  try { payload = JSON.parse(raw) } catch { deny('无法解析 hook 输入，已按拒绝处理。'); return }
  if (!payload || payload.tool_name !== 'bash') return
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {}
  const command = typeof input.command === 'string' ? input.command : ''
  if (!command) return

  const url = argOf('--url')
  const token = argOf('--token')
  const timeoutMs = Number(argOf('--timeout-ms')) || 540000

  const res = url
    ? await ask(url, token, { toolName: 'bash', command: command, toolUseId: payload.tool_use_id }, timeoutMs)
    : null

  if (res && typeof res.decision === 'string') {
    if (res.decision === 'deny') {
      deny(typeof res.reason === 'string' && res.reason ? res.reason : '未获批准，命令未执行。')
    }
    return
  }

  for (const re of FALLBACK) {
    if (re.test(command)) { deny('审批服务不可达，且该命令命中内置危险清单，已拒绝。'); return }
  }
}

main().catch(() => { deny('审批 hook 异常，已按拒绝处理。') })
`;
