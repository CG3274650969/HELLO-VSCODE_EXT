/**
 * 直接驱动便携运行时的公共件：spawn → initialize →（可选）一条 prompt → 等轮尾。
 *
 * 抽出来是因为现在有两处要用同一套**很容易写错**的东西：成帧（stdout 逐行 JSON）、
 * 等轮尾（`session.status` idle，而不是等 `session/prompt` 的响应）、
 * 杀进程的宽限（Windows 上进程被杀后还会短暂持有句柄，不等它退干净就 spawn 下一个会互染）。
 * 复制两份必然漂移，漂移的那一份会在某天悄悄说「通过」。
 *
 * 使用者：smoke-runtime.mjs（跨重启记忆的回归闸门）、probe-resume.mjs（阶段 0 对照实验）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 杀掉整棵进程树。
 *
 * 别用裸 `child.kill()`：实测漏过一次尸 —— 残留的运行时进程继续占着 `dist-runtime/node/node.exe`
 * 的文件锁（Windows 上运行中的映像文件是排他的），下一次 `build-runtime.mjs` 的 `rm(dist-runtime)`
 * 就 EBUSY 失败，而报错里完全看不出是谁占着。一条命令就能连树收干净，没有理由省。
 */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && typeof child.pid === 'number') {
    const r = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    if (!r.error) return;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* 已退出 */
  }
}

/** 首次 boot 要加载上百个插件包，给足时间。 */
export const BOOT_TIMEOUT_MS = 90_000;
/** 一整轮的等待上限：思考 + 若干 step。 */
export const TURN_TIMEOUT_MS = 240_000;

/** 默认从哪读 key（与 C1/C4 探针同一个约定）。 */
export const DEFAULT_CREDENTIALS_FILE = join(process.env.USERPROFILE ?? homedir(), '.dsh', '.credentials.yaml');

/**
 * 从 credentials yaml 里抠 key。**只回值、绝不打印**；找不到就返回空串。
 * 调用方负责把它塞进子进程 env —— 它永远不进日志、不进转写、不进仓库。
 */
export function readApiKey(file = DEFAULT_CREDENTIALS_FILE) {
  if (!existsSync(file)) return '';
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:DEEPSEEK_API_KEY|deepseek[_-]?api[_-]?key|api[_-]?key)\s*:\s*(.+)$/i.exec(line);
    if (!m) continue;
    const raw = m[1].trim().replace(/^['"]|['"]$/g, '');
    if (raw) return raw;
  }
  return '';
}

/**
 * 抠助手正文：走 `assistant/chunk` 的 text-delta，**与扩展侧 `_onDshEvent` 同一判据**。
 *
 * 刻意不碰 `assistant/message`：它是同一步的终样本，形状是 `data.message.content` 块数组，
 * 与 delta 叠加会重复计算；而且恢复会话时它还可能被**回放**，拿回放当记忆就是假阳性。
 * 只认流式增量，就只认「这次它自己说出来的话」。
 */
function deltaOf(event) {
  const chunk = event?.data?.chunk;
  return chunk?.type === 'text-delta' && typeof chunk.text === 'string' ? chunk.text : '';
}

/**
 * spawn 一次运行时；给了 `prompt` 就再跑一轮。
 *
 * DSH 在 stdin end 时会自认父进程断开而干净退出，所以**保持 stdin 打开**直到我们主动 kill。
 *
 * @returns {Promise<{ok: boolean, reason: string, frames: unknown[], eventTypes: string[], assistant: string, stderr: string, collision: boolean}>}
 *   `ok` = initialize 成功，且（给了 prompt 时）该轮跑到 idle 而没有错误帧 / 没撞 id。
 */
export function runTurn({
  node,
  entry,
  config,
  cwd,
  sessionRoot,
  sessionId,
  prompt,
  apiKey,
  bootTimeoutMs = BOOT_TIMEOUT_MS,
  turnTimeoutMs = TURN_TIMEOUT_MS,
}) {
  return new Promise((resolvePromise) => {
    const frames = [];
    const eventTypes = new Set();
    let assistant = '';
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(node, [entry, config], {
      cwd,
      env: {
        ...process.env,
        DSH_CORDIS_CONFIG: config,
        DSH_CWD: cwd,
        DSH_SESSION_ROOT: sessionRoot,
        ...(apiKey ? { DEEPSEEK_API_KEY: apiKey } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // Windows 上被杀的子进程还会短暂持有句柄，不等它真的退出就 spawn 下一个会互染。
    // 所以一律等 exited，且给个上限：杀不掉也不能把自己卡死。
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
      clearTimeout(bootTimer);
      clearTimeout(turnTimer);
      killTree(child);
      void exited.then(() =>
        resolvePromise({ frames, eventTypes: [...eventTypes], assistant, stderr, collision: false, ...result })
      );
    };

    const bootTimer = setTimeout(() => finish({ ok: false, reason: `等待 initialize 超时（${bootTimeoutMs / 1000}s）` }), bootTimeoutMs);
    let turnTimer;

    child.on('error', (err) => finish({ ok: false, reason: `无法启动运行时：${err.message}` }));
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('exit', (code) => {
      finish({
        ok: false,
        reason: `运行时提前退出（code=${String(code)}）${stderr.trim() ? `；stderr：${stderr.trim().slice(0, 600)}` : ''}`,
      });
    });

    child.stdout.on('data', (d) => {
      stdout += String(d);
      let nl;
      while ((nl = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, nl).trim();
        stdout = stdout.slice(nl + 1);
        if (!line) continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          // 非 JSON 行 = stdout 被污染（配置里混进了 logger/终端 UI），硬错误
          finish({ ok: false, reason: `stdout 出现非 JSON 行（stdout 必须留给 JSON-RPC）：${line.slice(0, 200)}` });
          return;
        }
        frames.push(frame);

        if (frame.id === 1) {
          if (frame.error) {
            finish({ ok: false, reason: `initialize 返回错误：${JSON.stringify(frame.error)}` });
            return;
          }
          if (prompt === undefined) {
            finish({ ok: true, reason: `initialize 回执 id=1：${JSON.stringify(frame.result).slice(0, 200)}` });
            return;
          }
          turnTimer = setTimeout(() => finish({ ok: false, reason: `等待轮尾超时（${turnTimeoutMs / 1000}s）` }), turnTimeoutMs);
          child.stdin.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              method: 'session/prompt',
              params: { sessionId, contentBlocks: [{ type: 'text', text: prompt }] },
            }) + '\n'
          );
          continue;
        }

        if (frame.method === 'session.event') {
          const e = frame.params?.event ?? {};
          const t = e.type ?? '?';
          eventTypes.add(t);
          if (t === 'assistant/chunk') assistant += deltaOf(e);
        }

        // 判据一律先看「有没有炸」，再看「跑完没有」——撞 id 时进程未必走得到 idle
        if (JSON.stringify(frame).includes('id collision')) {
          finish({ ok: false, reason: '命中 id collision', collision: true });
          return;
        }
        if (frame.id === 2 && frame.error) {
          finish({ ok: false, reason: `session/prompt 返回错误：${JSON.stringify(frame.error)}` });
          return;
        }
        if (frame.method === 'session.status') {
          const status = frame.params?.status;
          if (status === 'idle') {
            finish({ ok: true, reason: '轮尾：session.status idle' });
            return;
          }
          if (status && status !== 'running') {
            finish({ ok: false, reason: `会话状态落到 ${status}` });
            return;
          }
        }
      }
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
