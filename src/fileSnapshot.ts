/**
 * 2.1「改动审阅」的纯文件快照工具：不依赖 git —— agent 改文件的目录（DSH_CWD = 打开的工作区根）
 * 可能是任意文件夹。职责：轮首快照文件树 → 轮末对比出 增/改/删 → 给每项生成行级 diff →
 * 按轮前内容还原。全 node fs 同步、零第三方依赖；行级 diff 用 LCS（预算内），无 diff 库。
 *
 * 统一约定：
 * - `rel` 一律用 `/` 分隔的工作区根相对路径，绝对路径不出模块。
 * - 内容存内存有上限（单文件 + 总量软预算）；超大/二进制只记 `size+mtime`，判为不可预览、
 *   不可还原（除非是 added —— 删除文件不需要内容）。
 */
import * as fs from 'fs';
import * as path from 'path';
import type { DiffLine, FileChangeKind } from './protocol';

/** 目录名命中即整棵剪掉（快照不跟进构建产物/依赖/仓库元数据） */
const IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'out', 'build', 'coverage',
  '.vscode', '.idea', '.cache', '__pycache__', '.claude', '.next', '.turbo',
  // 本扩展自用的临时区（选区附件等）：属实现细节，绝不当作 agent 的改动呈现
  '.hello-chat',
]);
/** 忽略的散文件 */
const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db']);

/** 二进制扩展名命中即不读内容（不改读盘，只是不做 utf8 预览） */
const BIN_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'pdf', 'psd',
  'zip', 'gz', 'tar', '7z', 'rar', 'xz',
  'exe', 'dll', 'so', 'dylib', 'bin', 'dat', 'db', 'sqlite', 'sqlite3', 'class', 'o', 'obj',
  'mp3', 'mp4', 'avi', 'mov', 'mkv', 'wav', 'flac', 'ogg',
  'woff', 'woff2', 'ttf', 'eot', 'otf',
]);

/** 遍历到该文件数直接中止（宁可本轮无审阅也不卡死面板） */
const MAX_FILES = 60000;
/** 单文件内容上限：超过只记 size+mtime（不预览、不还原轮前内容） */
const MAX_FILE_STORE_BYTES = 256 * 1024;
/** 快照内容总预算：超后剩余文件软降级为只记元数据（不算失败） */
const MAX_CONTENT_BUDGET = 24 * 1024 * 1024;
/** diff 预览行数上限（超出截断标记） */
export const MAX_DIFF_ROWS = 2000;
/** LCS-DP 单元预算：超出则中间段整段「先删后增」兜底（颗粒粗但内容不丢） */
const MAX_DIFF_DP_CELLS = 250_000;

/** 快照里的一个文件条目。content===null = 超大/二进制/预算耗尽，只记元数据。 */
export interface SnapEntry {
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
  content: string | null;
}

export interface FsSnapshot {
  root: string;
  files: Map<string, SnapEntry>;
  /** 是否有内容因超总量预算被软降级（不影响对比，只影响预览/还原面） */
  truncated: boolean;
}

export type SnapOutcome = FsSnapshot | { aborted: true; reason: string };

/** 对比出的单项改动（rich：携带 before/after 整条目，供 diff 与还原用）。 */
export interface TreeChange {
  kind: FileChangeKind;
  rel: string;
  before?: SnapEntry;
  after?: SnapEntry;
  /** false = 无法用轮前内容还原（二进制/超大文件被改/被删）。added 恒可还原（删除即可）。 */
  reversible: boolean;
}

export interface LineDiffResult {
  lines: DiffLine[];
  truncated: boolean;
}

/** 整棵树快照（栈式 DFS，不递归防深目录爆栈）。根不可读/目录过大 → {aborted}。 */
export function snapshotTree(root: string): SnapOutcome {
  const rootAbs = path.resolve(root);
  try {
    if (!fs.statSync(rootAbs).isDirectory()) {
      return { aborted: true, reason: '快照根不是目录' };
    }
  } catch {
    return { aborted: true, reason: '快照根不可读' };
  }

  const files = new Map<string, SnapEntry>();
  let budget = MAX_CONTENT_BUDGET;
  let truncated = false;
  let count = 0;

  const stack: { dir: string; rel: string }[] = [{ dir: rootAbs, rel: '' }];
  while (stack.length) {
    const { dir, rel } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 单个子目录读不到就跳过，不拖垮整棵
    }
    for (const ent of entries) {
      const childAbs = path.join(dir, ent.name);
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (IGNORED_DIRS.has(ent.name)) continue;
        stack.push({ dir: childAbs, rel: childRel });
        continue;
      }
      if (!ent.isFile() || IGNORED_FILES.has(ent.name)) continue;
      count += 1;
      if (count > MAX_FILES) return { aborted: true, reason: `文件数超限（>${MAX_FILES}）` };

      let size = 0;
      let mtimeMs = 0;
      try {
        const s = fs.statSync(childAbs);
        size = s.size;
        mtimeMs = s.mtimeMs;
      } catch {
        continue;
      }

      let content: string | null = null;
      const isBinExt = BIN_EXT.has(path.extname(ent.name).slice(1).toLowerCase());
      if (!isBinExt && size <= MAX_FILE_STORE_BYTES && budget > 0) {
        try {
          const buf = fs.readFileSync(childAbs);
          // 前 8KB 含 NUL → 判二进制（扩展名表没盖住的真二进制）
          if (!buf.subarray(0, 8192).includes(0)) {
            content = buf.toString('utf8');
            budget -= buf.length;
            if (budget <= 0) truncated = true;
          }
        } catch {
          /* 读失败当无内容（仍记元数据，改动可检出但不可预览/不可还原） */
        }
      }
      files.set(childRel, { rel: childRel, abs: childAbs, size, mtimeMs, content });
    }
  }
  return { root: rootAbs, files, truncated };
}

/** 对比两棵快照：before 有 after 无 = deleted；都有 = content/size+mtime 比较 → modified；反之为 added。 */
export function compareTrees(before: FsSnapshot, after: FsSnapshot): TreeChange[] {
  const changes: TreeChange[] = [];
  for (const [rel, be] of before.files) {
    const af = after.files.get(rel);
    if (!af) {
      changes.push({ kind: 'deleted', rel, before: be, reversible: be.content !== null });
      continue;
    }
    if (be.content !== null && af.content !== null) {
      if (be.content === af.content) continue;
    } else if (be.size === af.size && be.mtimeMs === af.mtimeMs) {
      continue;
    }
    changes.push({ kind: 'modified', rel, before: be, after: af, reversible: be.content !== null });
  }
  for (const [rel, af] of after.files) {
    if (!before.files.has(rel)) {
      changes.push({ kind: 'added', rel, after: af, reversible: true });
    }
  }
  return changes;
}

/** 行级 diff（剥公共前后缀后对中段跑 LCS）。行数超限截断置 truncated。 */
export function lineDiff(oldText: string, newText: string): LineDiffResult {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  // 公共前缀 / 公共后缀（不重叠）
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf += 1;
  }

  const lines: DiffLine[] = [];
  for (let i = 0; i < pre; i++) lines.push({ kind: 'ctx', text: a[i] });
  for (const op of diffMiddle(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf))) {
    lines.push({ kind: op.type === 'eq' ? 'ctx' : op.type, text: op.line });
  }
  for (let i = a.length - suf; i < a.length; i++) lines.push({ kind: 'ctx', text: a[i] });

  let truncated = false;
  if (lines.length > MAX_DIFF_ROWS) {
    lines.length = MAX_DIFF_ROWS; // 只保留前段（预览截断，避免一次展开几千行）
    truncated = true;
  }
  return { lines, truncated };
}

/** 行切片：去掉结尾换行产生的空串，减少 diff 噪音。 */
function splitLines(text: string): string[] {
  if (!text) return [];
  const parts = text.split('\n');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

interface DiffOp {
  type: 'add' | 'del' | 'eq';
  line: string;
}

/** 中段 LCS-DP 对齐；超出预算退化为「先全删、再全增」（结果完整，颗粒粗）。 */
function diffMiddle(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((line) => ({ type: 'add' as const, line }));
  if (m === 0) return a.map((line) => ({ type: 'del' as const, line }));
  if (n * m > MAX_DIFF_DP_CELLS) {
    return [
      ...a.map((line) => ({ type: 'del' as const, line })),
      ...b.map((line) => ({ type: 'add' as const, line })),
    ];
  }

  const cols = m + 1;
  const rows = n + 1;
  const dp = new Int32Array(rows * cols);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const idx = i * cols + j;
      dp[idx] =
        a[i] === b[j]
          ? dp[(i + 1) * cols + (j + 1)] + 1
          : Math.max(dp[(i + 1) * cols + j], dp[i * cols + (j + 1)]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'eq', line: a[i] });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * cols + j] >= dp[i * cols + (j + 1)]) {
      ops.push({ type: 'del', line: a[i] });
      i += 1;
    } else {
      ops.push({ type: 'add', line: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: 'del', line: a[i] });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: 'add', line: b[j] });
    j += 1;
  }
  return ops;
}

/**
 * 按轮前快照还原单项改动：
 * - added → 删除（unlink）
 * - modified / deleted → 用 before.content 整写覆盖 / 重建（目录先 mkdir）
 * 缺轮前内容（二进制/超大）抛错 —— 调用方应只对 reversible 项调用。
 */
export function applyRevert(root: string, ch: TreeChange): void {
  const abs = path.join(root, ch.rel);
  if (ch.kind === 'added') {
    fs.unlinkSync(abs);
    return;
  }
  const before = ch.before;
  if (!before || before.content === null) {
    throw new Error('没有可用于还原的轮前内容');
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, before.content, 'utf8');
}
