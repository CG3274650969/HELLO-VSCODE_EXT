/**
 * C23 · 余额读数 + 远端模型列表：**解析、格式化、以及那个唯一会往外发请求的薄 HTTP 层**。
 *
 * **不 import vscode** —— 同 `contextWindow` / `changeForecast` / `runInspector` 的体例，
 * 判据必须能在扩展宿主之外被加载（`scripts/probe-deepseek-api.mjs` 载 `out/deepseekApi.js`）。
 * 这条在本仓库不是洁癖：这个模块里几乎每一行都是"拿不到/拿到怪东西时该怎么办"，
 * 而那些分支只有探针能反复走 —— 真机上一年也撞不到一次 401，撞到一次就是"余额安静地变成 —"。
 *
 * 三条设计约束，都来自这个仓已有的教训：
 *
 * 1. **密钥只进请求头，绝不出现在任何返回值里**。`fetchJson()` 自己拼 `Authorization`，
 *    返回值里只有 `{ok, kind, detail}` —— 调用方拿不到 header，也就没有"顺手把它拼进错误信息"
 *    的机会。服务器的报错正文在进 `detail` 之前一律过 `sanitize()`：**它可能把 key 回显出来**，
 *    而 tooltip 是给人看的、也可能被截图外传。
 * 2. **不猜**。`is_available` 缺席时不当成"不可用"，金额解析不出时不当成 0 —— 说不知道，
 *    而不是编一个数（C10b 那条"未知不是 0"的同一条规矩）。
 * 3. **`baseUrl` 与传输可注入**：探针起一个本机假服务跑**同一条真实代码路径**，
 *    不联网、不用真 key。这也是选 `fetch` 而不是 `node:https` 的主要理由 ——
 *    后者要测就得给探针造自签证书，然后"测的那条路"和"生产的那条路"就分家了。
 */

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 生产环境的唯一目标。**写死** —— `baseUrl` 只给探针注入，不给用户配置入口。 */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const BALANCE_PATH = '/user/balance';
export const MODELS_PATH = '/models';
export const DEFAULT_TIMEOUT_MS = 8000;
/** 余额与模型列表的自动刷新间隔（用户 2026-09-24 拍板：连接时 / 新建对话时 / 之后每 5 分钟）。 */
export const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/** 服务端正文进 detail 之前截断的长度 —— tooltip 不该变成一屏 HTML。 */
const DETAIL_MAX = 200;

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

/**
 * 失败的种类。**这里只放"能给出不同人话"的档**，不是 HTTP 状态码表：
 * `http` 兜住剩下那些 4xx，具体码在 `status` 里。
 */
export type ErrorKind =
  | 'no-key'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'rate-limited'
  | 'http'
  | 'server'
  | 'network'
  | 'timeout'
  | 'shape'
  | 'unsupported';

export interface BalanceInfo {
  currency: string;
  /** 总额。**解析不出就是 undefined**，不留 0（0 是"真的是零"，undefined 是"没说"）。 */
  total?: number;
  granted?: number;
  toppedUp?: number;
}

export interface ParsedBalance {
  /** 原样保留三态：`true` 可用 / `false` 不可用 / `undefined` 接口没说。 */
  available?: boolean;
  infos: BalanceInfo[];
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; kind: ErrorKind };

/** webview 那一栏要的全部东西：文案（按钮正文）+ title（明细）+ 是否陈旧。 */
export interface UsageView {
  text: string;
  title: string;
  stale: boolean;
}

/** 我们真正用到的那一小撮 Response 形状。 */
export interface MinimalResponse {
  status: number;
  ok: boolean;
  text(): Promise<string>;
  json(): Promise<unknown>;
}
export interface MinimalRequestInit {
  method: string;
  headers: Record<string, string>;
  signal?: unknown;
}
export type FetchLike = (url: string, init: MinimalRequestInit) => Promise<MinimalResponse>;

export type FetchResult = { ok: true; json: unknown } | { ok: false; kind: ErrorKind; status?: number; detail?: string };

/* ------------------------------------------------------------------ *
 * tsconfig 的 lib 只有 ES2022（没有 DOM）⇒ fetch / AbortController 在类型上不存在。
 * 这里**不**把 DOM 或 undici 的类型拉进来（那等于给一个"零依赖"的仓悄悄加了一层类型依赖，
 * 而且它们的形状比我们需要的宽得多），只按用到的部分自己声明。
 * ------------------------------------------------------------------ */

interface MinimalAbortController {
  abort(): void;
  signal: unknown;
}

/**
 * 取宿主全局的 fetch。
 *
 * **`.call(globalThis, …)` 不是多余的**：浏览器里把 fetch 摘下来单独调用会 `Illegal invocation`，
 * Node 的 undici 实现今天不挑 `this`，但"今天不挑"不是契约 —— 一层 wrapper 换掉一整类
 * 只在真机才出现的怪毛病，值。
 */
function hostFetch(): FetchLike | undefined {
  const raw = (globalThis as unknown as { fetch?: unknown }).fetch;
  if (typeof raw !== 'function') return undefined;
  return (url, init) => (raw as FetchLike).call(globalThis, url, init);
}

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 金额：接口给的是**字符串**（`"28.70"`），也可能是数字。
 * 解析不出（`""` / `"abc"` / `NaN` / `Infinity` / 别的类型）⇒ undefined。
 * **不 `Number()` 一把梭**：`Number("")` 是 0、`Number(null)` 是 0 —— 两个都会把"没说"变成"零"。
 */
export function parseAmount(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * `/user/balance` 的形状：`{is_available, balance_infos:[{currency, total_balance, granted_balance, topped_up_balance}]}`。
 *
 * - `balance_infos` **不是数组** ⇒ `shape`（这是"接口变了"，不是"这个账户没有余额"）；
 * - 数组里某一条不成形（缺 currency / 不是对象）⇒ **跳过那一条**，不整体失败 ——
 *   一条脏数据不该让整栏读数消失；
 * - `is_available` 不是布尔 ⇒ `undefined`（**不当成 false**：说"账户不可用"是个指控）。
 */
export function parseBalance(raw: unknown): ParseResult<ParsedBalance> {
  const root = asRecord(raw);
  if (!root) return { ok: false, kind: 'shape' };
  const list = root.balance_infos;
  if (!Array.isArray(list)) return { ok: false, kind: 'shape' };
  const infos: BalanceInfo[] = [];
  for (const item of list) {
    const row = asRecord(item);
    if (!row || typeof row.currency !== 'string' || !row.currency.trim()) continue;
    infos.push({
      currency: row.currency.trim(),
      total: parseAmount(row.total_balance),
      granted: parseAmount(row.granted_balance),
      toppedUp: parseAmount(row.topped_up_balance),
    });
  }
  return { ok: true, value: { available: typeof root.is_available === 'boolean' ? root.is_available : undefined, infos } };
}

/**
 * `/models` 的形状：`{data:[{id, owned_by}]}`。
 * 只取 `id`（`owned_by` 界面上没用），**去重保序**：菜单里出现两行同名的模型是纯粹的错误。
 */
export function parseModels(raw: unknown): ParseResult<string[]> {
  const root = asRecord(raw);
  if (!root || !Array.isArray(root.data)) return { ok: false, kind: 'shape' };
  const ids: string[] = [];
  for (const item of root.data) {
    const row = asRecord(item);
    if (!row || typeof row.id !== 'string') continue;
    const id = row.id.trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return { ok: true, value: ids };
}

/**
 * 菜单最终显示哪些模型：**远端非空就用远端，否则退回本地预设**（用户 2026-09-24 拍板）。
 *
 * 一条规则覆盖两个分支（今天 `_postLiveConfig()` 里那句 `PRESET_MODELS.includes(model) ? … : [model, …]`
 * 长在这里）：当前在用的模型**永远在列表里**，不在就插到最前 —— 否则用户会看到"正在用的模型
 * 不在可选项里"这种自相矛盾的菜单。
 */
export function mergeModelList(remote: unknown, current: string, presets: readonly string[]): string[] {
  const ids = Array.isArray(remote) ? remote.filter((x): x is string => typeof x === 'string' && !!x) : [];
  const list = ids.length ? ids.slice() : presets.slice();
  if (current && !list.includes(current)) list.unshift(current);
  return list;
}

/* ------------------------------------------------------------------ *
 * 密钥卫生
 * ------------------------------------------------------------------ */

/**
 * 抹掉任何像 key 的片段，并截断长度。
 *
 * 为什么需要它：`detail` 里放的是**服务器返回的正文**，而我们控制不了服务器回什么
 * （有的实现在报错时会把收到的 Authorization 回显出来）。这是"防止我们把 key 写出去"之外
 * 的第二道闸 —— 第一道是结构上的（key 只在 `fetchJson` 内部拼进 header，从不进返回值）。
 */
export function sanitize(text: string): string {
  return String(text)
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DETAIL_MAX);
}

/** 一个 key 都没配时的读数。 */
export function usageNoKey(): UsageView {
  return {
    text: '余额：—',
    title: '未配置 DEEPSEEK_API_KEY —— 点「API」配置后会自动查询余额',
    stale: false,
  };
}

/** 首次查询在途（**只在还没有任何值的时候显示**，否则会闪）。 */
export function usageLoading(): UsageView {
  return { text: '余额：…', title: '正在查询余额…', stale: false };
}

/** 查不到、且从来没有过好值时：说清楚为什么，并允许点一下重试。 */
export function usageFailed(kind: ErrorKind, status?: number): UsageView {
  return {
    text: '余额：—',
    title: `${describeError(kind, status)} —— 点一下重试`,
    stale: false,
  };
}

/** `HH:MM`（本地时区）。 */
export function formatClock(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const CURRENCY_SYMBOL: Record<string, string> = { CNY: '¥', USD: '$' };

/**
 * 金额 → 字面。**两位小数**：接口给的是钱，`28.7` 写成 `28.70` 才像读数而不是像浮点数。
 * 解析不出 ⇒ `—`（不是 `0.00`）。
 */
export function formatAmount(total: number | undefined, currency: string): string {
  if (total === undefined) return '—';
  const n = total.toFixed(2);
  const sym = CURRENCY_SYMBOL[currency.toUpperCase()];
  return sym ? `${sym}${n}` : `${n} ${currency}`;
}

/**
 * 有余额值时的读数（成功档，**也用于"上次成功、这次失败"** —— 那时传 `note`，
 * 旧值照留、`stale` 置真：把上次数值擦成 `—` 是丢掉已知信息，而 C22 已经立过
 * "陈旧"该怎么表达：值留着、话说明白）。
 */
export function usageFromBalance(balance: ParsedBalance, opts: { at: number; note?: string }): UsageView {
  const lines: string[] = [];
  const unavailable = balance.available === false;
  // 多币种只把第一个放进按钮正文，全部逐行放进 title（按钮宽度是稀缺资源）
  const head = balance.infos[0];
  let text: string;
  if (unavailable) {
    text = '余额：不可用';
    lines.push('账户当前不可用（is_available = false）');
  } else if (!head) {
    text = '余额：—';
    lines.push('接口没有返回余额明细');
  } else {
    text = `余额：${formatAmount(head.total, head.currency)}`;
  }
  for (const info of balance.infos) {
    const parts: string[] = [`总额 ${formatAmount(info.total, info.currency)}`];
    if (info.granted !== undefined) parts.push(`赠送 ${formatAmount(info.granted, info.currency)}`);
    if (info.toppedUp !== undefined) parts.push(`充值 ${formatAmount(info.toppedUp, info.currency)}`);
    lines.push(`${info.currency}：${parts.join(' · ')}`);
  }
  lines.push(`更新于 ${formatClock(opts.at)}`);
  if (opts.note) lines.push(opts.note);
  return { text, title: lines.join('\n'), stale: !!opts.note };
}

/** 失败种类 → 人话。**不带 url、不带 header、不带 key**。 */
export function describeError(kind: ErrorKind, status?: number): string {
  switch (kind) {
    case 'no-key':
      return '未配置 API Key';
    case 'unauthorized':
      return 'API Key 无效或被拒绝（401）';
    case 'forbidden':
      return '没有访问权限（403）';
    case 'not-found':
      return '接口不存在（404）';
    case 'rate-limited':
      return '请求过于频繁（429）';
    case 'http':
      return `接口返回了错误状态（${status ?? '?'}）`;
    case 'server':
      return `服务端错误（${status ?? '5xx'}）`;
    case 'network':
      return '网络不可达';
    case 'timeout':
      return `请求超时（${DEFAULT_TIMEOUT_MS / 1000} 秒）`;
    case 'shape':
      return '返回内容不是预期格式（接口可能变了）';
    case 'unsupported':
      return '当前宿主不支持网络请求（没有可用的 fetch）';
  }
}

/* ------------------------------------------------------------------ *
 * HTTP：本仓第一处扩展自己发出的请求
 * ------------------------------------------------------------------ */

function statusToKind(status: number): ErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'server';
  return 'http';
}

export interface FetchOpts {
  /** 只在 `fetchJson` 内部拼进 `Authorization`，**不存、不返回、不进日志**。 */
  key: string;
  /** 探针注入本地假服务用；生产走默认值。 */
  baseUrl?: string;
  timeoutMs?: number;
  /** 不给就从宿主全局取；宿主没有 ⇒ `unsupported`（降级成一条读数说明，不抛）。
   *  **传 `null` = 明确声明"这里没有传输层"** —— 探针用它验那条降级路径（生产不传；
   *  系统 node 16 没有全局 fetch，这个分支不是假想出来的）。 */
  fetchImpl?: FetchLike | null;
  /** 探针用来测超时：不给就用宿主全局的 AbortController。 */
  makeAbort?: () => MinimalAbortController;
}

function hostAbort(): MinimalAbortController | undefined {
  const Ctor = (globalThis as unknown as { AbortController?: new () => MinimalAbortController }).AbortController;
  return typeof Ctor === 'function' ? new Ctor() : undefined;
}

/**
 * `GET baseUrl + path`，带超时与错误归一。
 *
 * 返回的 `detail` 是**已经过 `sanitize()`** 的服务端正文（最多 200 字），用于人话之外的现场；
 * 它是可选的，探针会断言"哪怕服务器把 key 回显在正文里，detail 里也不含它"。
 */
export async function fetchJson(path: string, opts: FetchOpts): Promise<FetchResult> {
  if (!opts.key) return { ok: false, kind: 'no-key' };
  // ⚠️ `null` 与 `undefined` 在这里**语义不同**：`undefined` = "用宿主的"，`null` = "没有传输层"。
  // 写成 `opts.fetchImpl ?? hostFetch()` 会把两者混成一个（`??` 对 null 也回退）。
  const f = opts.fetchImpl === null ? undefined : (opts.fetchImpl ?? hostFetch());
  if (!f) return { ok: false, kind: 'unsupported' };

  const base = opts.baseUrl ?? DEEPSEEK_BASE_URL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ctrl = (opts.makeAbort ?? hostAbort)();
  let timedOut = false;
  const timer = ctrl
    ? setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, timeoutMs)
    : undefined;

  let res: MinimalResponse;
  try {
    res = await f(base + path, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${opts.key}` },
      signal: ctrl?.signal,
    });
  } catch {
    // ⚠️ 这里**不把异常对象往外抛也不拼进消息**：fetch 的 rejection 里可能带 url。
    return { ok: false, kind: timedOut ? 'timeout' : 'network' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  if (!res.ok) {
    const kind = statusToKind(res.status);
    let detail: string | undefined;
    try {
      detail = sanitize(await res.text()) || undefined;
    } catch {
      detail = undefined;
    }
    return { ok: false, kind, status: res.status, detail };
  }
  try {
    return { ok: true, json: await res.json() };
  } catch {
    return { ok: false, kind: 'shape', status: res.status };
  }
}
