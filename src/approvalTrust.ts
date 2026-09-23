/**
 * C16「审批白名单记忆」的纯模块：把「用户点过的『永久信任』」变成一张可审计、可撤销的表，
 * 并回答两个问题 —— **这条审批能不能提供「永久信任」按钮**、**这条审批命中了哪一条信任**。
 *
 * **不 import vscode** —— 判据必须能在扩展宿主之外加载（C10b 的教训）。
 *
 * 一条已拍板的语义（写在最前面，因为它是这个功能的成败点）：
 *
 * - **逐字精确 + 所在目录**。bash 的键是 `(command, cwd)` 二元组，`rm -rf ./dist` 被信任
 *   不覆盖 `rm -rf ./dist/`、不覆盖多一个空格的写法、也不覆盖**另一个目录里的同一条**。
 *   绝不做 trim / 折叠空白 / 大小写归一 / 前缀包含那一类「聪明」匹配：折叠空白在引号内
 *   不成立（`echo "a  b"` 与 `echo "a b"` 是两条命令），而前缀包含等于把设置里那条
 *   `\brm\b` 正则整条作废 —— **那件事今天就能在设置里做，本功能刻意不重复它**。
 *   代价是「模型换个写法就再问一次」，这是**有意**选的方向：多问一次的代价是可承受的，
 *   悄悄放行一条没被准过的命令不是。
 * - **永不因为白名单出错而拒绝**：读盘失败/文件损坏/条目非法 → 空表 → 照常弹条。
 *   坏的降级方向只能是「多问」，**永远不会是「全放行」**。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MAX_COMMAND_CHARS, MAX_PATH_CHARS } from './approvalServer';
import { isInsideDir } from './changeForecast';

/** 信任的两种粒度。`command` 只对 bash，`dir` 只对 write/edit —— 两边**不许互相覆盖** */
export type TrustKind = 'command' | 'dir';

/**
 * 一条信任。**字段就是全部判据**，所以这张表是可以直接肉眼读的：
 *
 * ```json
 * [
 *   { "kind": "command", "command": "rm -rf ./dist", "cwd": "D:\\proj", "createdAt": 1758500000000 },
 *   { "kind": "dir", "dir": "D:\\out", "createdAt": 1758500000000 }
 * ]
 * ```
 *
 * **没有 id 字段**：撤销靠「身份」而不是序号（见 `removeTrust`），少一个字段就少一处
 * 可能与内容不一致的东西。`cwd` 缺省与空串是**同一个键**（会话工作区拿不到时两边都是空）。
 */
export interface TrustEntry {
  kind: TrustKind;
  /** kind==='command'：bash 命令原文，逐字 */
  command?: string;
  /** kind==='command'：当时的会话工作区（键的另一半）。空/缺省 = 无工作区 */
  cwd?: string;
  /** kind==='dir'：绝对目录（含其全部子目录） */
  dir?: string;
  /** 创建时刻（ms）。认不出来就是 0 —— 只影响显示，不参与任何判定 */
  createdAt: number;
}

/**
 * 一次审批里参与白名单判定的那几样（**只取需要的**，所以本模块不认识 `ApprovalAsk`）。
 * `targetAbs` 由调用方用 `resolveTargetPath` 算好（拿不到 = undefined ⇒ dir 档不参与）。
 */
export interface TrustQuery {
  toolName: string;
  /** bash 的命令原文（其它工具为空） */
  command?: string;
  /** hook 载荷里的会话工作区 */
  cwd?: string;
  /** fs 工具目标的绝对路径 */
  targetAbs?: string;
}

/** 拦停条上那个按钮 + 它旁边那行边界说明 */
export interface TrustOffer {
  kind: TrustKind;
  /** 按钮文字 */
  label: string;
  /** 边界说明：**必须把这次信任到底覆盖什么说清楚**，含具体的目录 */
  scope: string;
}

/** 白名单文件名（落在扩展 globalStorage 顶层，与 sessions.json 并列） */
export const TRUST_FILE_NAME = 'approval-trust.json';

/** 条目上限。**满了拒绝、不淘汰最旧的** —— 静默累积权限比报个错更坏 */
export const MAX_TRUST_ENTRIES = 200;

// ---------- 判定 ----------

/** 本模块的单一咽喉：**这条审批是不是已经被信任过**。命中 ⇒ 调用方不再弹条（静默放行）。 */
export function matchTrust(entries: readonly TrustEntry[], q: TrustQuery): TrustEntry | undefined {
  for (const e of entries) {
    if (e.kind === 'command' && q.toolName === 'bash') {
      // 触顶的命令**可能是被服务器截断的**（`slice(0,max)`），两条不同的超长命令会截成同一个
      // 字符串 ⇒ 一律不认（宁可多问一次）。详见 MAX_COMMAND_CHARS。
      if (typeof q.command !== 'string' || q.command.length >= MAX_COMMAND_CHARS) continue;
      if (e.command === q.command && (e.cwd ?? '') === (q.cwd ?? '')) return e;
    } else if (e.kind === 'dir' && (q.toolName === 'write' || q.toolName === 'edit')) {
      if (!q.targetAbs || !e.dir) continue;
      if (isInsideDir(q.targetAbs, e.dir)) return e;
    }
  }
  return undefined;
}

/**
 * 这条审批**能不能**给出「永久信任」这个选项（不能就返回 undefined，拦停条上不画那个按钮）。
 *
 * 可不可能提供由扩展说了算、webview 只负责画拿到的东西 —— 因为「能不能」本身是判定：
 * 命令触顶（上一条）、路径解析不出来（POSIX 形态等）、目录是盘根或家目录，都算不能。
 */
export function offerTrust(q: TrustQuery): TrustOffer | undefined {
  if (q.toolName === 'bash') {
    if (typeof q.command !== 'string' || !q.command) return undefined;
    if (q.command.length >= MAX_COMMAND_CHARS) return undefined;
    const cwd = String(q.cwd ?? '');
    return {
      kind: 'command',
      label: '永久信任此命令',
      scope: cwd
        ? `只对这一条命令生效（在 ${cwd} 里，换一个工作区还会再问）`
        : '只对这一条命令生效（本次没有工作区，换一个位置还会再问）',
    };
  }
  if (q.toolName === 'write' || q.toolName === 'edit') {
    const dir = str(q.targetAbs) ? path.dirname(path.resolve(String(q.targetAbs))) : '';
    if (!dir || isForbiddenTrustDir(dir)) return undefined;
    return {
      kind: 'dir',
      label: '永久信任此目录',
      scope: `不再询问对 ${dir} 及其子目录的写入`,
    };
  }
  return undefined;
}

/**
 * 这个目录**不许**被信任。
 *
 * 两条硬禁，理由是同一条：点一下就把整个盘、或整个用户目录交出去，不是这个按钮该有的分量。
 * ① 盘根（`D:\` / `/`）；② 目录**包含或等于**用户主目录 —— 这一条同时挡住 `C:\`（含家目录）
 * 与 `C:\Users`（家目录的父目录），比列一串特例可靠。
 *
 * 注意**没有**禁止「比工作区更高的目录」（工作区 `D:\proj\sub`、目标 `D:\proj\notes.md`
 * ⇒ 提供的目录是 `D:\proj`）：那是用户真实的取舍，拦停条上会把这个目录原样写出来给人看。
 */
export function isForbiddenTrustDir(dir: unknown): boolean {
  const d = String(dir ?? '').trim();
  if (!d) return true;
  const abs = path.resolve(d);
  if (path.parse(abs).root === abs) return true;
  const home = os.homedir();
  return !!home && isInsideDir(home, abs);
}

// ---------- 增删 ----------

/** 一条信任的身份（撤销与去重都用它；**没有序号**，所以手改文件也不会错位） */
export function identityOf(e: Pick<TrustEntry, 'kind' | 'command' | 'cwd' | 'dir'>): string {
  return e.kind === 'command'
    ? `command\u0000${e.cwd ?? ''}\u0000${e.command ?? ''}`
    : `dir\u0000${e.dir ?? ''}`;
}

export type AddResult =
  | { ok: true; entries: TrustEntry[]; entry: TrustEntry }
  | { ok: false; reason: string };

/**
 * 加一条信任。返回**新数组**（绝不改原对象，同 `frozenTail` 的体例）。
 *
 * 这里要**重新校验一遍 kind**：webview 传来的东西不是可信输入，一个被改过的
 * `approval-answer` 不能凭空造出「信任整个目录」。校验用的就是 `offerTrust` 那套判据。
 * 已经信任过同一条 ⇒ `ok:true` 且表不变（幂等，不是错误）。
 */
export function addTrust(
  entries: readonly TrustEntry[],
  q: TrustQuery,
  kind: unknown,
  now: number
): AddResult {
  const offer = offerTrust(q);
  if (!offer) return { ok: false, reason: '这条审批没有可记住的粒度（命令过长或目标路径不可解析）' };
  if (kind !== offer.kind) return { ok: false, reason: '这次审批不支持这种信任粒度，未记住' };
  if (entries.length >= MAX_TRUST_ENTRIES) {
    return { ok: false, reason: `白名单已满（${MAX_TRUST_ENTRIES} 条），请先在命令面板里清除一些` };
  }
  const draft: TrustEntry =
    offer.kind === 'command'
      ? { kind: 'command', command: String(q.command), cwd: String(q.cwd ?? ''), createdAt: now }
      : { kind: 'dir', dir: path.resolve(String(q.targetAbs)), createdAt: now };
  // 过一遍与读盘同一套校验：**写出去的东西必须与读回来的形状逐字一致**，
  // 否则「写→读往返不变」这件事就只是巧合（两处各建一次对象，迟早会漂）
  const entry = normalizeEntry(draft);
  if (!entry) return { ok: false, reason: '这条审批记不出合法的条目' };
  const id = identityOf(entry);
  const existing = entries.find((e) => identityOf(e) === id);
  if (existing) return { ok: true, entries: entries.slice(), entry: existing };
  return { ok: true, entries: entries.concat([entry]), entry };
}

/** 撤掉一条（或几条身份相同的，理论上只有一条）。返回新数组；没命中就是不动的副本。 */
export function removeTrust(
  entries: readonly TrustEntry[],
  target: Pick<TrustEntry, 'kind' | 'command' | 'cwd' | 'dir'>
): TrustEntry[] {
  const id = identityOf(target);
  return entries.filter((e) => identityOf(e) !== id);
}

/** 一条展示文案（撤销面板与转写留痕共用一份，两处绝不许各写一套） */
export function describeTrust(e: TrustEntry): string {
  const when = e.createdAt > 0 ? new Date(e.createdAt).toLocaleString() : '创建时间未知';
  if (e.kind === 'command') {
    const where = e.cwd ? `工作区 ${clip(e.cwd, 60)}` : '无工作区';
    return `命令 ${clip(e.command ?? '', 120)}（${where}，${when}）`;
  }
  return `目录 ${clip(e.dir ?? '', 120)}（及其子目录，${when}）`;
}

// ---------- 读盘 / 写盘 ----------

/**
 * 解析白名单文件。**坏文件 = 空表，绝不抛、绝不退化成通配**。
 *
 * 逐条校验，任何一条不合法就**丢掉那一条**（不是丢掉整份）：字段类型、kind 白名单、
 * 命令/目录非空、目录是绝对的且不在硬禁名单里。⚠️ 特别注意
 * `{"kind":"bash"}` 这种缺 command 的条目 —— 填一个空串进去就成了「什么都匹配」的后门，
 * 所以非空是硬要求。
 */
export function parseTrustFile(text: string): TrustEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(String(text ?? ''));
  } catch {
    return [];
  }
  return normalizeEntries(raw);
}

export interface TrustFileRead {
  entries: TrustEntry[];
  /**
   * 文件在、内容非空、却**一条都没解出来**（多半是手改坏了）—— 只为了提示。
   * 判定早就退回「每次都问」了：这个旗标永远不会影响放不放行。
   */
  corrupt: boolean;
}

/**
 * 读白名单文件。**读不到 / 解析失败 ⇒ 空表**（fail closed：坏文件的后果只能是「多问几次」，
 * 永远不是「全放行」）。没有这个文件是最常见的情形，那不算坏（`corrupt:false`）。
 */
export function readTrustFile(file: string): TrustFileRead {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { entries: [], corrupt: false };
  }
  const entries = parseTrustFile(text);
  return { entries, corrupt: !entries.length && !!text.trim() };
}

/**
 * 写白名单文件（tmp + rename，同 `writeEffortState` 的体例：读到半截 JSON 是最难查的那种故障）。
 *
 * 先过一遍 `normalizeEntries` 再写：**只写「读回来还在」的东西**，于是不变量
 * `readTrustFile(writeTrustFile(x)) === x` 是结构上成立的，而不是靠调用方自觉。
 */
export function writeTrustFile(file: string, entries: readonly TrustEntry[]): void {
  const clean = normalizeEntries(entries);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/** 逐条校验 + 去重 + 截到上限（`parseTrustFile` 与 `writeTrustFile` 共用这一份） */
function normalizeEntries(raw: unknown): TrustEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: TrustEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const e = normalizeEntry(item);
    if (!e) continue;
    const id = identityOf(e);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(e);
    if (out.length >= MAX_TRUST_ENTRIES) break;
  }
  return out;
}

/** 一条 → `TrustEntry`，认不出来就是 undefined（**每一个分支都是 fail closed**） */
function normalizeEntry(item: unknown): TrustEntry | undefined {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
  const o = item as Record<string, unknown>;
  const createdAt =
    typeof o.createdAt === 'number' && Number.isFinite(o.createdAt) && o.createdAt > 0
      ? o.createdAt
      : 0;
  if (o.kind === 'command') {
    const command = typeof o.command === 'string' ? o.command : '';
    if (!command || command.length >= MAX_COMMAND_CHARS) return undefined;
    // cwd 给了但不是字符串 ⇒ 整条丢掉：那条目想绑一个工作区却绑成了空键（**是放宽，不是收紧**）
    if (o.cwd !== undefined && typeof o.cwd !== 'string') return undefined;
    const cwd = typeof o.cwd === 'string' && o.cwd ? o.cwd : '';
    if (cwd.length >= MAX_PATH_CHARS) return undefined;
    // 键序按接口声明来（`kind, command, cwd?, createdAt`）：这个文件是给人读的，
    // 「这条命令 + 在哪个工作区 + 什么时候给的」照着念就是一整句
    return cwd
      ? { kind: 'command', command, cwd, createdAt }
      : { kind: 'command', command, createdAt };
  }
  if (o.kind === 'dir') {
    const raw = typeof o.dir === 'string' ? o.dir.trim() : '';
    if (!raw || raw.length >= MAX_PATH_CHARS || !path.isAbsolute(raw)) return undefined;
    const dir = path.resolve(raw);
    if (isForbiddenTrustDir(dir)) return undefined;
    return { kind: 'dir', dir, createdAt };
  }
  return undefined;
}

/** 展示用截断（只影响显示，判据一个字符都不裁） */
function clip(s: unknown, max: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
