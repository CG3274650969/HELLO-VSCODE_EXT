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

  remove(id: string): void {
    this._sessions = this._sessions.filter((s) => s.id !== id);
  }
}
