/**
 * 会话的持久化存储：把历史会话写进扩展 globalStorage 下的 sessions.json，
 * 重启扩展宿主 / 重启 VS Code 后仍能找回。
 *
 * 只存「有内容的会话」（messages 非空）；正在输入的空新会话不入列。
 * 消息里的 status 若是遗留的 streaming（上次异常退出），加载时一律改成 interrupted，
 * 避免某条永远"生成中"把输入锁死。
 *
 * C8 起另存 `lastTurn`（上一轮的终态），它是「继续」按钮的判据 —— 见 turnState.ts。
 *
 * C8c 起落盘改成**原子写 + 上一代备份**，加载失败不再静默归零（见下方 persist / _load 与 LoadReport）。
 * 起因：C7 的「彻底删除」会把会话的 DSH 日志一并删掉，于是这里那份成了**删除后的唯一副本** ——
 * 而原来是 `writeFileSync` 直接覆盖、`_load` 遇坏文件 catch 成空数组，一次写崩就等于历史全失且无人察觉。
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes, randomUUID } from 'crypto';
import { ChatMessage, UsageBuckets } from './protocol';
// 只取类型：编译后不留 require，与 turnState.ts 的 `import type { StoredSession }` 相抵，
// 运行时没有环。C8 的「继续」按钮判据就靠这个字段（见 turnState.ts）。
import type { LastTurn } from './turnState';

/** C7 留存：一天。 */
export const RETENTION_DAY_MS = 24 * 60 * 60 * 1000;

export interface StoredSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  /** C3a 本会话 token 累计（跨轮累加、随会话落盘）。旧数据没有本字段 → 视为缺省，
   *  `_load` 只按 messages 是否数组过滤，故加字段向后兼容。 */
  usage?: UsageBuckets;
  /** C5 本会话在 DSH 侧的身份，用于 host 重启后接回同一份会话记忆。
   *
   *  `id` 与它被铸造时的 `cwd` **必须同时有效**（DSH 的会话日志按 cwd 归属，换工作区就对不上），
   *  所以嵌套成一个可选对象而不是两个平铺字段 —— 不允许出现只有一半的中间态。
   *  旧数据没有本字段 → 视为「这个会话还没有 DSH 身份」，向后兼容。 */
  dsh?: { id: string; cwd: string };
  /** C6 软删除时间戳（epoch ms）。**缺省 = 在列**；有值 = 在回收站，等「恢复」或「彻底删除」。
   *
   *  回收站只认这一个标志，别再引入并行的旁路状态（`deleted: true` 之类）——两套标志一定会打架。
   *  旧数据没有本字段 → 视为未删除，向后兼容。 */
  deletedAt?: number;
  /** C8：**上一轮是怎么结束的**。只有异常终态才落值（`interrupted` = 用户停止或窗口重载，
   *  `error` = 出错了），正常跑完一律删掉这个字段 —— 于是「有没有值」本身就是「要不要给
   *  用户一个『继续』按钮」的判据，不必再去猜消息的形状（理由见 turnState.ts）。
   *
   *  用户一发新消息就清掉；所以按钮的失效不需要额外逻辑。旧数据没有本字段 → 向后兼容。 */
  lastTurn?: LastTurn;
  /** C10：**最后一次已知的上下文占用**，轮尾写入。
   *
   *  为什么非落盘不可：占用读数本来只活在内存里（`_turnUsage` / `_contextWindow`），
   *  重载窗口或切回一个旧会话时它是空的 —— 而占用恰恰是这条指示唯一要说的东西。
   *  它是**上次已知值**不是实时值，读出来会标 `stale`（渲染成「上次」），不冒充实时。
   *  旧数据没有本字段 → 向后兼容。 */
  context?: { usedTokens: number; contextWindow: number; at: number };
  /** C10b：**本会话见过的上下文窗口（分母）**。窗口是 (provider, model) 的属性，记下来
   *  就等于永远知道；而 DSH 只在路由**变化**时才发 `request/context`，续聊时一条都不发
   *  （理由见 contextWindow.ts 的 resolveContextWindow）—— 于是这份记忆是续聊时唯一的分母。
   *
   *  ⚠️ 与上面 `context` 的区别：`context` 是**一次读数**（分子 + 分母 + 时间，会 stale），
   *  本字段只是**分母**，不随时间失效。旧数据没有本字段 → 向后兼容（那些会话要把本条读数
   *  空着，直到路由真的变一次）。 */
  contextWindow?: number;
  /** C10：本会话被 DSH 压缩过几次（累计）。只用来在读数条上写「· 已压缩 N 次」——
   *  「发生过压缩」这件事的**正文说明**是转写里那条 note（见 compactionNotice.ts）。
   *  旧数据没有本字段 → 向后兼容。 */
  compacted?: number;
}

/** 由首条用户消息生成一句话标题（单行、截断）。 */
export function titleFromText(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 24 ? oneLine.slice(0, 24) + '…' : oneLine;
}

/** C8c：单条工具入参落盘前的字符上限。 */
export const MAX_TOOL_INPUT_CHARS = 20000;

/** 截断提示。文案对齐既有体例（`toolOutput` 是「输出过长」、附件是「内容过长」）。 */
const TOOL_INPUT_CUT = '\n…（入参过长，已截断）';

/**
 * C8c：`toolInput` 的**保险丝** —— 一次工具调用带进几 MB 正文时兜住，而不是成本优化。
 *
 * ⚠️ **只在消息产生处调用**（chatViewProvider 的 `tool/call` 分支）。`_load` / `normalize` **绝不**
 * 调它 —— 那会去回改盘上已有的老数据，是静默的数据销毁。所以老会话里若有超长入参，它就那样留着。
 *
 * 放在本文件（而不是 `chatViewProvider`）是为了能自检：那个文件 `import vscode`，probe 加载不了
 * —— 与 `dshStillReferenced` 同因。
 *
 * 判据用 `>`：恰好等于上限时原样通过。截断只做一次，marker 不参与下一轮长度判定（幂等）。
 */
export function capToolInput(text: string): string {
  return text.length > MAX_TOOL_INPUT_CHARS ? text.slice(0, MAX_TOOL_INPUT_CHARS) + TOOL_INPUT_CUT : text;
}

/**
 * C8c：构造期的加载结局。纯模块不能 `import vscode`，所以这里只**陈述事实**，
 * 由 `chatViewProvider._checkStorageHealth()` 翻译成用户可见的告警。
 *
 * ⚠️ `reason: 'missing'` 与 `'corrupt'` 必须分开：前者是**首次运行**（文件还没建），完全正常，
 * 报给用户就是误报。这是唯一能区分二者的判据。
 */
export interface LoadReport {
  /** 会话最终从哪儿来：主文件 / 上一代备份 / 都没有（空）。 */
  source: 'file' | 'backup' | 'empty';
  /** `source !== 'file'` 时才有：主文件为什么没被采用。 */
  reason?: 'missing' | 'corrupt' | 'notArray' | 'readError';
  /** 人话细节（哪个文件、什么错）。只进 console，不进弹窗。 */
  detail?: string;
}

/** C8c：多久以前的残留 `.tmp` 才算「崩溃遗留」。新鲜的可能正被**另一个 VS Code 窗口**写着。 */
export const STALE_TMP_MS = 60 * 60 * 1000;

/** 同步小睡，只用于 rename 的退避重试（扩展宿主是 Node 主线程，`Atomics.wait` 可用）。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function normalize(session: StoredSession): StoredSession {
  // 清掉异常中断残留的「正在生成」状态
  for (const m of session.messages) {
    if (m.status === 'streaming') {
      m.status = 'interrupted';
    }
    // 上次异常退出可能留下永远 running 的工具卡 → 落成 **unknown**，避免回放时转圈。
    // 判成 error 是谎报：那条 result 从没到过，命令跑没跑完不可知（与 chatViewProvider 的
    // `_finishTurn` / `_openSession` 同一套理由）。
    if (m.role === 'tool' && m.toolState === 'running') {
      m.toolState = 'unknown';
    }
  }
  if (!session.title && session.messages[0]) {
    session.title = titleFromText(session.messages[0].text);
  }
  session.createdAt = session.createdAt || Date.now();
  session.updatedAt = session.updatedAt || Date.now();

  // C6：软删标记只要不是「有限正数」就当**未删除**。失败一律朝「看得见」的方向倒 ——
  // 一个损坏的时间戳（"yes" / {} / 0 / 负数）绝不能把会话永久藏进回收站里。
  if (typeof session.deletedAt !== 'number' || !Number.isFinite(session.deletedAt) || session.deletedAt <= 0) {
    delete session.deletedAt;
  }

  // C8：`lastTurn` 只认那两个值，别的一律当没有。方向与 deletedAt 相反 —— 那边一律朝
  // 「看得见」倒，这边一律朝「不打扰」倒：一个坏值最多让「继续」按钮不出现（用户重发一条
  // 就是了），而一个不该出现的按钮会把「上一轮其实跑完了」这种正常状态说成中断。
  if (session.lastTurn !== 'interrupted' && session.lastTurn !== 'error') {
    delete session.lastTurn;
  }
  return session;
}

/**
 * C7 留存：这条会话算不算「过期」。
 *
 * 口径**只有回收站里的**才算 —— 按 `deletedAt` 计时，而不是 `updatedAt`。理由：这是给「清理」
 * 用的判据，而删转写 + 它的 DSH 日志是**不可撤销**的；只圈用户**已经主动删过**的条目，
 * 是个手动、无预览的按钮唯一站得住的口径（在列会话哪怕一年没动也不入选）。
 *
 * ⚠️ `days <= 0` 一律 false —— **0 是「关闭」**。少了这道闸，`now - at > 0` 会把**回收站全部条目**
 * 判成过期，用户点一下「清理过期会话」就连转写带 DSH 日志一起清光。这是本文件里最危险的一行。
 */
export function isExpired(session: StoredSession, now: number, days: number): boolean {
  if (!Number.isFinite(days) || days <= 0) {
    return false;
  }
  const at = session.deletedAt;
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) {
    return false;
  }
  return now - at > days * RETENTION_DAY_MS;
}

/**
 * C7：这堆会话里，除了 `excludingId` 之外还有谁引用同一份 DSH 日志（按 `{id, cwd}` 判）？
 *
 * **这不是防御性代码，是必需的**：`_forkSession` 里 `fork.dsh = src.dsh` 是**同一个对象引用**，
 * 分支与源共享一份 DSH 日志 —— 删分支不能把源的记忆一起删了。
 *
 * 放在这里（而不是 `chatViewProvider` 里）是为了能自检：那个文件 `import vscode`，probe 加载不了。
 * 调用方负责把**两个 store 都**拼进来 —— 判定依据是引用关系，不是「在哪个库」。
 */
export function dshStillReferenced(
  sessions: StoredSession[],
  dsh: { id: string; cwd: string },
  excludingId: string
): boolean {
  return sessions.some((s) => s.id !== excludingId && s.dsh?.id === dsh.id && s.dsh?.cwd === dsh.cwd);
}

export class SessionStore {
  private readonly _file: string;
  /** C8c 上一代备份。由 `_file` 派生 → 两个模式自动分家（chat / harness 共处一目录也不会串）。 */
  private readonly _backupFile: string;
  private _sessions: StoredSession[] = [];
  private _loadReport: LoadReport;
  /**
   * C8c：构造期从备份回退过 ⇒ **下一次 persist 跳过滚动备份**。
   * 理由见 `_rollBackup` —— 那一下会把唯一一份好数据覆盖成坏字节，备份在最需要它的时刻自杀。
   */
  private _holdBackup = false;

  /**
   * @param storageDir globalStorage 目录
   * @param fileName   落盘文件名。两种模式各用一个文件：
   *                   chat → 'sessions.json'（默认，兼容旧数据）；
   *                   harness → 'sessions-harness.json'，历史互不串。
   */
  constructor(storageDir: string, fileName: string = 'sessions.json') {
    this._file = path.join(storageDir, fileName);
    this._backupFile = this._file + '.bak';
    this._loadReport = this._load();
    this._sweepStaleTmp();
  }

  /**
   * C8c：构造期的加载结局（见 `LoadReport`）。纯模块不能说人话，由
   * `chatViewProvider._checkStorageHealth()` 决定要不要弹给用户。
   *
   * 起名 `loadReport` 而不是 `load`：与私有方法 `_load` 只差一个下划线，太容易看错。
   */
  get loadReport(): LoadReport {
    return this._loadReport;
  }

  /**
   * C8c：读一个文件、解析成会话数组。**只报告不兜底** —— 兜底（回退备份）是 `_load` 的事。
   *
   * 之所以把 `missing` 从其它失败里摘出来：文件不存在是**首次运行**，完全正常，
   * 报给用户就是误报。这是唯一能区分二者的判据。
   */
  private _tryRead(
    file: string
  ): { ok: true; sessions: StoredSession[] } | { ok: false; reason: NonNullable<LoadReport['reason']>; detail: string } {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return {
        ok: false,
        reason: code === 'ENOENT' ? 'missing' : 'readError',
        detail: `${file}: ${code ?? String(err)}`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { ok: false, reason: 'corrupt', detail: `${file}: ${(err as Error).message}` };
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, reason: 'notArray', detail: `${file}: 顶层不是数组（${typeof parsed}）` };
    }

    // ⚠️ 这里**只**按 messages 过滤，绝不要补一句 `&& !s.deletedAt`：回收站的会话必然有消息
    // （空会话根本进不了列表），所以它天然活得过重启；补上那句会让回收站一重启就空。
    const sessions = parsed
      .filter((s): s is StoredSession => !!s && Array.isArray((s as StoredSession).messages))
      .filter((s) => s.messages.length > 0)
      .map(normalize);
    return { ok: true, sessions };
  }

  /**
   * C8c：主文件 → 上一代备份 → 空。**三级，且到此为止。**
   *
   * ⚠️ 不要因为「主文件解析出 0 条、而备份里有 40 条」就回退 —— 用户把会话全删光是**合法状态**，
   * 那样做等于把删掉的东西复活。回退的判据只有「主文件读不出来」这一条。
   */
  private _load(): LoadReport {
    const main = this._tryRead(this._file);
    if (main.ok) {
      this._sessions = main.sessions;
      return { source: 'file' };
    }

    const bak = this._tryRead(this._backupFile);
    if (bak.ok) {
      this._sessions = bak.sessions;
      // 盘上主文件此刻仍是坏字节：置位，挡住下一次 persist 的滚动备份。
      this._holdBackup = true;
      return {
        source: 'backup',
        reason: main.reason,
        detail: `主文件不可用（${main.detail}），已回退到 ${this._backupFile}`,
      };
    }

    this._sessions = [];
    return {
      source: 'empty',
      reason: main.reason,
      detail: `主文件不可用（${main.detail}）；备份也不可用（${bak.detail}）`,
    };
  }

  /** 同目录、随机后缀的临时文件名。两个窗口同时写也不会互踩（DSH 插件 dshPaths.ts 是同一套约定）。 */
  private _tmpSibling(): string {
    return `${this._file}.${randomBytes(6).toString('hex')}.tmp`;
  }

  /**
   * C8c：把内存状态序列化并完整落成一个 tmp 文件（`persist` 的第 1–3 步）。
   * @returns tmp 的完整路径；任何一步失败 → `undefined`（**已报错，且盘上主文件一个字节没动**）。
   */
  private _materializeTmp(): string | undefined {
    let tmp: string | undefined;
    try {
      const text = JSON.stringify(this._sessions, null, 2);
      fs.mkdirSync(path.dirname(this._file), { recursive: true });
      tmp = this._tmpSibling();
      fs.writeFileSync(tmp, text, 'utf8');
      this._fsyncBestEffort(tmp);
      return tmp;
    } catch (err) {
      console.error('保存历史会话失败：', err);
      if (tmp) {
        this._removeQuiet(tmp); // 写到一半挂的残骸，别留给下一次构造去扫
      }
      return undefined;
    }
  }

  /**
   * C8c：把当前内存状态整段写盘。**原子写 + 覆盖前滚备份**。
   *
   * 顺序即设计，别调换：
   *   1–3. `_materializeTmp()`：`stringify` 最先（它失败时盘上连 tmp 都不该产生）→ 写同目录的
   *        tmp（同目录才保证 rename 不跨卷）→ fsync 它（尽力）。只 rename 不 fsync 只防进程崩溃、
   *        不防断电/蓝屏：元数据可能先进日志、数据块后落盘，于是「名字对得上、内容是零或垃圾」；
   *   4. 滚动备份（尽力）—— **必须在 rename 之前**，写前复制才让 `.bak` 恒为上一代；
   *   5. rename 盖主文件（带退避重试）—— 失败了保留旧文件，绝不出现「旧的没了、新的没到位」。
   *
   * 签名与 10 个调用点一字未动（轮尾 `_afterTurn` + 9 处用户动作）。
   * 没做写入防抖/异步/分片：`persist()` 轮中一个字节都不写，压根没有高频写入可合并（实测见 backlog C8c）。
   */
  persist(): void {
    const tmp = this._materializeTmp();
    if (!tmp) {
      return; // 上面那三步已经报过错了，盘上一切照旧
    }

    // 到这儿 tmp 已是完整内容；下面两步都是 best-effort，任一步失败都不该连累主文件。
    this._rollBackup();
    try {
      this._renameOver(tmp, this._file);
      this._holdBackup = false; // 坏字节已被覆盖，备份可以恢复正常滚动
      this._fsyncDirBestEffort(path.dirname(this._file));
    } catch (err) {
      console.error('保存历史会话失败（主文件未被改动）：', err);
    } finally {
      this._removeQuiet(tmp);
    }
  }

  /**
   * C8c：把**盘上当前那份**滚成 `.bak`。必须在 rename 之前调用 —— 写完之后再复制，
   * 备份就恒等于当前，坏内容会被立刻镜像进去，等于没有备份。
   *
   * 自己也是原子落地（tmp + rename）：`copyFileSync` 是「打开即截断」，半路 ENOSPC 会把
   * 上一份**好备份**毁成半截 —— 而那正是最需要用它的时刻。
   *
   * 整段 best-effort：备份是附加保险，不能因为它让主文件写不进去。只留一代 —— 回退只有一步，
   * 多代要引入轮转与清理，收益为零。
   *
   * ⚠️ 别拿 `.bak` 的 mtime 判断「刚才有没有滚动」：`copyFileSync` 走的是 Windows `CopyFileW`，
   * **会连源文件的时间戳一起复制**（实测：复制后 dst 与 src 的 mtime 逐毫秒相同）。于是 `.bak` 的
   * mtime 恰好是**它那份内容当初被写下的时间**，即「上一代」的写入时刻 —— 比主文件旧是正常的，
   * 不代表这次没滚。
   */
  private _rollBackup(): void {
    if (this._holdBackup) {
      return; // ⚠️ 这一下会把唯一一份好数据覆盖成坏字节，见字段注释
    }
    if (!fs.existsSync(this._file)) {
      return; // 首次写：还没有「上一代」可备
    }
    let tmp: string | undefined;
    try {
      tmp = `${this._backupFile}.${randomBytes(6).toString('hex')}.tmp`;
      fs.copyFileSync(this._file, tmp);
      this._renameOver(tmp, this._backupFile);
      this._fsyncBestEffort(this._backupFile);
    } catch (err) {
      console.warn('[storage] 备份上一代失败（不影响本次写入）：', err);
      if (tmp) {
        this._removeQuiet(tmp);
      }
    }
  }

  /**
   * C8c：rename 盖掉 `to`，对**瞬时**错误退避重试。
   *
   * Windows 上 rename 覆盖已有文件本身是可靠的（libuv 走 `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`）；
   * 要防的不是「覆盖不了」，而是 Defender 实时扫描 / 另一个 VS Code 窗口 / 资源管理器预览造成的
   * 瞬时 EPERM/EACCES/EBUSY。**只重试这几个 code** —— 重试救不了「磁盘满了」，那类错误立刻抛。
   * 同步小睡用 `Atomics.wait`（扩展宿主是 Node 主线程，可用），单次最坏 ~70 ms。
   */
  private _renameOver(from: string, to: string): void {
    const retriable = new Set(['EPERM', 'EACCES', 'EBUSY']);
    let wait = 10;
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(from, to);
        return;
      } catch (err) {
        if (attempt >= 2 || !retriable.has((err as NodeJS.ErrnoException).code ?? '')) {
          throw err;
        }
        sleepSync(wait);
        wait *= 2;
      }
    }
  }

  /**
   * C8c：尽力 fsync。**绝不能因为它失败就放弃写盘** —— 网络盘 / 同步盘（OneDrive 之类）
   * 会 EINVAL/ENOTSUP，那属于「这台机器上没有这个保证」，不是「这次写盘有问题」。
   */
  private _fsyncBestEffort(file: string): void {
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, 'r+');
      fs.fsyncSync(fd);
    } catch (err) {
      console.warn('[storage] fsync 未生效（不影响写入）：', (err as NodeJS.ErrnoException).code ?? err);
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* 关不掉就算了，进程退出时内核会收 */
        }
      }
    }
  }

  /** 目录 fsync：让 rename 本身也落盘。**只在非 Windows 上做** —— Windows 打不开目录句柄，必报错。 */
  private _fsyncDirBestEffort(dir: string): void {
    if (process.platform === 'win32') {
      return;
    }
    let fd: number | undefined;
    try {
      fd = fs.openSync(dir, 'r');
      fs.fsyncSync(fd);
    } catch {
      /* 同上：没有这个保证的机器上静默跳过 */
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** 清理临时文件。失败只 warn —— 留个把 `.tmp` 比因为清理失败而抛要好（下次构造会扫掉它）。 */
  private _removeQuiet(file: string): void {
    try {
      fs.rmSync(file, { force: true });
    } catch (err) {
      console.warn('[storage] 清理临时文件失败：', file, err);
    }
  }

  /**
   * C8c：构造末尾扫一次自己留下的 `.tmp`（崩溃残骸）。**只在构造期跑** —— 那是唯一
   * 「本进程一定没有在途写入」的时刻。两道闸缺一不可：
   *   - **只扫自己前缀**（`basename(主文件) + '.'`）：chat store 永远不碰 harness store 的残骸；
   *   - **只扫够老的**（> `STALE_TMP_MS`）：新鲜的可能正是**另一个 VS Code 窗口**在写的，
   *     删了就是把别人的原子写打断在半路。
   * 整个函数绝不抛（体例同 `dshPaths.removeDshSessionDir`）。
   */
  private _sweepStaleTmp(): void {
    const dir = path.dirname(this._file);
    const prefix = path.basename(this._file) + '.';
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return; // 目录还不存在：没残骸可扫，正常
    }
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) {
        continue;
      }
      const full = path.join(dir, name);
      try {
        if (Date.now() - fs.statSync(full).mtimeMs > STALE_TMP_MS) {
          this._removeQuiet(full);
        }
      } catch {
        /* 单条读不到（被别的进程删了）就跳过 */
      }
    }
  }

  /** 新建一个会话对象（尚未入库，等你塞进消息后再 add）。 */
  create(title: string = ''): StoredSession {
    const now = Date.now();
    return { id: randomUUID(), title, createdAt: now, updatedAt: now, messages: [] };
  }

  all(): StoredSession[] {
    return this._sessions;
  }

  get(id: string): StoredSession | undefined {
    return this._sessions.find((s) => s.id === id);
  }

  has(id: string): boolean {
    return this._sessions.some((s) => s.id === id);
  }

  add(session: StoredSession): void {
    this._sessions.push(session);
  }

  replace(session: StoredSession): void {
    const i = this._sessions.findIndex((s) => s.id === session.id);
    if (i >= 0) {
      this._sessions[i] = session;
    } else {
      this._sessions.push(session);
    }
  }

  /**
   * C6：在列会话（有内容、且不在回收站），**历史列表与检索都只认它**。
   *
   * 「有内容」这条过滤规则只此一处 —— 从前 `_sendHistory` 里还抄了一份，两份必然漏改一处。
   * 返回新数组，调用方随便 sort 都不会动到内部顺序。
   */
  active(): StoredSession[] {
    return this._sessions.filter((s) => s.messages.length > 0 && s.deletedAt === undefined);
  }

  /** C6：回收站（已软删）。同样返回新数组；排序交给调用方，与 `active()` 对称。 */
  trashed(): StoredSession[] {
    return this._sessions.filter((s) => s.deletedAt !== undefined);
  }

  /**
   * C7 留存：回收站里「超过 days 天」的会话。**计数与执行共用这一个口径** ——
   * webview 只负责显示条数，绝不在那边重算判据（两份判据必然漂移，而这条漂移的代价是删错东西）。
   */
  expired(days: number, now: number = Date.now()): StoredSession[] {
    return this._sessions.filter((s) => isExpired(s, now, days));
  }

  /**
   * C6：软删除 —— **原地打标记，绝不把这个对象 filter 出数组**。
   *
   * 这不是风格问题：`_active` 就指向数组里那个对象，而 `replace()` 是「找不到就 push」，
   * 代码里已有两条现成的复活路径（`_afterTurn` 轮尾、`_openSession`）——一旦摘出去，
   * 用户删完再发一条消息，它就被重新 push 回列表，「删了又回来」。
   *
   * **幂等**：已删的不刷新 `deletedAt`（否则重复点删除会把删除时间越推越晚）。
   * @returns 是否真的改了状态；未知 id / 已删 → false（不抛）。
   */
  softDelete(id: string, at: number = Date.now()): boolean {
    const s = this.get(id);
    if (!s || s.deletedAt !== undefined) {
      return false;
    }
    s.deletedAt = at;
    return true;
  }

  /**
   * C6：从回收站恢复。顺带把 `updatedAt` 顶到当前时间 —— 列表按 updatedAt 倒序，
   * 不顶的话一个旧会话恢复后掉在列表很下面，用户会报「点了恢复但没看见」。
   * （`_openSession` 早有「动一下就 bump updatedAt」的先例，语义一致。）
   * @returns 是否真的改了状态；未知 id / 本来就没删 → false（不抛）。
   */
  restore(id: string): boolean {
    const s = this.get(id);
    if (!s || s.deletedAt === undefined) {
      return false;
    }
    delete s.deletedAt;
    s.updatedAt = Date.now();
    return true;
  }

  /**
   * C6：彻底删除（不可撤销）。**只删回收站里的** —— 对在列会话静默返回 false，
   * 这样任何调用点写错了也不会顺手销毁一个用户还在用的会话。
   */
  purge(id: string): boolean {
    const s = this.get(id);
    if (!s || s.deletedAt === undefined) {
      return false;
    }
    this.remove(id);
    return true;
  }

  /**
   * C6：清空回收站。@returns 清掉的条数（用于核对提示文案）。
   *
   * ⚠️ **别在删除路径上调它**（调用方请逐个走 `chatViewProvider._purgeOne`）。它一次性把条目摘掉，
   * 调用方**读不到每条会话的 `dsh` 身份** —— 于是磁盘上那些 DSH 日志会静默漏删，
   * 而「删除后磁盘无残留」正是 C7 的验收项。今天只有自检脚本在用它。
   */
  purgeTrashed(): number {
    const doomed = this.trashed();
    if (doomed.length === 0) {
      return 0;
    }
    const ids = new Set(doomed.map((s) => s.id));
    this._sessions = this._sessions.filter((s) => !ids.has(s.id));
    return ids.size;
  }

  /** 底层原语：把会话从数组里摘掉。想删会话请走 `softDelete`（软删）或 `purge`（回收站内彻底删）。 */
  remove(id: string): void {
    this._sessions = this._sessions.filter((s) => s.id !== id);
  }
}
