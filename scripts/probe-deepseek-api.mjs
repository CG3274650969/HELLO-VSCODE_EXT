#!/usr/bin/env node
/**
 * C23「余额读数 + 远端模型列表」 —— **不需要 VS Code、不需要真 API key、不碰真网络**。
 *
 * 守的是那条验收：「配置条上那枚余额钮读得出数、读不出时也说得清为什么；模型菜单由远端列表驱动、
 * 取不到时退回预设」。判据全在 `src/deepseekApi.ts`（不 import vscode —— C10b 的教训：
 * 判据必须能在扩展宿主之外加载，否则只能靠肉眼），HTTP 那一半打的是**本机假服务**。
 *
 * 这是本仓**唯一会往外发请求**的模块，所以这个文件里除了功能判据还有两条守卫：
 *   · **假 key 绝不出现在任何产出的字符串里**（`FetchResult` / `describeError` / `title`），
 *     包括"服务器把 key 回显在错误正文里"这种情形（F10/F11）；
 *   · **出口只有一个**（G 组按源码断言：`Authorization` 只出现一次、域名只在那个文件里）。
 *
 * ⚠️ 必须用仓里的 node 跑（系统 node 16 既没有 `fetch` 也没有 `AbortController`，
 * 而扩展宿主是 VS Code 的 Node 18+）—— 第一组 check 就把这条前提钉住：
 *
 *   ./dist-runtime/node/node.exe scripts/probe-deepseek-api.mjs
 */

import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(repoRoot, 'out');

async function load(moduleName) {
  const file = join(outDir, moduleName);
  if (!existsSync(file)) {
    console.error(`缺少编译产物：${file}\n  先跑 npm run compile（out/ 是 gitignored 的）。`);
    process.exit(2);
  }
  return import(pathToFileURL(file).href);
}

const api = await load('deepseekApi.js');
const {
  BALANCE_PATH,
  DEFAULT_TIMEOUT_MS,
  DEEPSEEK_BASE_URL,
  MODELS_PATH,
  REFRESH_INTERVAL_MS,
  describeError,
  fetchJson,
  formatAmount,
  formatClock,
  mergeModelList,
  parseAmount,
  parseBalance,
  parseModels,
  sanitize,
  usageFailed,
  usageFromBalance,
  usageLoading,
  usageNoKey,
} = api;

// ---------- 断言小工具（体例同 probe-change-forecast） ----------

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const r = fn();
    // 异步用例走 checkAsync。**这道守卫是必须的**：`check('x', async () => {...})` 会拿到一个
    // 永远真值的 Promise ⇒ 立即"通过"，里面的断言失败变成 unhandled rejection，探针全绿地骗人。
    if (r && typeof r.then === 'function') throw new Error('异步用例请用 checkAsync（check 不会 await 它）');
    if (r === false) throw new Error('断言返回 false');
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`✗ ${name}\n    ${err && err.message ? err.message : err}`);
  }
}

/** HTTP 那几条要起假服务，是 async 的 —— 单独一个入口，语义与 check 一致。 */
async function checkAsync(name, fn) {
  try {
    const r = await fn();
    if (r === false) throw new Error('断言返回 false');
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`✗ ${name}\n    ${err && err.message ? err.message : err}`);
  }
}

function ok(cond, what) {
  if (!cond) throw new Error(what);
}

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, `${what}\n    期望 ${e}，实到 ${a}`);
}

/** 假 key。**刻意长得像真的**（`sk-` 开头、够长）—— 抹除规则按这个形状写。 */
const FAKE_KEY = 'sk-0000000000000000000000000000000000000000';

/** 结果里绝不该出现的两样：完整假 key，以及任何 `sk-` 前缀。 */
function assertNoKey(text, where) {
  const s = String(text);
  ok(!s.includes(FAKE_KEY), `${where} 里出现了完整 API key`);
  ok(!/sk-[A-Za-z0-9_-]{6,}/.test(s), `${where} 里出现了像 key 的片段：${s.slice(0, 120)}`);
}

/**
 * 起一个只用一次的假服务：`listen(0, '127.0.0.1')` 拿随机端口，跑完必关。
 * `handler(req, res)` 决定怎么答；`recorded` 里留下我们关心的头（**不含 Authorization 的值
 * 之外的东西** —— 探针要断言那条头真的发了）。
 */
async function withServer(handler, fn) {
  const recorded = [];
  const server = createServer((req, res) => {
    recorded.push({ url: req.url, method: req.method, auth: req.headers.authorization });
    handler(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(baseUrl, recorded);
  } finally {
    // 超时那条用例的服务端**故意不应答**，连接还挂着 —— 不强制断掉 `close()` 会一直等到天荒地老
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

// ---------- 前提 ----------

check('前提：这台机器上的 node 有 fetch 与 AbortController（探针用仓里的 node 跑）', () => {
  eq(typeof fetch, 'function', '没有全局 fetch —— 你是不是在用系统 node 跑？请用 ./dist-runtime/node/node.exe');
  eq(typeof AbortController, 'function', '没有 AbortController');
});

check('常量：域名、两个路径、超时、轮询间隔都按用户拍板的取值', () => {
  eq(DEEPSEEK_BASE_URL, 'https://api.deepseek.com', '基础域名不对');
  eq(BALANCE_PATH, '/user/balance', '余额路径不对');
  eq(MODELS_PATH, '/models', '模型路径不对');
  eq(REFRESH_INTERVAL_MS, 5 * 60 * 1000, '轮询间隔不是 5 分钟');
  ok(DEFAULT_TIMEOUT_MS > 0 && DEFAULT_TIMEOUT_MS <= 30000, `超时不合理：${DEFAULT_TIMEOUT_MS}`);
});

// ---------- A 金额解析 ----------

check('A1 金额：字符串照数字读，空串/乱七八糟一律 undefined（**不是 0**）', () => {
  eq(parseAmount('28.70'), 28.7, '小数串没读出来');
  eq(parseAmount(' 12.5 '), 12.5, '带空白的串没 trim');
  eq(parseAmount('0.00'), 0, '真正的 0 该读成 0');
  eq(parseAmount(3), 3, '数字形态也该收');
  eq(parseAmount(''), undefined, '空串被当成了 0（这就是"把没说变成零"）');
  eq(parseAmount('abc'), undefined, '非数字串没有拒绝');
  eq(parseAmount('1e3'), undefined, '科学计数法不在契约里，不许猜');
  eq(parseAmount(null), undefined, 'null 没拒绝');
  eq(parseAmount(NaN), undefined, 'NaN 没拒绝');
  eq(parseAmount(Infinity), undefined, 'Infinity 没拒绝');
});

// ---------- B 余额解析 ----------

check('B1 余额：规范响应逐字段读出（金额留数字、币种原样）', () => {
  const r = parseBalance({
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '28.70', granted_balance: '8.70', topped_up_balance: '20.00' }],
  });
  ok(r.ok, `该成功却失败了：${JSON.stringify(r)}`);
  eq(r.value.available, true, 'is_available 没读出来');
  eq(r.value.infos.length, 1, '币种条数不对');
  eq(r.value.infos[0], { currency: 'CNY', total: 28.7, granted: 8.7, toppedUp: 20 }, '字段没对上');
});

check('B2 余额：形状不对（缺字段/不是数组/根不是对象）一律 shape，绝不抛', () => {
  for (const bad of [{}, { is_available: true }, { balance_infos: {} }, { balance_infos: 3 }, [], null, undefined, 'x']) {
    const r = parseBalance(bad);
    eq(r.ok, false, `这个输入该失败却成功了：${JSON.stringify(bad)}`);
    eq(r.kind, 'shape', `失败档不对：${JSON.stringify(bad)}`);
  }
});

check('B3 余额：一条脏数据只丢它自己，其他照读（一条脏不该让整栏读数消失）', () => {
  const r = parseBalance({
    is_available: true,
    balance_infos: [{ currency: 'XXX' }, null, { total_balance: '1.00' }, { currency: ' USD ' }, {}],
  });
  ok(r.ok, '整体失败了');
  eq(r.value.infos.length, 2, '该留下「有 currency 的」两条（其中一条金额全空）');
  eq(r.value.infos[0], { currency: 'XXX', total: undefined, granted: undefined, toppedUp: undefined }, '第 1 条不对');
  eq(r.value.infos[1].currency, 'USD', '币种没 trim');
});

check('B4 余额：`is_available` 缺席 ⇒ undefined，**不当成 false**（说"账户不可用"是个指控）', () => {
  const r = parseBalance({ balance_infos: [] });
  ok(r.ok, '空数组该是合法的（账户就是没有余额条目）');
  eq(r.value.available, undefined, '缺席被当成了 false');
  const f = parseBalance({ is_available: false, balance_infos: [] });
  eq(f.value.available, false, '真 false 没读出来');
});

// ---------- C 格式化与读数 ----------

check('C1 金额字面：CNY→¥、USD→$、认不出写「28.70 XYZ」', () => {
  eq(formatAmount(28.7, 'CNY'), '¥28.70', 'CNY 不对');
  eq(formatAmount(1, 'USD'), '$1.00', 'USD 不对');
  eq(formatAmount(28.7, 'xyz'), '28.70 xyz', '认不出的币种该带原码（不是替它认一个符号）');
  eq(formatAmount(undefined, 'CNY'), '—', '解析不出该写「—」，不是 0.00');
});

check('C2 读数正文：`余额：¥28.70`（用户拍板的字面），明细逐行在 title 里', () => {
  const v = usageFromBalance(
    { available: true, infos: [{ currency: 'CNY', total: 28.7, granted: 8.7, toppedUp: 20 }] },
    { at: Date.UTC(2026, 8, 24, 12, 3) }
  );
  eq(v.text, '余额：¥28.70', '按钮正文不是拍板的那一串');
  eq(v.stale, false, '成功档不该标陈旧');
  ok(v.title.includes('CNY：总额 ¥28.70 · 赠送 ¥8.70 · 充值 ¥20.00'), `明细行不对：${v.title}`);
  ok(/更新于 \d{2}:\d{2}/.test(v.title), `没有取数时刻：${v.title}`);
});

check('C3 读数：多币种正文取第一个、title 里逐条列全', () => {
  const v = usageFromBalance(
    {
      available: true,
      infos: [
        { currency: 'CNY', total: 28.7 },
        { currency: 'USD', total: 4.5 },
      ],
    },
    { at: Date.now() }
  );
  eq(v.text, '余额：¥28.70', '正文没取第一条');
  ok(v.title.includes('CNY：总额 ¥28.70'), 'title 少了第一条');
  ok(v.title.includes('USD：总额 $4.50'), 'title 少了第二条');
  ok(!v.title.includes('赠送'), '金额缺席时不该编一个赠送行');
});

check('C4 读数：账户不可用 → 正文「余额：不可用」并在 title 里写明依据', () => {
  const v = usageFromBalance({ available: false, infos: [{ currency: 'CNY', total: 28.7 }] }, { at: Date.now() });
  eq(v.text, '余额：不可用', '不可用档的正文不对');
  ok(v.title.includes('is_available'), `title 没说清是账户不可用：${v.title}`);
  ok(v.title.includes('¥28.70'), '余额数字该照留（不可用不等于没钱）');
});

check('C5 读数：接口没给任何余额条目 → 「余额：—」+ 说明（不是编个 0）', () => {
  const v = usageFromBalance({ available: true, infos: [] }, { at: Date.now() });
  eq(v.text, '余额：—', '空明细的正文不对');
  ok(v.title.includes('没有返回余额明细'), `title 没说清为什么是「—」：${v.title}`);
});

check('C6 读数：失败但手上有旧值 ⇒ 值留着、stale 置真、title 写明最近一次失败', () => {
  const v = usageFromBalance(
    { available: true, infos: [{ currency: 'CNY', total: 28.7 }] },
    { at: Date.now(), note: '最近一次查询失败：网络不可达' }
  );
  eq(v.text, '余额：¥28.70', '旧值被擦掉了（那等于丢掉已知信息）');
  eq(v.stale, true, '带了失败注记却没标陈旧');
  ok(v.title.includes('最近一次查询失败：网络不可达'), 'title 没写明失败原因');
});

check('C7 另外三档文案：未配 key / 在途 / 查不到（各自的出路不同，不许合成一档）', () => {
  const n = usageNoKey();
  eq(n.text, '余额：—', '未配 key 的正文不对');
  ok(n.title.includes('未配置') && n.title.includes('API'), `未配 key 的 title 没指出出路：${n.title}`);
  eq(n.stale, false, '未配 key 不该标陈旧');

  const l = usageLoading();
  eq(l.text, '余额：…', '在途档的正文不对');

  const f = usageFailed('unauthorized');
  eq(f.text, '余额：—', '失败档的正文不对');
  ok(f.title.includes('401') && f.title.includes('重试'), `失败档该说清原因并给出路：${f.title}`);
});

check('C8 formatClock 是本地 HH:MM（两位数补零）', () => {
  ok(/^\d{2}:\d{2}$/.test(formatClock(Date.now())), '格式不对');
});

// ---------- D 失败人话 / 密钥卫生 ----------

check('D1 失败人话：每一档都能说出**不同**的话，且带上状态码', () => {
  const kinds = ['no-key', 'unauthorized', 'forbidden', 'not-found', 'rate-limited', 'http', 'server', 'network', 'timeout', 'shape', 'unsupported'];
  const seen = new Map();
  for (const k of kinds) {
    const t = describeError(k);
    ok(t && t.length > 0, `${k} 没有说话`);
    ok(!seen.has(t), `${k} 与 ${seen.get(t)} 说了同一句话（分不清就白分档）：${t}`);
    seen.set(t, k);
    assertNoKey(t, `describeError(${k})`);
  }
  ok(describeError('unauthorized').includes('401'), '401 没写进人话');
  ok(describeError('http', 418).includes('418'), '兜底档没带上真实状态码');
  ok(describeError('server', 503).includes('503'), '5xx 没带上真实状态码');
  ok(describeError('timeout').includes(String(DEFAULT_TIMEOUT_MS / 1000)), '超时那条没写清是多少秒');
});

check('D2 sanitize：抹掉任何像 key 的片段、压平空白、截断长度', () => {
  eq(sanitize(`failed for ${FAKE_KEY} (bad)`), 'failed for sk-*** (bad)', 'key 没抹掉');
  ok(!/sk-[A-Za-z0-9_-]{6,}/.test(sanitize(`{"error":"${FAKE_KEY}"}`)), 'JSON 里的 key 漏了');
  eq(sanitize('a\n\n  b'), 'a b', '换行没压平');
  eq(sanitize('x'.repeat(500)).length, 200, '没有截断');
  eq(sanitize(''), '', '空串该原样');
});

check('D3 四档读数 + 全部失败人话里都**不含** key', () => {
  const views = [
    usageNoKey(),
    usageLoading(),
    usageFailed('network'),
    usageFromBalance({ available: true, infos: [{ currency: 'CNY', total: 1 }] }, { at: Date.now(), note: '最近一次查询失败：网络不可达' }),
  ];
  for (const v of views) {
    assertNoKey(v.text, `读数正文「${v.text}」`);
    assertNoKey(v.title, '读数 title');
  }
});

// ---------- E 模型列表解析与合并 ----------

check('E1 模型：只取非空字符串 id，去重保序（菜单里两行同名是纯粹的错误）', () => {
  const r = parseModels({ data: [{ id: 'a' }, { id: 'a' }, { id: ' b ' }, { id: '' }, { id: 3 }, null, 'x', { owned_by: 'y' }] });
  ok(r.ok, '该成功却失败了');
  eq(r.value, ['a', 'b'], '去重/保序/过滤没做对');
  eq(parseModels({ data: [] }).value, [], '空列表该是合法的');
  for (const bad of [{}, { data: {} }, { data: 3 }, null, []]) {
    eq(parseModels(bad).kind, 'shape', `这个输入该判 shape：${JSON.stringify(bad)}`);
  }
});

check('E2 合并：远端非空就用远端（**不是并集** —— 预设只在取不到时露面）', () => {
  const presets = ['deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'];
  eq(mergeModelList(['a', 'b'], 'a', presets), ['a', 'b'], '远端列表被改动了');
  const withMissing = mergeModelList(['a', 'b'], 'a', presets);
  ok(!withMissing.includes('deepseek-chat'), '预设混进了远端列表（那就成了并集）');
});

check('E3 合并：取不到远端（undefined / [] / 垃圾）⇒ 原样退回预设', () => {
  const presets = ['deepseek-v4-flash', 'deepseek-chat'];
  for (const remote of [undefined, null, [], 'x', {}]) {
    eq(mergeModelList(remote, 'deepseek-chat', presets), presets, `${JSON.stringify(remote)} 没退回预设`);
  }
});

check('E4 合并：当前在用的模型永远在列表里（不在就置顶，在就不重复）', () => {
  const presets = ['deepseek-v4-flash'];
  eq(mergeModelList(['a', 'b'], 'z', presets), ['z', 'a', 'b'], '当前模型没置顶');
  eq(mergeModelList(['a', 'b'], 'a', presets), ['a', 'b'], '当前模型已在列表里却又被插了一遍');
  eq(mergeModelList([], 'z', presets), ['z', 'deepseek-v4-flash'], '退回预设时当前模型没进去');
});

// ---------- F HTTP（本机假服务） ----------

await checkAsync('F1 请求形状：GET 到 baseUrl+path，带 `Authorization: Bearer <key>` 与 Accept', async () => {
  await withServer(
    (req, res) => json(res, 200, { is_available: true, balance_infos: [] }),
    async (baseUrl, recorded) => {
      const r = await fetchJson(BALANCE_PATH, { key: FAKE_KEY, baseUrl });
      ok(r.ok, `该成功却失败了：${JSON.stringify(r)}`);
      eq(recorded.length, 1, '该恰好发一个请求');
      eq(recorded[0].method, 'GET', '方法不对');
      eq(recorded[0].url, BALANCE_PATH, '路径不对');
      eq(recorded[0].auth, `Bearer ${FAKE_KEY}`, '授权头不对（key 没发出去或格式错）');
    }
  );
});

await checkAsync('F2 状态码归一：401/403/404/429 各归各档，5xx 带状态码，其余 4xx 走 http', async () => {
  const cases = [
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not-found'],
    [429, 'rate-limited'],
    [500, 'server'],
    [503, 'server'],
    [418, 'http'],
  ];
  for (const [status, kind] of cases) {
    await withServer(
      (req, res) => json(res, status, { error: 'nope' }),
      async (baseUrl) => {
        const r = await fetchJson(BALANCE_PATH, { key: FAKE_KEY, baseUrl });
        eq(r.ok, false, `${status} 该失败`);
        eq(r.kind, kind, `${status} 归错档了`);
        eq(r.status, status, `${status} 没带上真实状态码`);
      }
    );
  }
});

await checkAsync('F3 2xx 但正文不是 JSON ⇒ shape（不是"成功但空"）', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>网关登录页</html>');
    },
    async (baseUrl) => {
      const r = await fetchJson(BALANCE_PATH, { key: FAKE_KEY, baseUrl });
      eq(r.kind, 'shape', '畸形正文归错档了');
    }
  );
});

await checkAsync('F4 服务端不应答 ⇒ timeout（用 200ms 的超时验，不真等 8 秒）', async () => {
  await withServer(
    () => {
      /* 故意不答 */
    },
    async (baseUrl) => {
      const t0 = Date.now();
      const r = await fetchJson(BALANCE_PATH, { key: FAKE_KEY, baseUrl, timeoutMs: 200 });
      eq(r.kind, 'timeout', '没归成超时');
      ok(Date.now() - t0 < 5000, '超时没生效（这一发挂太久了）');
    }
  );
});

await checkAsync('F5 连不上（127.0.0.1:1）⇒ network', async () => {
  const r = await fetchJson(BALANCE_PATH, { key: FAKE_KEY, baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000 });
  eq(r.kind, 'network', '拒连没归成 network');
});

await checkAsync('F6 没有 key ⇒ no-key，且**一个请求都不发**（闸①）', async () => {
  await withServer(
    (req, res) => json(res, 200, {}),
    async (baseUrl, recorded) => {
      const r = await fetchJson(BALANCE_PATH, { key: '', baseUrl });
      eq(r.kind, 'no-key', '没归成 no-key');
      eq(recorded.length, 0, '没 key 竟然还是发了请求');
    }
  );
});

await checkAsync('F7 宿主没有传输层（fetchImpl: null）⇒ unsupported（降级，不抛）', async () => {
  const r = await fetchJson(BALANCE_PATH, { key: FAKE_KEY, fetchImpl: null });
  eq(r.kind, 'unsupported', '没归成 unsupported');
  assertNoKey(JSON.stringify(r), 'unsupported 结果');
});

await checkAsync('F8 服务器把 key 回显在错误正文里 ⇒ detail 里已被抹掉（进消息前最后一道闸）', async () => {
  await withServer(
    (req, res) => json(res, 401, { error: `invalid api key: ${FAKE_KEY}` }),
    async (baseUrl) => {
      const r = await fetchJson(BALANCE_PATH, { key: FAKE_KEY, baseUrl });
      eq(r.kind, 'unauthorized', '归错档了');
      assertNoKey(r.detail, 'detail');
      assertNoKey(JSON.stringify(r), '整个 FetchResult');
      ok(r.detail.includes('sk-***'), `该留下被抹过的形状（而不是整段丢掉）：${r.detail}`);
    }
  );
});

await checkAsync('F9 畸形正文里塞了 key ⇒ shape 档里也没有它', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(`{"note":"${FAKE_KEY}"`); // 截断的 JSON
    },
    async (baseUrl) => {
      const r = await fetchJson(BALANCE_PATH, { key: FAKE_KEY, baseUrl });
      eq(r.kind, 'shape', '归错档了');
      assertNoKey(JSON.stringify(r), 'shape 结果');
    }
  );
});

await checkAsync('F10 两个接口都走同一条路（/models 也用同一个函数、同一套头）', async () => {
  await withServer(
    (req, res) => json(res, 200, { data: [{ id: 'm1' }] }),
    async (baseUrl, recorded) => {
      const r = await fetchJson(MODELS_PATH, { key: FAKE_KEY, baseUrl });
      ok(r.ok, '该成功却失败了');
      eq(recorded[0].url, MODELS_PATH, '模型接口的路径不对');
      eq(recorded[0].auth, `Bearer ${FAKE_KEY}`, '模型接口没带授权头');
      eq(parseModels(r.json).value, ['m1'], '解析链路断了');
    }
  );
});

// ---------- G 源码结构守卫 ----------

const readSrc = (f) => readFileSync(join(repoRoot, 'src', f), 'utf8');

check('G1 纯模块：`src/deepseekApi.ts` 不 import vscode（否则判据只能靠肉眼）', () => {
  const src = readSrc('deepseekApi.ts');
  ok(!/from ['"]vscode['"]/.test(src), 'import 了 vscode');
});

check('G2 出站口唯一：`Authorization` 只出现在**一处代码**里，域名不在别的 src 文件里', () => {
  // 先剥注释：这个模块的注释里到处在讲"key 只进请求头"，那是说明，不是第二个拼 key 的地方。
  const src = readSrc('deepseekApi.ts')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  eq((src.match(/Authorization/g) || []).length, 1, '`Authorization` 出现了不止一次 —— 多一个拼 key 的地方就多一条泄漏路');
  eq((src.match(/Bearer/g) || []).length, 1, '`Bearer` 出现了不止一次');
  for (const f of ['chatViewProvider.ts', 'extension.ts', 'dshHooks.ts', 'approvalServer.ts']) {
    ok(!readSrc(f).includes('api.deepseek.com'), `${f} 里出现了 DeepSeek 域名 —— 出站口不许有第二个`);
  }
});

check('G3 三条闸在位：没 key 不发 / 在途不叠发 / 停表两条销毁路径都调了', () => {
  const src = readSrc('chatViewProvider.ts');
  const body = src.slice(src.indexOf('private async _refreshBalance'), src.indexOf('private _applyBalance'));
  ok(body.includes('_resolveApiKey'), '闸①（没 key 不发）不见了');
  ok(body.includes('_balanceInFlight'), '闸②（在途不叠发）不见了');
  ok(body.includes("kind: 'harness'") || body.includes("!== 'harness'"), '缺少「非 harness 不联网」这道模式闸');
  // 闸③：两条销毁路径都要停表（少一条就是"窗口关了还在每 5 分钟发一次"）
  const dispose = src.slice(src.indexOf('  dispose(): void {'), src.indexOf('  // ---------- 消息路由'));
  ok(dispose.includes('_stopBalancePolling()'), 'dispose() 里没停表');
  const onDispose = src.slice(src.indexOf('webviewView.onDidDispose'), src.indexOf('webviewView.onDidDispose') + 400);
  ok(onDispose.includes('_stopBalancePolling()'), 'onDidDispose 里没停表');
});

check('G4 表只有一个、间隔用的是常量：provider 里 setInterval 只出现一次且吃 REFRESH_INTERVAL_MS', () => {
  const src = readSrc('chatViewProvider.ts');
  eq((src.match(/setInterval\(/g) || []).length, 1, 'provider 里不止一处 setInterval —— 多一个表就多一条没人管的出站');
  const at = src.indexOf('setInterval(');
  ok(src.slice(at, at + 120).includes('REFRESH_INTERVAL_MS'), '轮询间隔没走 REFRESH_INTERVAL_MS（写死数字 = 探针钉不住它）');
  const stop = src.slice(src.indexOf('private _stopBalancePolling'), src.indexOf('private _stopBalancePolling') + 200);
  ok(stop.includes('clearInterval('), '_stopBalancePolling 没真的清表');
  ok(stop.includes('_balanceTimer = undefined'), '清完表没置空 —— 下次 start 会以为还有表');
});

check('G5 协议：两条新消息在 protocol.ts 里，且余额那条**不带任何 key/正文**字段', () => {
  const proto = readSrc('protocol.ts');
  ok(proto.includes("type: 'live-balance'"), 'ExtToWebview 少了 live-balance');
  ok(proto.includes("type: 'refresh-balance'"), 'WebviewToExt 少了 refresh-balance');
  const at = proto.indexOf("type: 'live-balance'");
  const line = proto.slice(at, proto.indexOf('\n', at));
  ok(!/key|url|body|detail/i.test(line), `live-balance 的字段里混进了不该有的东西：${line}`);
});

check('G6 key 的流向没被改写：注入子进程 env 那一处还在、且只有一处', () => {
  const src = readSrc('chatViewProvider.ts');
  eq((src.match(/env\.DEEPSEEK_API_KEY = /g) || []).length, 1, '写入子进程 env 的那一处不见了或不止一处 —— key 的流向变了就得重新解释一遍');
});

// ---------- 汇总 ----------

console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 条未过（共 ${passed + failures.length} 条）：`);
  for (const f of failures) console.log(`   · ${f}`);
} else {
  console.log(`✓ 全部通过：${passed}/${passed}`);
}
// ⚠️ 不用 process.exit()：Windows 上被管道重定向的 stdout 是异步写，退出会丢结论行。
process.exitCode = failures.length ? 1 : 0;
