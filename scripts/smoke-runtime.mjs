#!/usr/bin/env node
/**
 * 便携运行时的裸冒烟：不依赖扩展、不依赖 F5 —— 直接 spawn 包内的 node + 入口 + 配置，
 * 喂一条 `initialize`，看是否回一条 id 对得上的 JSON-RPC 响应。
 *
 * 这是整条 C2 路线的分离器：`packaged-bin.js` 在 Windows 上能不能跑、
 * 闭包的裸插件名能不能解析、默认 cordis.yml 能不能 boot —— 全在这一个断言里。
 * initialize 不调模型，**不需要 DEEPSEEK_API_KEY**。
 *
 *   node scripts/smoke-runtime.mjs --runtime <便携运行时目录>
 *   node scripts/smoke-runtime.mjs --runtime <目录> --keep-session   # 保留临时会话目录便于排查
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

/** 等一条 id 对得上的响应；超时即判失败。首次 boot 要加载上百个插件包，给足时间。 */
const RESPONSE_TIMEOUT_MS = 90_000;

const { values } = parseArgs({
  options: {
    runtime: { type: 'string' },
    'keep-session': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

if (values.help || (!values.runtime && process.argv.length < 3)) {
  console.log(
    [
      '用法：node scripts/smoke-runtime.mjs --runtime <便携运行时目录> [--keep-session]',
      '',
      '目录里应有 runtime.json（由 scripts/build-runtime.mjs 产出）。',
    ].join('\n')
  );
  process.exit(values.help ? 0 : 1);
}

const runtimeDir = resolve(values.runtime ?? process.argv[2]);

/** 读清单并把三个相对路径解析成绝对路径，逐个验存在。 */
async function resolveRuntime(dir) {
  const manifestPath = join(dir, 'runtime.json');
  if (!existsSync(manifestPath)) throw new Error(`运行时目录里没有 runtime.json：${manifestPath}`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const abs = (rel) => (rel ? resolve(dir, rel) : '');
  const resolved = {
    manifest,
    node: abs(manifest.node),
    entry: abs(manifest.entry),
    config: abs(manifest.config),
  };
  for (const key of ['node', 'entry', 'config']) {
    if (!resolved[key]) throw new Error(`runtime.json 缺少 "${key}" 字段`);
    if (!existsSync(resolved[key])) throw new Error(`runtime.json 指向的 ${key} 不存在：${resolved[key]}`);
  }
  return resolved;
}

/**
 * spawn 运行时、发一条 initialize、等响应。
 * DSH 在 stdin end 时会自认父进程断开而干净退出，所以**保持 stdin 打开**直到我们主动 kill。
 */
function probe({ node, entry, config, cwd, sessionRoot }) {
  return new Promise((resolvePromise) => {
    const child = spawn(node, [entry, config], {
      cwd,
      env: {
        ...process.env,
        DSH_CORDIS_CONFIG: config,
        DSH_CWD: cwd,
        DSH_SESSION_ROOT: sessionRoot,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    // Windows 上被杀的子进程还会短暂持有句柄，不等它真的退出就去删会话目录会 EPERM。
    // 所以 finish 一律等 exited，且给个上限：杀不掉也不能把自己卡死。
    let resolveExit;
    const exited = new Promise((r) => {
      resolveExit = r;
    });
    const graceTimer = setTimeout(resolveExit, 5000);
    child.on('exit', () => {
      clearTimeout(graceTimer);
      resolveExit();
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      void exited.then(() => resolvePromise(result));
    };

    const timer = setTimeout(
      () => finish({ ok: false, detail: `等待 initialize 响应超时（${RESPONSE_TIMEOUT_MS / 1000}s）` }),
      RESPONSE_TIMEOUT_MS
    );

    child.on('error', (err) => finish({ ok: false, detail: `无法启动运行时：${err.message}` }));
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.stdout.on('data', (d) => {
      stdout += String(d);
      // 逐行找 id 对得上的响应
      let nl;
      while ((nl = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, nl).trim();
        stdout = stdout.slice(nl + 1);
        if (!line) continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          // 非 JSON 行 = stdout 被污染（配置里混进了 logger/终端 UI），这是硬错误
          finish({ ok: false, detail: `stdout 出现非 JSON 行（stdout 必须留给 JSON-RPC）：${line.slice(0, 200)}` });
          return;
        }
        if (frame.id !== 1) continue;
        if (frame.error) {
          finish({ ok: false, detail: `initialize 返回错误：${JSON.stringify(frame.error)}` });
          return;
        }
        finish({ ok: true, detail: `initialize 回执 id=1：${JSON.stringify(frame.result).slice(0, 200)}` });
        return;
      }
    });
    child.on('exit', (code) => {
      finish({
        ok: false,
        detail: `运行时提前退出（code=${String(code)}）${stderr.trim() ? `；stderr：${stderr.trim().slice(0, 600)}` : ''}`,
      });
    });

    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { cwd, provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      }) + '\n'
    );
  });
}

const resolved = await resolveRuntime(runtimeDir);
console.log(`运行时：${runtimeDir}`);
console.log(`  node   ${resolved.node}`);
console.log(`  entry  ${resolved.entry}`);
console.log(`  config ${resolved.config}`);
console.log(
  `  清单   dsh ${resolved.manifest.dshVersion ?? '?'} · ${resolved.manifest.platform ?? '?'} · node ${
    resolved.manifest.nodeVersion ?? '?'
  }`
);

// 会话落在临时目录：冒烟不该污染任何人的真实会话，也不该落在仓库里
const sandbox = mkdtempSync(join(tmpdir(), 'hello-runtime-smoke-'));
console.log(`  会话   ${sandbox}`);

const result = await probe({
  node: resolved.node,
  entry: resolved.entry,
  config: resolved.config,
  cwd: sandbox,
  sessionRoot: join(sandbox, 'sessions'),
});

// 先给结论，再清理 —— 清理失败不该盖掉结论
if (result.ok) {
  console.log(`\n✓ 冒烟通过 —— ${result.detail}`);
} else {
  console.error(`\n✗ 冒烟失败 —— ${result.detail}`);
}

if (!values['keep-session']) {
  try {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // 删不掉只是留了个临时目录，不影响判定；失败时留着反而便于排查
    console.log(`（临时会话目录没删掉，可自行清理：${sandbox}）`);
  }
}

process.exit(result.ok ? 0 : 1);
