/**
 * 会话的持久化存储：把历史会话写进扩展 globalStorage 下的 sessions.json，
 * 重启扩展宿主 / 重启 VS Code 后仍能找回。
 *
 * 只存「有内容的会话」（messages 非空）；正在输入的空新会话不入列。
 * 消息里的 status 若是遗留的 streaming（上次异常退出），加载时一律改成 interrupted，
 * 避免某条永远"生成中"把输入锁死。
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { ChatMessage, UsageBuckets } from './protocol';

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
}

/** 由首条用户消息生成一句话标题（单行、截断）。 */
export function titleFromText(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 24 ? oneLine.slice(0, 24) + '…' : oneLine;
}

function normalize(session: StoredSession): StoredSession {
  // 清掉异常中断残留的「正在生成」状态
  for (const m of session.messages) {
    if (m.status === 'streaming') {
      m.status = 'interrupted';
    }
    // 上次异常退出可能留下永远 running 的工具卡 → 落成 error，避免回放时转圈
    if (m.role === 'tool' && m.toolState === 'running') {
      m.toolState = 'error';
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
  return session;
}

export class SessionStore {
  private readonly _file: string;
  private _sessions: StoredSession[] = [];

  /**
   * @param storageDir globalStorage 目录
   * @param fileName   落盘文件名。两种模式各用一个文件：
   *                   chat → 'sessions.json'（默认，兼容旧数据）；
   *                   harness → 'sessions-harness.json'，历史互不串。
   */
  constructor(storageDir: string, fileName: string = 'sessions.json') {
    this._file = path.join(storageDir, fileName);
    this._load();
  }

  private _load(): void {
    try {
      const raw = fs.readFileSync(this._file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // ⚠️ 这里**只**按 messages 过滤，绝不要补一句 `&& !s.deletedAt`：回收站的会话必然有消息
        // （空会话根本进不了列表），所以它天然活得过重启；补上那句会让回收站一重启就空。
        this._sessions = parsed
          .filter((s): s is StoredSession => !!s && Array.isArray((s as StoredSession).messages))
          .filter((s) => s.messages.length > 0)
          .map(normalize);
      }
    } catch {
      this._sessions = []; // 文件不存在 / 损坏 → 从空开始
    }
  }

  /** 把当前内存状态整段写盘（会话量很小，直接覆盖写最简单）。 */
  persist(): void {
    try {
      fs.mkdirSync(path.dirname(this._file), { recursive: true });
      fs.writeFileSync(this._file, JSON.stringify(this._sessions, null, 2), 'utf8');
    } catch (err) {
      console.error('保存历史会话失败：', err);
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

  /** C6：清空回收站。@returns 清掉的条数（用于核对提示文案）。 */
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
