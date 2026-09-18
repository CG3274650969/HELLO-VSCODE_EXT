/**
 * 读 DSH 盘上的会话日志（`session.jsonl.zstd`）—— 探针公共件。
 *
 * 抽出来是因为它**必须**被多处共用：C9 的步分组对拍、C10 的压缩事件对拍都要读同一份原文，
 * 而「按魔数切帧」这件事极容易写得**看起来对**（`zstdDecompressSync` 只解第一帧就收工，
 * 不切帧的话你会拿到一份"少了大半"的日志，然后所有对拍都无声地对着一份残卷做题）。
 * 复制两份必然漂移，漂移的那一份会在某天悄悄说「通过」。
 *
 * 使用者：`probe-run-inspector.mjs`（C9 步分组）、`probe-compaction-notice.mjs`（C10 压缩帧）。
 *
 * ⚠️ `probe-c8-runtime.mjs` 里还有**第三份**，但它不是这份的复制品：它按 `(root, cwd, id)`
 * 定位、返回 `{path, events, error}` 并把"哪几片没解开"记下来（那正是它要证的：硬杀之后
 * 盘上到底留下了什么）。别顺手把它并过来 —— 它的诊断信息是主产物。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

/** 扩展的 globalStorage 目录名（派生配置、hooks、会话日志、store 都在它下面）。 */
const EXT_ID = 'starmerx-local.hello-vscode-ext';

/**
 * 找扩展真正在用的那份 store（`sessions-harness.json`）。**不硬编码机器路径**：
 * 先认显式的 `HELLO_HARNESS_STORE`，再认 `HELLO_DSH_SESSIONS_DIR` 旁边的同一条约定，
 * 最后才是本机的 APPDATA。找不到回 `null` —— 调用方要**响亮地跳过**，别把"没数据"当成"验过了"。
 */
export function findHarnessStore() {
  const explicit = process.env.HELLO_HARNESS_STORE;
  if (explicit) return existsSync(explicit) ? explicit : null;
  const sessionsRoot = process.env.HELLO_DSH_SESSIONS_DIR;
  if (sessionsRoot) {
    const p = join(dirname(sessionsRoot), 'sessions-harness.json');
    return existsSync(p) ? p : null;
  }
  if (!process.env.APPDATA) return null;
  const p = join(process.env.APPDATA, 'Code', 'User', 'globalStorage', EXT_ID, 'sessions-harness.json');
  return existsSync(p) ? p : null;
}

/** 读 store（`[{...}]` 或 `{sessions:[...]}` 两种都认），坏文件回空数组而不是抛。 */
export function readHarnessStore(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : (parsed.sessions ?? []);
  } catch {
    return [];
  }
}

/**
 * 会话日志是**首尾相接的 zstd 帧**（magic `28 b5 2f fd`），`zstdDecompressSync` 只认第一帧 ——
 * 所以按 magic 切段、每段往后多要一帧再试。
 *
 * 切帧是启发式的（帧内容理论上可能恰好包含魔数），所以每一片都**试解**：
 * 解不开就把终点往后挪一帧（最多 4 帧）。
 */
export function readZstdFrames(file) {
  const buf = readFileSync(file);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const offs = [];
  for (let i = 0; ; ) {
    const j = buf.indexOf(magic, i);
    if (j < 0) break;
    offs.push(j);
    i = j + 1;
  }
  const text = [];
  for (let k = 0; k < offs.length; k += 1) {
    let done = false;
    for (let span = 1; span <= 4 && k + span <= offs.length && !done; span += 1) {
      const end = k + span < offs.length ? offs[k + span] : buf.length;
      try {
        text.push(zstdDecompressSync(buf.subarray(offs[k], end)).toString('utf8'));
        k += span - 1;
        done = true;
      } catch {
        /* 往后多要一帧再试 */
      }
    }
  }
  return text.join('');
}

/** 把一份 zstd 会话日志解成事件数组（解不动的行丢掉，不抛）。 */
export function readSessionEvents(log) {
  return readZstdFrames(log)
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}

/**
 * 列出根目录下所有 `session.jsonl.zstd`（旧 → 新）。**不硬编码机器路径** —— 从扩展的
 * globalStorage 根往下走，也允许 `HELLO_DSH_SESSIONS_DIR` 追加一个根（别的机器 / CI 上跑
 * 就有路子）。`logs/` 与 globalStorage 都不在仓库里，缺了要**响亮地跳过**，别把通过当成验过了。
 */
export function findSessionLogs(extraRoots = []) {
  const roots = [];
  if (process.env.HELLO_DSH_SESSIONS_DIR) roots.push(process.env.HELLO_DSH_SESSIONS_DIR);
  if (process.env.APPDATA) {
    roots.push(join(process.env.APPDATA, 'Code', 'User', 'globalStorage', 'starmerx-local.hello-vscode-ext', 'dsh-sessions'));
  }
  for (const r of extraRoots) roots.push(r);
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.jsonl.zstd')) {
        try {
          found.push({ p, m: statSync(p).mtimeMs });
        } catch {
          /* 读不到就跳过 */
        }
      }
    }
  };
  for (const r of roots) walk(r, 0);
  found.sort((a, b) => a.m - b.m);
  return found.map((x) => x.p);
}
