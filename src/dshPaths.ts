/**
 * C7：DSH 会话日志在盘上的位置 —— 路径算法是**逐字复刻**，加上一个受控的删除函数。
 *
 * ⚠️ **只准对着插件抄，别「整理」它**。下面每个字符类、`~XXXX` 的宽度、251 那个截断长度，都是从
 * `dist-runtime/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js:84-158`
 * 一字一句搬过来的 —— 上游改任何一处，我们算出来的路径就会指向别的地方。
 *
 * 三道守卫（按发现顺序）：
 * 1. `scripts/probe-purge.mjs` 拿插件**公开且无副作用**的 `locate()` 做逐字对账，并冻结插件的
 *    版本号与 `lib/index.js` 的哈希 —— 上游一改版，自检立刻响亮地失败，而不是悄悄删错东西。
 * 2. 运行时 `removeDshSessionDir` 的**内容闸门**：叶子目录里只认 `session.jsonl(.zstd)` 及其
 *    `.tmp` 中间产物。路径一旦漂移到**别的会话**目录，那里也不会恰好长着这些文件名 → 拒绝删除。
 * 3. 任何拿不准的情况一律偏向 **`refused`（删不掉）**，绝不偏向「删了再说」。
 *
 * ⚠️ 本模块**只 import `node:` 与类型**，绝不 import `vscode` —— probe 要在扩展宿主之外直接
 * 加载编译产物跑它的边界用例。
 */
import * as fs from 'fs';
import * as path from 'path';

/** 物理编码（决定文件名后缀）。默认 `'zstd'`（`runtime/cordis.default.yml` 里配的）。 */
export type DshCompression = 'zstd' | 'none';

/** `.jsonl.zstd`（Zstandard）或 `.jsonl`（明文）。 */
export function logSuffix(compression: DshCompression): string {
  return compression === 'zstd' ? '.jsonl.zstd' : '.jsonl';
}

/** 唯一被放行的字符集（注意 `~` **不在**里面：它自己也要被转义，否则解码不回去）。 */
const SAFE_CHAR = /^[A-Za-z0-9._-]$/;

/** 不安全的码位 → `~XXXX`（大写四位十六进制，按 `charCodeAt`，代理对的两半各自转义）。 */
function escapeCodeUnit(code: number): string {
  return '~' + code.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * 把一个字符串编成一个安全的**单层**路径片段（可逆）。
 * 空串抛 —— 与插件一致：空 id 是调用方的 bug，不该变成一个指向项目目录本身的路径。
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) {
    throw new Error('cannot encode an empty path segment');
  }
  // 这两个是特例，必须**先**判：否则 `.` 会被当成安全字符原样保留，路径就指到别处了
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && SAFE_CHAR.test(ch)) {
      out += ch;
    } else {
      out += escapeCodeUnit(code);
    }
  }
  return out;
}

/**
 * 项目目录名：`/ \ :` 折叠成**一个** `-`（连续多个只出一个），剥掉前导 `-`，截 251，包成 `--…--`。
 * 有损（分隔符替换与截断都不可逆）—— 这是插件刻意的「人能看懂的目录名」约定，别试图改成可逆的。
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) {
    throw new Error('cannot encode an empty project path');
  }
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && SAFE_CHAR.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += escapeCodeUnit(code);
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/** 项目目录的绝对路径。`cwd` 为 undefined 时是插件的 `_no-cwd` 兜底桶。 */
export function projectDir(root: string, cwd: string | undefined): string {
  if (cwd === undefined) return path.join(root, '_no-cwd');
  return path.join(root, projectKey(cwd));
}

/** 一个会话独占的目录。 */
export function sessionDir(root: string, cwd: string, id: string): string {
  return path.join(projectDir(root, cwd), encodeSegment(id));
}

/** 会话的 append-only 事件日志文件路径。 */
export function logPath(root: string, cwd: string, id: string, compression: DshCompression): string {
  return path.join(sessionDir(root, cwd, id), `session${logSuffix(compression)}`);
}

/**
 * 叶子目录里**允许**出现的文件名：
 * - `session.jsonl` / `session.jsonl.zstd` —— 主日志（插件切换压缩档位时两个都可能存在）；
 * - `<上面两个>.<12 位十六进制>.tmp` —— 插件的原子写中间产物
 *   （`index.js:1160`：`` `${finalPath}.${randomBytes(6).toString('hex')}.tmp` ``）。
 *
 * 闸门要**至少**有一个非 tmp 的主日志才算数 —— 光剩一堆 tmp 说明这不是一个正常的会话目录。
 */
const ARTIFACT_NAME = /^session\.jsonl(\.zstd)?$/;
const TMP_NAME = /^session\.jsonl(\.zstd)?\.[0-9a-f]{12}\.tmp$/;

export interface RemoveResult {
  removed: boolean;
  /** removed=false 时才有值。`missing` 是**正常**情况（该会话从没在盘上落过日志），不是错误。 */
  reason?: 'missing' | 'refused' | 'error';
  detail?: string;
}

/**
 * 删掉一个会话的磁盘目录（转写之外的那份 DSH 日志）。
 *
 * **只删叶子**：项目目录（同一个 `cwd` 下所有会话共用）与 root 永远不动。
 *
 * 调用方必须**在 `SessionStore.purge()` 之前**把 `dsh` 取出来 —— 摘出数组之后就拿不到
 * `{id, cwd}` 了。另见 `chatViewProvider._dshStillReferenced`：fork 与源共享同一个 `dsh.id`，
 * 还有别的会话引用它时**不能**删。
 *
 * 本函数**绝不抛**：调用方在删除路径上，一个抛出去会连带把「清空回收站」这种批量动作打断在半路。
 */
export function removeDshSessionDir(root: string, cwd: string, id: string): RemoveResult {
  if (!root || !cwd || !id) {
    return { removed: false, reason: 'refused', detail: 'root/cwd/id 有空值' };
  }

  let dir: string;
  let segment: string;
  try {
    segment = encodeSegment(id);
    dir = sessionDir(path.resolve(root), cwd, id);
  } catch (err) {
    return { removed: false, reason: 'refused', detail: String(err) };
  }

  // 纵深防御：编码器理论上不可能产出这些东西（`.`/`..` 被特判，分隔符会被转义成 ~XXXX），
  // 但它是整块地方唯一「算错了就会指到别人家」的函数 —— 值当再挡一道。
  if (segment === '.' || segment === '..' || /[/\\]/.test(segment)) {
    return { removed: false, reason: 'refused', detail: `编码后的 id 片段不安全：${segment}` };
  }
  const rel = path.relative(path.resolve(root), dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { removed: false, reason: 'refused', detail: `解析出的路径不在 root 内：${rel}` };
  }

  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch {
    // 目录不存在 = 这个会话从没在盘上落过日志（比如没跑过 harness）。正常，不打日志。
    return { removed: false, reason: 'missing' };
  }
  if (st.isSymbolicLink()) {
    return { removed: false, reason: 'refused', detail: '叶子是符号链接' };
  }
  if (!st.isDirectory()) {
    return { removed: false, reason: 'refused', detail: '叶子不是目录' };
  }
  // 项目目录本身若是 junction/软链，递归删就会穿出去。连着一起挡。
  try {
    if (fs.lstatSync(path.dirname(dir)).isSymbolicLink()) {
      return { removed: false, reason: 'refused', detail: '上级项目目录是符号链接' };
    }
  } catch {
    return { removed: false, reason: 'error', detail: '读取上级项目目录失败' };
  }

  // 内容闸门 —— 本模块的**安全阀**。路径一旦因上游改版而漂移，最坏后果是落到**另一个会话**的目录上；
  // 那里不会恰好只长着 session.jsonl(.zstd)。把它降级成一次带日志的空操作。
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    return { removed: false, reason: 'error', detail: `读取目录失败：${String(err)}` };
  }
  if (entries.length === 0) {
    return { removed: false, reason: 'refused', detail: '目录是空的，不像一个会话目录' };
  }
  const unknown = entries.filter((f) => !ARTIFACT_NAME.test(f) && !TMP_NAME.test(f));
  if (unknown.length > 0) {
    return { removed: false, reason: 'refused', detail: `有无法识别的条目：${unknown.join(', ')}` };
  }
  if (!entries.some((f) => ARTIFACT_NAME.test(f))) {
    return { removed: false, reason: 'refused', detail: '只有临时文件，没有主日志' };
  }

  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return { removed: true };
  } catch (err) {
    // 常见于 Windows：DSH 子进程可能还攥着日志的文件句柄（EBUSY/EPERM）。
    // 交给调用方打警告，别在这里抛 —— 它会把「清空回收站」打断在半路。
    return { removed: false, reason: 'error', detail: String(err) };
  }
}
