#!/usr/bin/env node
/**
 * C1/C4 审批**决策回路**自检 —— **不需要 VS Code、不需要 API key、不发任何模型调用**。
 *
 * 守的是这条链的每一段（此前只有 C1 的真机 F5 用人眼走过一遍，判据全在 import vscode 的类里）：
 *
 *   hooks-claude-code 插件 → 我们的 hook 脚本 → POST /pre-tool-use → ApprovalServer
 *     → 用户在条上拍板 → 决策回给脚本 → 脚本用 CC 方言表态（deny / 不表态）→ DSH 放不放行
 *
 * 为什么值得单独钉（2026-09-18，跟 C10b 同一个病灶）：
 *   「点了拒绝，命令真的没执行」这一条，此前只有一次真机肉眼见证；而**判据住在一个 import vscode
 *   的类里**，任何一条探针都够不着它。C10b 那次事故证明这种判据会安静地坏掉 —— 所以把
 *   整条回路（真服务 + 真脚本 + 真 HTTP + 真子进程）搬到扩展宿主之外来跑。
 *
 * ⚠️ **本探针不执行任何命令**：hook 脚本自己只"问"，全文没有任何 spawn/exec，所以下面那些
 *    `rm -rf` 只是字符串。真正危险的那半（DSH 拿到 deny 之后不执行）由协议保证，也正是本项要钉的。
 *
 * 两条工具的兜底**故意不一样**，各钉一遍：bash 不可达时按内置清单 fail-closed（不能让扩展挂掉
 * 就等于 shell 全放行），write/edit 不可达时 fail-open（护栏坏了不该把正常写文件一起拖下水）。
 *
 *   npm run compile && ./dist-runtime/node/node.exe scripts/probe-approval-roundtrip.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

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

const { writeApprovalHookFiles } = await load('dshHooks.js');
const { ApprovalServer, matchesAnyPattern } = await load('approvalServer.js');

// ---------- 断言小工具 ----------

let passed = 0;
const failures = [];

async function check(name, fn) {
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

function eq(actual, expected, what = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}：期望 ${e}，实得 ${a}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `buildHookCommand` 里 `quote()` 的逆运算：把 `"…"` 里的 `\` 还原回单个。
 * 断言「命令里到底有没有这个路径」时**不能**直接 `includes(路径)` —— Windows 路径里全是 `\`，
 * 写进命令串时被转义成了 `\\`，字面量比对必然假红（第一版就是这么错的）。
 * 这里复原的是同一份文本，不是「另一个预期」；真正的转义是否被 shell 正确解析由 C1 的自检覆盖
 * （`testApprovalHook` 用 `bash -c <这条命令>` 真跑一遍）。
 */
function unquoteCommand(cmd) {
  return cmd.replace(/"((?:[^"\\]|\\.)*)"/g, (_, body) => body.replace(/\\(["\\$`])/g, '$1'));
}

// ---------- 现场：一次性 storageDir + 最小基础配置 ----------

const scratch = mkdtempSync(join(tmpdir(), 'hello-approval-rt-'));
// 根必须是块状序列（`-` 开头）才允许追加 hooks 块，否则 writeApprovalHookFiles 会拒绝生成
const baseConfigPath = join(scratch, 'base-cordis.yml');
writeFileSync(
  baseConfigPath,
  '# 自检用的最小基础配置：我们只验证回路通不通，不启动任何真插件\n- id: probe-base\n  name: \'@deepseek-ai/dsh-probe-placeholder\'\n',
  'utf8'
);

const servers = [];
process.on('exit', () => {
  for (const s of servers) s.dispose();
});

/** 跑一次 hook 脚本：argv 与 hooks.json 里那条 command 逐项对应（`buildHookCommand` 的产物）。 */
function runHook(scriptPath, { url, token, timeoutMs, payload }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      [scriptPath, '--url', url, '--token', token, '--timeout-ms', String(timeoutMs)],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => {
      err += c;
    });
    // 兜底：脚本挂住时不能让探针跟着挂（探针永不 process.exit，只置 exitCode）
    const killer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error(`hook 超时未退出（stdout=${JSON.stringify(out)}）`));
    }, 20000);
    child.on('error', (e) => {
      clearTimeout(killer);
      rejectPromise(e);
    });
    child.on('exit', (code) => {
      clearTimeout(killer);
      resolvePromise({ code, stdout: out, stderr: err });
    });
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

/** 起一个真服务 + 生成真三件套。asks/resolved/observed 是三层回调的账本。 */
async function harness({ shouldAsk, timeoutMs = 5000 } = {}) {
  const asks = [];
  const resolved = [];
  const observed = [];
  const server = new ApprovalServer(
    shouldAsk ?? (() => true),
    () => timeoutMs,
    (ask) => asks.push(ask),
    (id, outcome) => resolved.push({ id, outcome }),
    (ask) => observed.push(ask)
  );
  await server.start();
  servers.push(server);
  const files = writeApprovalHookFiles({
    storageDir: scratch,
    nodePath: process.execPath,
    shellKind: 'posix',
    url: server.url,
    token: server.token,
    scriptTimeoutMs: 600000,
    hookTimeoutSec: 600,
    baseConfigPath,
  });
  const run = (payload, opts = {}) =>
    runHook(files.scriptPath, {
      url: opts.url ?? server.url,
      token: opts.token ?? server.token,
      timeoutMs: opts.timeoutMs ?? 30000,
      payload,
    });
  return { server, files, run, asks, resolved, observed };
}

/** 等第 n 条待确认出现（探针里一次只等一条）。 */
async function waitForAsk(h, seq = 1, ms = 8000) {
  const t0 = Date.now();
  while (h.asks.length < seq) {
    if (Date.now() - t0 > ms) throw new Error(`等不到第 ${seq} 条待确认（实到 ${h.asks.length} 条）`);
    await sleep(10);
  }
  return h.asks[seq - 1];
}

/** 把 hook 的 stdout 翻成决策。空输出 = 放行（不表态），这是 CC 方言的约定。 */
function verdict(res) {
  const text = res.stdout.trim();
  if (!text) return { decision: 'allow', reason: '' };
  const parsed = JSON.parse(text);
  const hs = parsed.hookSpecificOutput ?? {};
  return { decision: hs.permissionDecision, reason: hs.permissionDecisionReason ?? '', parsed };
}

// 探针现场用的两条命令：一条命中策略（要问），一条谁都不管
const DANGEROUS = 'rm -f -- ./destructive_test_workspace.txt';
const BENIGN = 'ls -la';
/** 真机 F5 用的那条策略：bash 且命令命中危险清单才问（C4 的 fs 那半另算） */
const bashPolicy = (ask) => ask.toolName === 'bash' && matchesAnyPattern(['\\brm\\b'], ask.command);

const bashPayload = (command, toolUseId = 'tu-1') => ({
  tool_name: 'bash',
  tool_input: { command },
  tool_use_id: toolUseId,
  cwd: 'D:/ws',
});

// ========== 一、回路本身：要问 → 用户拍板 → 脚本表态 ==========

await check('① 要问 + 点「允许」⇒ 脚本**一个字都不输出**、exit 0（这就是「命令照常执行」的机器证据）', async () => {
  const h = await harness({ shouldAsk: bashPolicy });
  const p = h.run(bashPayload(DANGEROUS));
  const ask = await waitForAsk(h);
  eq(ask.toolName, 'bash', '工具名传丢了');
  eq(ask.command, DANGEROUS, '命令原文被改动了 —— 用户在条上看到的必须是他要执行的那条');
  eq(ask.toolUseId, 'tu-1', 'toolUseId 没透传');
  ok(h.server.answer(ask.id, true), 'answer(允许) 返回了 false');
  const res = await p;
  eq(res.stdout, '', '放行必须**不表态**：多打一个换行都可能被 DSH 当成一条解析失败的 hook 输出');
  eq(res.code, 0, 'hook 退出码非 0');
  eq(h.resolved, [{ id: ask.id, outcome: 'allowed' }], 'onResolved 没报 allowed');
});

await check('② 要问 + 点「拒绝」⇒ 明确 deny + 我们的原因、exit 0（③ 的「拒绝 ⇒ 命令不执行」）', async () => {
  const h = await harness({ shouldAsk: bashPolicy });
  const p = h.run(bashPayload(DANGEROUS, 'tu-2'));
  const ask = await waitForAsk(h);
  ok(h.server.answer(ask.id, false), 'answer(拒绝) 返回了 false');
  const v = verdict(await p);
  eq(v.decision, 'deny', '拒绝没落到 permissionDecision 上 —— 命令会被放行');
  ok(v.reason.includes('拒绝') && v.reason.includes('未执行'), `拒绝原因不是用户能看懂的那句：${JSON.stringify(v.reason)}`);
  eq(v.parsed.hookSpecificOutput.hookEventName, 'PreToolUse', 'hookEventName 不是 PreToolUse');
  eq(h.resolved, [{ id: ask.id, outcome: 'rejected' }], 'onResolved 没报 rejected');
});

await check('③ 答过的 id 再答一次 ⇒ false（条被点两下不会写出两条转写、也不会二次放行）', async () => {
  const h = await harness({ shouldAsk: bashPolicy });
  const p = h.run(bashPayload(DANGEROUS, 'tu-3'));
  const ask = await waitForAsk(h);
  ok(h.server.answer(ask.id, false), '第一次答复就该成功');
  eq(h.server.answer(ask.id, true), false, '同一条审批被答复了两次');
  eq(h.server.answer('ap999', true), false, '不存在的 id 被答复成功了');
  eq(h.resolved.length, 1, 'onResolved 被重复调用');
  await p;
});

await check('④ 不需要问 ⇒ 服务端立即放行、脚本不表态、**条根本不弹**（asks 空）', async () => {
  const h = await harness({ shouldAsk: bashPolicy });
  const res = await h.run(bashPayload(BENIGN, 'tu-4'));
  eq(res.stdout, '', '无需审批的调用被表态了');
  eq(res.code, 0, 'hook 退出码非 0');
  eq(h.asks.length, 0, '不该问却弹了条');
  eq(h.resolved.length, 0, '没问过的事不该有结论');
});

await check('⑤ onObserved 每一次调用都先回调（C4 的轮前快照靠它），且拿不到 id（那时还没分配）', async () => {
  const h = await harness({ shouldAsk: () => false });
  await h.run(bashPayload(BENIGN, 'tu-5'));
  eq(h.observed.length, 1, '观察回调没被调用');
  eq(h.observed[0].toolUseId, 'tu-5', '观察到的不是这一次调用');
  eq(h.observed[0].id, '', '观察回调拿到的 id 该是空的（id 在 _askUser 里才定）');
});

// ========== 二、不可达时：bash fail-closed vs fs fail-open ==========

/** 指向一个必然拒绝连接的端口（同 probe-approval-shell 的做法）。 */
const DEAD = 'http://127.0.0.1:1';

await check('⑥ 服务不可达 + 内置危险清单命中的命令 ⇒ 拒绝，且原因说清是「不可达」不是「用户拒绝」', async () => {
  const h = await harness();
  for (const cmd of [
    'rm -rf /tmp/x',
    'mkfs.ext4 /dev/sda1',
    'dd if=/dev/zero of=/dev/sda',
    'shutdown -h now',
    'diskpart',
    'format C:',
    ':(){ :|:& };:',
  ]) {
    const v = verdict(await h.run(bashPayload(cmd), { url: DEAD }));
    eq(v.decision, 'deny', `${cmd} 在扩展挂掉时被放过了`);
    ok(v.reason.includes('不可达'), `${cmd} 的拒绝原因没提不可达：${JSON.stringify(v.reason)}`);
  }
});

await check('⑦ 服务不可达 + 普通命令 ⇒ 放行（扩展挂掉不等于所有 bash 都 sha 掉）', async () => {
  const h = await harness();
  for (const cmd of ['echo hello', 'git status', 'npm run compile']) {
    const res = await h.run(bashPayload(cmd), { url: DEAD });
    eq(verdict(res).decision, 'allow', `${cmd} 在扩展不可达时被拒了 —— 审批服务成了单点`);
    eq(res.code, 0, 'hook 退出码非 0');
  }
});

await check('⑧ 服务不可达 + write/edit ⇒ 一律放行（护栏坏了不该把 normal 写文件一起拖下水）', async () => {
  const h = await harness();
  for (const tool of ['write', 'edit']) {
    const res = await h.run(
      { tool_name: tool, tool_input: { file_path: 'D:/ws/a.txt' }, tool_use_id: 'tu-8', cwd: 'D:/ws' },
      { url: DEAD }
    );
    eq(verdict(res).decision, 'allow', `${tool} 在不可达时没放行`);
    eq(res.code, 0, 'hook 退出码非 0');
  }
});

await check('⑨ 令牌不对 ⇒ 403 ⇒ 走的是**兜底**那条路（不是「放行一切」，也不是「拒绝一切」）', async () => {
  const h = await harness({ shouldAsk: bashPolicy });
  const danger = verdict(await h.run(bashPayload('rm -rf /tmp/x'), { token: 'wrong-token' }));
  eq(danger.decision, 'deny', '令牌不对时危险命令被放过了');
  ok(danger.reason.includes('不可达'), '拿不到决策的原因没落到兜底话术上');
  const benign = await h.run(bashPayload(BENIGN), { token: 'wrong-token' });
  eq(verdict(benign).decision, 'allow', '令牌不对时普通命令也被拒了');
  eq(h.asks.length, 0, '令牌不对却弹了条 —— 令牌没起作用');
  eq(h.observed.length, 0, '令牌不对却进了业务逻辑');
});

// 这一条是本探针第一次跑就抓到的真问题（2026-09-18）：服务端 `answer()` 的原因串写死了「该命令」，
// 于是 hook 里那句按工具分开的「该写入」**在可答路径上从来没生效过** —— 而这条原因是要回给模型看的。
await check('⑩ 要问 + 拒绝 → write 工具的原因文案是「该写入」不是「该命令」', async () => {
  const h = await harness({ shouldAsk: (ask) => ask.toolName === 'write' });
  const p = h.run(
    { tool_name: 'write', tool_input: { file_path: 'D:/other/a.txt' }, tool_use_id: 'tu-10', cwd: 'D:/ws' },
    { timeoutMs: 60000 }
  );
  const ask = await waitForAsk(h);
  eq(ask.filePath, 'D:/other/a.txt', 'filePath 没透传');
  eq(ask.cwd, 'D:/ws', 'cwd 没透传 —— 判「越界」就没有基准了');
  eq(ask.command, '', 'fs 工具不该带命令正文');
  h.server.answer(ask.id, false);
  const v = verdict(await p);
  eq(v.decision, 'deny', 'fs 工具的拒绝没落到 deny 上');
  ok(v.reason.includes('该写入'), `fs 工具沿用了 bash 的话术：${JSON.stringify(v.reason)}`);
});

// ========== 三、超时与取消：一律按拒绝收尾 ==========

await check('⑪ 用户不拍板（超时）⇒ 拒绝 + onResolved 报 timeout（fail closed）', async () => {
  const h = await harness({ shouldAsk: () => true, timeoutMs: 150 });
  const v = verdict(await h.run(bashPayload(DANGEROUS, 'tu-11'), { timeoutMs: 60000 }));
  eq(v.decision, 'deny', '超时被放行了');
  ok(v.reason.includes('超时'), `超时的原因没说清：${JSON.stringify(v.reason)}`);
  eq(h.resolved.map((r) => r.outcome), ['timeout'], 'onResolved 没报 timeout');
});

await check('⑫ 本轮被停（cancelAll）⇒ 拒绝 + onResolved 报 cancelled（脚本侧按拒绝收尾）', async () => {
  const h = await harness({ shouldAsk: () => true });
  const p = h.run(bashPayload(DANGEROUS, 'tu-12'));
  await waitForAsk(h);
  h.server.cancelAll();
  const v = verdict(await p);
  eq(v.decision, 'deny', '取消后被放行了 —— 一条挂着的审批能穿过「停止」');
  ok(v.reason.includes('取消') || v.reason.includes('停止'), `取消的原因没说清：${JSON.stringify(v.reason)}`);
  eq(h.resolved.map((r) => r.outcome), ['cancelled'], 'onResolved 没报 cancelled');
  // 取消之后 answer 必须失效（条已经不在 UI 上了，再点不该有第二条结论）
  eq(h.server.answer('ap1', true), false, '取消过的审批还能被答复');
});

// ========== 四、不表态的那些输入（别把 read/glob 也拉进审批） ==========

await check('⑬ read/glob 这类工具：不表态、也不联系服务（matcher 之外的工具本就不该惊动审批）', async () => {
  const h = await harness({ shouldAsk: () => true });
  for (const tool of ['read', 'glob', 'grep', 'webfetch']) {
    const res = await h.run({ tool_name: tool, tool_input: { file_path: 'D:/ws/a.txt' }, cwd: 'D:/ws' });
    eq(res.stdout, '', `${tool} 被表态了`);
    eq(res.code, 0, 'hook 退出码非 0');
  }
  eq(h.observed.length, 0, '不该管的工具也去问了服务');
});

await check('⑭ 载荷缺关键字段（bash 没 command / write 没 file_path）⇒ 不表态、也不联系服务', async () => {
  const h = await harness({ shouldAsk: () => true });
  eq((await h.run({ tool_name: 'bash', tool_input: {}, tool_use_id: 'tu-14' })).stdout, '', '空命令被表态了');
  eq((await h.run({ tool_name: 'write', tool_input: {}, tool_use_id: 'tu-14' })).stdout, '', '空路径被表态了');
  eq(h.observed.length, 0, '字段缺失时仍去问了服务');
});

await check('⑮ stdin 不是合法 JSON ⇒ 拒绝并说清原因（宁可拒绝，不许"解析不了就当没事"）', async () => {
  const h = await harness({ shouldAsk: () => true });
  const v = verdict(await h.run('{ 这不是 JSON'));
  eq(v.decision, 'deny', '坏输入被放行了');
  ok(v.reason.includes('解析'), `坏输入的原因没说清：${JSON.stringify(v.reason)}`);
  eq(h.observed.length, 0, '坏输入不该进业务逻辑');
});

// ========== 五、静态守卫：这条回路的两端别被改窄 ==========

await check('⑯ hooks.json 的 matcher 与超时：matcher 缩了，某些工具就再也进不了审批', () => {
  const files = writeApprovalHookFiles({
    storageDir: scratch,
    nodePath: process.execPath,
    shellKind: 'posix',
    url: 'http://127.0.0.1:1',
    token: 'probe-token-not-a-secret',
    scriptTimeoutMs: 600000,
    hookTimeoutSec: 600,
    baseConfigPath,
  });
  const cfg = JSON.parse(readFileSync(files.hooksPath, 'utf8'));
  const groups = cfg.hooks?.PreToolUse;
  eq(groups?.length, 1, 'PreToolUse 不是恰好一组');
  eq(groups[0].matcher, 'bash|write|edit', 'matcher 被改窄了 —— C1/C4 覆盖的工具面跟着缩小');
  eq(groups[0].hooks?.length, 1, 'hook 条数不是 1');
  // 超时梯度：600（DSH 杀进程）> 560（脚本 socket）> 540（用户等待），保证先放弃的永远是扩展
  eq(groups[0].hooks[0].timeout, 600, 'DSH 侧超时不是 600 秒');
  ok(groups[0].hooks[0].type === 'command', 'hook 类型不是 command');
  const cmd = unquoteCommand(groups[0].hooks[0].command);
  for (const piece of ['--url', '--token', '--timeout-ms', files.scriptPath, 'http://127.0.0.1:1']) {
    ok(cmd.includes(piece), `命令串（复原转义后）里没有 ${piece}`);
  }
  // 令牌走参数不走 env（hook 的 env 会被 DSH 擦洗），所以它必须在命令串里、且不是空的
  ok(/--token\s+\S/.test(cmd), '命令串里没有令牌的值');
});

await check('⑰ approvalServer.ts 不带 vscode（带了这条回路就只能在扩展宿主里验）', () => {
  const src = readFileSync(join(repoRoot, 'src', 'approvalServer.ts'), 'utf8');
  ok(!/from 'vscode'|require\('vscode'\)/.test(src), 'approvalServer.ts import vscode 了 —— 回路又变回「只有肉眼能验」');
});

await check('⑱ 生成的 hook 脚本自身不执行任何东西（只问不跑：探针里那些 rm -rf 永远只是字符串）', () => {
  const script = readFileSync(join(scratch, 'dsh-hooks', 'approval-hook.mjs'), 'utf8');
  ok(!/\b(spawn|execSync|execFileSync|fork)\s*\(/.test(script), `hook 脚本里出现了进程调用：${RegExp.lastMatch}`);
});

// ========== 六、C16：白名单命中时，回路一个字节都不用改 ==========
//
// C16 的成败点全在**接在哪一处**：`_askNeedsApproval` 返回 false 时服务端直接放行、
// 根本不调 `_onAsk`（`approvalServer.ts`），所以 hook 脚本、hooks.json、派生配置、令牌
// 全都不用动 —— 下面 ⑲ 用**真的白名单文件 + 真的 hook 子进程**把这句话走一遍，
// 而不是靠读源码相信它。㉑-㉔ 则把「判定只有一处」「坏掉只许变成多问」这两条钉在源码上。

const { addTrust, matchTrust, readTrustFile, writeTrustFile } = await load('approvalTrust.js');

/**
 * 把 C16 接进这条回路：**白名单先说话**（命中 ⇒ 不弹条），不命中照旧走 C1 的 bash 策略。
 * 与 `_askNeedsApproval` 的前三句逐字对应（`chatViewProvider.ts:2627-2631`）；C4 的区外写那半
 * 不在本探针的范围内（⑩ 管的是它的理由文案）。
 */
function wiredPolicy(trustFile) {
  return (ask) => {
    const hit = matchTrust(readTrustFile(trustFile).entries, {
      toolName: ask.toolName,
      command: ask.command,
      cwd: ask.cwd,
      targetAbs: ask.filePath,
    });
    if (hit) return false;
    return bashPolicy(ask);
  };
}

await check('⑲ C16：白名单命中 ⇒ 条根本不弹、脚本一个字不表态（同一条命令第二次真的不再问）', async () => {
  const file = join(scratch, 'c16-trust.json');
  const h = await harness({ shouldAsk: wiredPolicy(file) });
  const first = h.run(bashPayload(DANGEROUS, 'tu-19'));
  const ask = await waitForAsk(h);
  eq(ask.cwd, 'D:/ws', 'cwd 没透传 —— 键的另一半就没了，记下的信任会绑到空工作区上');
  // 模拟用户在条上点了「永久信任此命令」
  const added = addTrust(readTrustFile(file).entries, { toolName: 'bash', command: ask.command, cwd: ask.cwd }, 'command', Date.now());
  ok(added.ok, `记不下这条信任：${added.ok ? '' : added.reason}`);
  writeTrustFile(file, added.entries);
  h.server.answer(ask.id, true);
  await first;

  const again = await h.run(bashPayload(DANGEROUS, 'tu-19b'));
  eq(again.stdout, '', '被信任的命令被表态了 —— 放行必须一个字都不输出');
  eq(again.code, 0, 'hook 退出码非 0');
  eq(h.asks.length, 1, `同一条命令第二次又弹了条（asks=${h.asks.length}）—— 记了等于没记`);
  // F2：被白名单**静默放行**的那次照样进 onObserved ⇒ C4 的轮前快照没漏（放行不等于隐身）
  eq(h.observed.length, 2, '白名单放行的那次没进 onObserved —— 区外写的可见性会跟着丢');
});

/**
 * 表里放一条信任（`seed`），然后在 `run` 的条件下跑一次，返回**弹没弹条**。
 * 种子与实跑分开写是必须的：「同一条命令换一个工作区」那一条只有让两边的 cwd 不同才验得出来
 * （第一版把两者写成同一个参数，于是它测的是「同一个工作区命中」—— 永远绿，什么都没验）。
 *
 * 两种结果都要能测出来：命中时不弹（正控，否则下面三条绿的全不作数）、不命中时必弹。
 */
async function askedWithSeed(seed, run, tag) {
  const file = join(scratch, `c16-trust-${tag}.json`);
  const h = await harness({ shouldAsk: wiredPolicy(file) });
  const added = addTrust([], { toolName: 'bash', command: seed.command, cwd: seed.cwd }, 'command', Date.now());
  ok(added.ok, '表里的种子信任没建起来 —— 这次断言会变成空转');
  writeTrustFile(file, added.entries);
  const p = h.run({ tool_name: 'bash', tool_input: { command: run.command }, tool_use_id: `tu-${tag}`, cwd: run.cwd });
  // 「弹没弹」用**两个真实结局**赛跑，不用定时器：要问 ⇒ hook 会一直挂着等答复（waitForAsk 赢）；
  // 不问 ⇒ 服务端当场放行、hook 自己退出（进程结束赢）。写成「等 900ms 看有没有」会随机器负载
  // 假红（变异测试那一轮就撞上过：编译在跑，900ms 内连 spawn 都没起来）。
  const asked = await Promise.race([
    // 第二个回调是必须的：两个分支都会留下一个悬着的 waitForAsk，没人接它的拒绝就是
    // 一个 unhandled rejection，整个探针会当场死掉。
    waitForAsk(h, 1, 8000).then(() => true, () => false),
    p.then(() => false, () => false),
  ]);
  if (asked) h.server.answer(h.asks[0].id, true); // 别让 hook 挂在那儿等
  await p;
  return asked;
}

await check('⑳ C16：白名单只认那一条 —— 逐字精确、cwd 是键的一半、表非空绝不等于全放行', async () => {
  const OTHER = 'rm -f -- ./另一个文件.txt';
  const ws = { command: DANGEROUS, cwd: 'D:/ws' };
  eq(
    await askedWithSeed(ws, ws, 'hit'),
    false,
    '正控：亲手信任过的那条命令居然还弹条 —— 这条要是红的，下面三条绿的都不作数'
  );
  eq(
    await askedWithSeed({ command: OTHER, cwd: 'D:/ws' }, ws, 'other'),
    true,
    '表里有一条别的信任就把这条放过了 —— 那等于「表非空即全放行」'
  );
  eq(
    await askedWithSeed(ws, { command: DANGEROUS, cwd: 'D:/other' }, 'cwd'),
    true,
    '同一条命令换到另一个工作区不再问了 —— cwd 没被当成键的一半'
  );
  eq(
    await askedWithSeed(ws, { command: 'rm -f --  ./destructive_test_workspace.txt', cwd: 'D:/ws' }, 'space'),
    true,
    '多一个空格被当成了同一条命令 —— 逐字精确退化成了折叠空白'
  );
});

await check('㉑ C16：白名单接在 `_askNeedsApproval` 的第一句 —— 接在别处就是「先弹条，事后才想起信任过」', () => {
  const lines = readFileSync(join(repoRoot, 'src', 'chatViewProvider.ts'), 'utf8').split(/\r?\n/);
  const def = lines.findIndex((l) => l.includes('private _askNeedsApproval('));
  ok(def >= 0, '找不到 _askNeedsApproval 的定义');
  const head = lines.slice(def, def + 3).join('\n');
  ok(/if \(this\._isTrusted\(ask\)\) return false;/.test(head), `_askNeedsApproval 的开头不是白名单：\n${head}`);
});

await check('㉒ C16：判定只有一处 —— 命中走 matchTrust、能不能给走 offerTrust、包含判定走 isInsideDir', () => {
  const src = readFileSync(join(repoRoot, 'src', 'chatViewProvider.ts'), 'utf8').replace(/\r\n/g, '\n');
  const bodyOf = (sig) => {
    const at = src.indexOf(sig);
    ok(at > 0, `找不到 ${sig}`);
    const open = src.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
    }
    return '';
  };
  const trusted = bodyOf('private _isTrusted(');
  ok(/matchTrust\(/.test(trusted), '_isTrusted 没走 matchTrust —— 判据在第二处长了一份');
  ok(!/includes\(|startsWith\(/.test(trusted), '_isTrusted 里自己写起了匹配 —— 逐字精确只准有一处实现');
  ok(/offerTrust\(/.test(bodyOf('private _offerTrust(')), '_offerTrust 没走 offerTrust —— 「能不能给」会在两处各判一次');
  const inside = bodyOf('private _isInside(');
  ok(/isInsideDir\(/.test(inside), '_isInside 没委派给 changeForecast.isInsideDir —— 包含判定有了第二份实现');
  ok(!/startsWith\(/.test(inside), '_isInside 里写了 startsWith —— D:\\proj2 会被 D:\\proj 骗过');
});

await check('㉓ C16：白名单坏掉时降级方向只能是「多问」—— 纯模块不带 vscode，判定失败一律 false', () => {
  const pure = readFileSync(join(repoRoot, 'src', 'approvalTrust.ts'), 'utf8');
  ok(!/from 'vscode'|require\('vscode'\)/.test(pure), 'approvalTrust.ts import vscode 了 —— 判据又变回「只有肉眼能验」（C10b 的教训）');
  const src = readFileSync(join(repoRoot, 'src', 'chatViewProvider.ts'), 'utf8').replace(/\r\n/g, '\n');
  const at = src.indexOf('private _isTrusted(');
  const body = src.slice(at, src.indexOf('\n  }', at));
  ok(/return false;/.test(body), '_isTrusted 的失败路径没有 return false —— 读盘出错会变成「全放行」');
  ok(!/return true;/.test(body), '_isTrusted 里出现了 return true —— 有分支会把没命中的情况放行');
});

await check('㉔ C16：记不记得住不改变这次允许 —— 先回话、再记盘，且记盘失败只写留痕', () => {
  const src = readFileSync(join(repoRoot, 'src', 'chatViewProvider.ts'), 'utf8').replace(/\r\n/g, '\n');
  const at = src.indexOf('private _answerApproval(');
  ok(at > 0, '找不到 _answerApproval 的定义');
  const body = src.slice(at, src.indexOf('\n  }', at));
  const trustAt = body.indexOf('_createTrust(');
  const answerAt = body.indexOf('this._approval?.answer(');
  ok(trustAt > 0, '_answerApproval 里没有 _createTrust —— 点「永久信任」什么都不会被记下');
  ok(answerAt > 0, '_answerApproval 里没有回话 —— 条点了不会收');
  ok(trustAt < answerAt, '_answerApproval 先记盘再回话 —— 写盘慢/失败会把用户已经点下的放行卡在后面');
  // _createTrust 只到它自己的右花括号（按到下一个方法名切会把 _answerApproval 一起吞进来，
  // 那一版的 "allow" 是隔壁方法的，判据会永远假红）
  const createAt = src.indexOf('private _createTrust(');
  ok(createAt > 0, '找不到 _createTrust 的定义');
  const create = src.slice(createAt, src.indexOf('\n  }', createAt));
  ok(!/allow/.test(create), '_createTrust 里出现了 allow —— 记信任这件事不许反过来改这次放不放行');
});

// ---------- 收尾 ----------

console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 条未过（共 ${passed + failures.length} 条）：`);
  for (const f of failures) console.log(`   · ${f}`);
} else {
  // ⚠️ 这行必须在 else 里：C10 有两条探针曾无条件打印它，「有红 + ✓ 全部通过」同屏出现过。
  console.log(`✓ 全部通过：${passed}/${passed}`);
}
for (const s of servers) s.dispose();
rmSync(scratch, { recursive: true, force: true });
// ⚠️ 不用 process.exit()：Windows 上被重定向的 stdout 是异步写，退出会丢掉还没冲出去的结论行。
process.exitCode = failures.length ? 1 : 0;
