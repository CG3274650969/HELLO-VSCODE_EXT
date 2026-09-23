#!/usr/bin/env node
/**
 * C16「审批白名单记忆」的判据自检 —— **不需要 VS Code、不需要 API key、不弹任何条**。
 *
 * 守的是 [src/approvalTrust.ts] 这一份纯判据。为什么它值得单独钉：白名单是**唯一一处
 * 「静默放行」的通路** —— 它一旦判宽了，症状是「某条命令再也没被拦过」，而那种事**没有现场**，
 * 事后翻日志也看不出来。所以每一条放宽的可能性都在这里有一条反控：
 *
 * - 逐字精确：多一个空格 / 多一个字符 / 大小写不同 / 前缀包含 / 另一个 cwd，**全都不许命中**；
 * - 目录档：`D:\out2` 不许被 `D:\out` 覆盖（`startsWith` 那个坑）；
 * - 坏文件：任何形态的坏内容都只能降级成「空表 ⇒ 照常弹条」，**永远不许降级成「全放行」**。
 *
 * ⚠️ 判据按 **win32 路径语义**写死（`D:\…`、盘根、大小写归一）—— 本扩展只发 Windows 制品，
 *   在别的平台上这些用例没有意义，所以开头就直接拦掉，而不是给出一堆假红。
 *
 *   npm run compile && ./dist-runtime/node/node.exe scripts/probe-approval-trust.mjs
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(repoRoot, 'out');

if (process.platform !== 'win32') {
  console.error(`本探针的判据是 win32 路径语义（D:\\…、盘根、大小写归一），当前平台 ${process.platform} 上无意义。`);
  process.exit(2);
}

async function load(moduleName) {
  const file = join(outDir, moduleName);
  if (!existsSync(file)) {
    console.error(`缺少编译产物：${file}\n  先跑 npm run compile（out/ 是 gitignored 的）。`);
    process.exit(2);
  }
  return import(pathToFileURL(file).href);
}

const T = await load('approvalTrust.js');
const {
  MAX_TRUST_ENTRIES,
  TRUST_FILE_NAME,
  addTrust,
  describeTrust,
  identityOf,
  isForbiddenTrustDir,
  matchTrust,
  offerTrust,
  parseTrustFile,
  readTrustFile,
  removeTrust,
  writeTrustFile,
} = T;

// ---------- 断言小工具 ----------

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const r = fn();
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

// ---------- 现场 ----------

const CWD_A = 'D:\\proj-a';
const CWD_B = 'D:\\proj-b';
const CMD = 'rm -rf ./dist';
const HOME = process.env.USERPROFILE || '';

/** bash 档的一条信任（手写形状，正是文件里会出现的那个形状） */
const cmdEntry = (command = CMD, cwd = CWD_A) => ({ kind: 'command', command, cwd, createdAt: 1 });
const dirEntry = (dir) => ({ kind: 'dir', dir, createdAt: 1 });

const bashAsk = (command = CMD, cwd = CWD_A) => ({ toolName: 'bash', command, cwd });
const writeAsk = (targetAbs) => ({ toolName: 'write', targetAbs });

const scratch = mkdtempSync(join(tmpdir(), 'hello-trust-'));
const trustFile = join(scratch, TRUST_FILE_NAME);

console.log('C16 审批白名单记忆 · 判据自检\n');

// ---------- A · bash 档：逐字精确 + 所在目录 ----------

check('A1 同命令同 cwd ⇒ 命中', () => {
  ok(matchTrust([cmdEntry()], bashAsk()) !== undefined, '没命中');
});

check('A2 反控：同命令**另一个 cwd** ⇒ 不命中（cwd 是键的一半）', () => {
  eq(matchTrust([cmdEntry()], bashAsk(CMD, CWD_B)), undefined, '换工作区居然命中了');
});

check('A3 反控：多一个字符（`./dist/`）⇒ 不命中', () => {
  eq(matchTrust([cmdEntry()], bashAsk('rm -rf ./dist/')), undefined, '近似命令被放行了');
});

check('A4 反控：多一个空格 ⇒ 不命中（绝不折叠空白）', () => {
  eq(matchTrust([cmdEntry()], bashAsk('rm  -rf ./dist')), undefined, '折叠了空白');
});

check('A5 反控：大小写不同 ⇒ 不命中', () => {
  eq(matchTrust([cmdEntry()], bashAsk('RM -rf ./dist')), undefined, '归一了大小写');
});

check('A6 反控：**前缀包含**（`rm -rf ./dist && echo hi`）⇒ 不命中', () => {
  eq(matchTrust([cmdEntry()], bashAsk('rm -rf ./dist && echo hi')), undefined, '前缀/包含匹配放行了追加命令');
});

check('A7 条目 cwd 为空 ⟷ 查询 cwd 缺失：同一个键（互相命中）', () => {
  // 文件里两种写法都表示「无工作区」：字段缺失，或空串
  ok(matchTrust([cmdEntry(CMD, '')], { toolName: 'bash', command: CMD }) !== undefined, '空串档没命中缺 cwd 的查询');
  ok(matchTrust([{ kind: 'command', command: CMD, createdAt: 1 }], bashAsk(CMD, '')) !== undefined, '缺字段档没命中空 cwd 的查询');
});

check('A8 反控：条目绑了 cwd、查询没有 cwd ⇒ 不命中（不许退化成通配）', () => {
  eq(matchTrust([cmdEntry()], { toolName: 'bash', command: CMD }), undefined, '绑了工作区的条目放行了无工作区的调用');
});

check('A9 反控：command 档对 write/edit 的询问不参与', () => {
  eq(matchTrust([cmdEntry('x')], writeAsk('D:\\out\\a.txt')), undefined, '命令档管到了写文件');
});

// ---------- B · 目录档 ----------

check('B1 目录的深子目录 ⇒ 命中', () => {
  ok(matchTrust([dirEntry('D:\\out')], writeAsk('D:\\out\\a\\b\\x.txt')) !== undefined, '子目录没命中');
});

check('B2 目录自身 ⇒ 命中（含 root 自身）', () => {
  ok(matchTrust([dirEntry('D:\\out')], writeAsk('D:\\out')) !== undefined, '目录自身没命中');
});

check('B3 反控：兄弟目录 `D:\\out2` ⇒ 不命中（startsWith 那个坑）', () => {
  eq(matchTrust([dirEntry('D:\\out')], writeAsk('D:\\out2\\x.txt')), undefined, '前缀相同的兄弟目录被误判成在内部');
});

check('B4 反控：父目录里的文件 ⇒ 不命中', () => {
  eq(matchTrust([dirEntry('D:\\out')], writeAsk('D:\\other.txt')), undefined, '目录之外的写被放行');
});

check('B5 反控：dir 档对 bash 的询问不参与', () => {
  eq(matchTrust([dirEntry('D:\\out')], bashAsk()), undefined, '目录档管到了 bash 命令');
});

check('B6 反控：拿不到目标绝对路径 ⇒ 不命中', () => {
  eq(matchTrust([dirEntry('D:\\out')], { toolName: 'write' }), undefined, '没有目标路径也放行了');
});

check('B7 win32 大小写归一：`D:\\OUT\\a.txt` ⟷ `D:\\out` ⇒ 命中', () => {
  ok(matchTrust([dirEntry('D:\\out')], writeAsk('D:\\OUT\\a.txt')) !== undefined, '同一目录的另一种大小写没命中');
});

// ---------- C · 可提供性（拦停条上到底画不画那个按钮） ----------

check('C1 bash ⇒ 可提供 command 档，文案含 cwd 原文', () => {
  const o = offerTrust(bashAsk());
  ok(o && o.kind === 'command', '没提供 command 档');
  eq(o.label, '永久信任此命令', '按钮文字不对');
  ok(o.scope.includes(CWD_A), `说明行没说清在哪个工作区：${o.scope}`);
});

check('C2 write + 可解析目标 ⇒ 可提供 dir 档，文案含目录原文', () => {
  const o = offerTrust(writeAsk('D:\\out\\a\\b.txt'));
  ok(o && o.kind === 'dir', '没提供 dir 档');
  eq(o.label, '永久信任此目录', '按钮文字不对');
  ok(o.scope.includes('D:\\out'), `说明行没写清是哪个目录：${o.scope}`);
  ok(!o.scope.includes('b.txt'), '说明行把文件写进去了（应该只到目录）');
});

check('C3 反控：write 但目标路径不可解析（POSIX 形态）⇒ 不提供', () => {
  eq(offerTrust({ toolName: 'write' }), undefined, '拿不到路径也给了按钮');
});

check('C4 反控：命令触顶（可能被截断）⇒ 不提供，且任何条目都不命中', () => {
  const huge = 'x'.repeat(32 * 1024);
  eq(offerTrust(bashAsk(huge)), undefined, '超长命令仍给了按钮');
  eq(matchTrust([cmdEntry(huge)], bashAsk(huge)), undefined, '超长命令靠逐字比对命中了（截断线两侧不可分辨）');
});

check('C5 反控：目标是盘根下的文件（目录 = 盘根）⇒ 不提供', () => {
  eq(offerTrust(writeAsk('D:\\a.txt')), undefined, '把整个盘交出去了');
});

check('C6 反控：目标在主目录里（目录 = 家目录）⇒ 不提供', () => {
  if (!HOME) throw new Error('拿不到 USERPROFILE，这条测不了');
  eq(offerTrust(writeAsk(join(HOME, 'x.txt'))), undefined, '把家目录交出去了');
});

check('C7 反控：read/glob 这类工具 ⇒ 一概不提供', () => {
  eq(offerTrust({ toolName: 'read', targetAbs: 'D:\\out\\a.txt' }), undefined, '读工具也给了信任按钮');
  eq(offerTrust({ toolName: 'glob', command: CMD, cwd: CWD_A }), undefined, '未知工具也给了信任按钮');
});

// ---------- D · 增 / 删 / 去重 / 上限 ----------

check('D1 加一条 ⇒ 文件里会出现的形状就是那几样', () => {
  const r = addTrust([], bashAsk(), 'command', 1758500000000);
  ok(r.ok, '加失败了');
  eq(r.entries, [{ kind: 'command', command: CMD, cwd: CWD_A, createdAt: 1758500000000 }], '条目形状变了');
});

check('D2 同一条加两次 ⇒ 幂等（表长仍 1）', () => {
  const r1 = addTrust([], bashAsk(), 'command', 1);
  const r2 = addTrust(r1.entries, bashAsk(), 'command', 2);
  ok(r2.ok, '第二次加失败了');
  eq(r2.entries.length, 1, '重复条目进了表');
  eq(r2.entry.createdAt, 1, '重复加把时间戳改了');
});

check('D3 **绝不改原对象**：加完之后原数组一字未变', () => {
  const before = [cmdEntry()];
  const snapshot = JSON.stringify(before);
  addTrust(before, bashAsk('git reset --hard'), 'command', 5);
  eq(JSON.stringify(before), snapshot, '原数组被就地改了');
});

check('D4 反控：对 bash 的询问伪造 `dir` 粒度 ⇒ 拒绝，表不变', () => {
  const r = addTrust([], bashAsk(), 'dir', 1);
  eq(r.ok, false, '伪造成 dir 竟然成功了');
  ok(String(r.reason).includes('粒度'), `拒绝理由没说清：${r.reason}`);
});

check('D5 反控：对 write 的询问伪造 `command` 粒度 ⇒ 拒绝', () => {
  eq(addTrust([], writeAsk('D:\\out\\a.txt'), 'command', 1).ok, false, '伪造成 command 竟然成功了');
});

check('D6 上限：满了以后**拒绝**（不淘汰最旧的）', () => {
  const full = [];
  for (let i = 0; i < MAX_TRUST_ENTRIES; i++) full.push({ kind: 'dir', dir: `D:\\d${i}`, createdAt: 1 });
  eq(full.length, MAX_TRUST_ENTRIES, '前置构造就不对');
  const r = addTrust(full, writeAsk('D:\\d0\\x.txt'), 'dir', 1);
  eq(r.ok, false, '满了还加进去了');
  ok(String(r.reason).includes(String(MAX_TRUST_ENTRIES)), `拒绝理由里没有条数：${r.reason}`);
  eq(matchTrust(full, writeAsk('D:\\d199\\x.txt')) !== undefined, true, '满表下原有的条目也不命中了（不该）');
});

check('D7 三种拒绝理由两两不同（不许都退化成一句话）', () => {
  const a = addTrust([], bashAsk('x'.repeat(32 * 1024)), 'command', 1).reason;
  const b = addTrust([], bashAsk(), 'dir', 1).reason;
  const full = [];
  for (let i = 0; i < MAX_TRUST_ENTRIES; i++) full.push({ kind: 'dir', dir: `D:\\e${i}`, createdAt: 1 });
  const c = addTrust(full, writeAsk('D:\\e0\\x.txt'), 'dir', 1).reason;
  ok(a && b && c, '有理由为空');
  ok(a !== b && b !== c && a !== c, `三句里有重复：${a} / ${b} / ${c}`);
});

check('D8 removeTrust 按身份删：去掉那一条，别的都还在', () => {
  const list = [cmdEntry(), dirEntry('D:\\out'), cmdEntry('git reset --hard', CWD_B)];
  const out = removeTrust(list, { kind: 'dir', dir: 'D:\\out' });
  eq(out.length, 2, '删多了或没删掉');
  eq(out.map((e) => e.kind), ['command', 'command'], '删错了条目');
});

check('D9 delete 不存在的一条 ⇒ 不动的副本', () => {
  const list = [cmdEntry()];
  eq(removeTrust(list, { kind: 'dir', dir: 'D:\\nope' }), list, '结果与输入不等');
});

check('D10 identityOf：档位不同 / cwd 不同 ⇒ 身份不同；同键 ⇒ 相同', () => {
  const a = identityOf({ kind: 'command', command: 'x', cwd: 'D:\\p' });
  const b = identityOf({ kind: 'command', command: 'x', cwd: 'D:\\q' });
  const c = identityOf({ kind: 'dir', dir: 'x' });
  const d = identityOf({ kind: 'command', command: 'x', cwd: 'D:\\p' });
  ok(a !== b && a !== c && c !== b, '身份撞了');
  eq(a, d, '同一条的身份不一致');
});

// ---------- E · 坏文件的降级方向（一律只能「多问」） ----------

check('E1 空串 ⇒ 空表', () => eq(parseTrustFile(''), []));
check('E2 不是 JSON ⇒ 空表', () => eq(parseTrustFile('这不是 JSON'), []));

check('E3 形状不对 ⇒ 空表（不是数组的一律不认）', () => {
  eq(parseTrustFile('{}'), []);
  eq(parseTrustFile('null'), []);
  eq(parseTrustFile('3'), []);
  eq(parseTrustFile('"x"'), []);
  eq(parseTrustFile('{"entries":[]}'), []);
});

check('E4 ⚠️ 缺 command 的条目必须丢掉（否则就是「什么都匹配」的后门）', () => {
  eq(parseTrustFile('[{"kind":"bash"}]'), []);
  eq(parseTrustFile('[{"kind":"command"}]'), []);
  eq(parseTrustFile('[{"kind":"command","command":""}]'), []);
  eq(parseTrustFile('[{"kind":"command","command":123}]'), []);
  eq(parseTrustFile('[{"kind":"dir"}]'), []);
  eq(parseTrustFile('[{"kind":"dir","dir":""}]'), []);
});

check('E5 合法但只带一半的条目保留（command 无 cwd = 「无工作区」档）', () => {
  eq(parseTrustFile('[{"kind":"command","command":"rm -rf /"}]'), [
    { kind: 'command', command: 'rm -rf /', createdAt: 0 },
  ]);
});

check('E6 反控：cwd 给了非字符串 ⇒ 整条丢掉（想绑工作区却成了空键 = 放宽）', () => {
  eq(parseTrustFile('[{"kind":"command","command":"x","cwd":123}]'), []);
});

check('E7 反控：目录不是绝对路径 ⇒ 丢掉', () => {
  eq(parseTrustFile('[{"kind":"dir","dir":"out"}]'), []);
  eq(parseTrustFile('[{"kind":"dir","dir":"./out"}]'), []);
});

check('E8 反控：盘根 ⇒ 丢掉', () => {
  eq(parseTrustFile('[{"kind":"dir","dir":"D:\\\\"}]'), []);
});

check('E9 反控：家目录 ⇒ 丢掉', () => {
  if (!HOME) throw new Error('拿不到 USERPROFILE，这条测不了');
  eq(parseTrustFile(JSON.stringify([{ kind: 'dir', dir: HOME }])), []);
});

check('E10 重复条目 ⇒ 去重', () => {
  const text = JSON.stringify([cmdEntry(), cmdEntry()]);
  eq(parseTrustFile(text).length, 1, '重复条目没去重');
});

check('E11 好坏混在一起 ⇒ **只丢坏的那一条**，好的还在', () => {
  const text = JSON.stringify([{ kind: 'bash' }, cmdEntry(), { kind: 'dir', dir: 'D:\\' }]);
  eq(parseTrustFile(text), [{ kind: 'command', command: CMD, cwd: CWD_A, createdAt: 1 }], '丢多了或丢少了');
});

check('E12 超过上限 ⇒ 截到上限（不抛）', () => {
  const many = [];
  for (let i = 0; i < MAX_TRUST_ENTRIES + 20; i++) many.push({ kind: 'dir', dir: `D:\\m${i}`, createdAt: 1 });
  eq(parseTrustFile(JSON.stringify(many)).length, MAX_TRUST_ENTRIES, '没截到上限');
});

check('E13 createdAt 缺失 / 非法 ⇒ 0，条目本身保留（时间不参与判定）', () => {
  eq(parseTrustFile('[{"kind":"command","command":"x"}]')[0].createdAt, 0);
  eq(parseTrustFile('[{"kind":"command","command":"x","createdAt":"昨天"}]')[0].createdAt, 0);
  eq(parseTrustFile('[{"kind":"command","command":"x","createdAt":-5}]')[0].createdAt, 0);
  eq(parseTrustFile('[{"kind":"command","command":"x","createdAt":-5}]')[0].command, 'x');
});

// ---------- F · 读盘 / 写盘 ----------

check('F1 写→读往返相等（读回来的形状与写出去的逐字一致）', () => {
  const list = [cmdEntry(), dirEntry('D:\\out')];
  writeTrustFile(trustFile, list);
  const read = readTrustFile(trustFile);
  eq(read.entries, list, '往返不等');
  eq(read.corrupt, false, '刚写出来的文件被当成坏文件了 —— 那个提示会在正常的白名单上瞎报');
});

check('F2 写盘前会先净化：塞进去的非法条目**写不进文件**', () => {
  writeTrustFile(trustFile, [cmdEntry(), { kind: 'dir', dir: 'D:\\' }, { kind: 'bash' }]);
  eq(readTrustFile(trustFile).entries, [cmdEntry()], '非法条目落盘了');
});

check('F3 文件不存在 ⇒ 空表（不抛），且**不算坏文件**（没给过信任是最常见的情形）', () => {
  const read = readTrustFile(join(scratch, '没有这个文件.json'));
  eq(read.entries, [], '');
  eq(read.corrupt, false, '文件不存在被当成了「坏文件」—— 每次启动都会弹一次没用的告警');
});

check('F4 文件内容是垃圾 ⇒ 空表（不抛），并标成坏文件（只为了提示，判定早就退回「每次都问」）', () => {
  const bad = join(scratch, 'garbage.json');
  writeFileSync(bad, '{ 半截 JSON', 'utf8');
  const read = readTrustFile(bad);
  eq(read.entries, [], '');
  eq(read.corrupt, true, '解不出来的文件没被标出来 —— 用户手改坏了不会收到任何提示，只是「怎么又开始问了」');
});

check('F4b 合法但全被丢掉的条目 ⇒ 同样算坏文件（`{"kind":"bash"}` 那种后门正是这么进来的）', () => {
  const bad = join(scratch, 'all-dropped.json');
  writeFileSync(bad, '[{"kind":"bash"},{"kind":"dir","dir":"out"}]', 'utf8');
  const read = readTrustFile(bad);
  eq(read.entries, [], '相对目录/缺 command 的条目被收进来了');
  eq(read.corrupt, true, '整份都被丢光了却没标出来');
});

check('F5 写盘是 tmp+rename：写完不留 .tmp 残渣，且文件本身可读', () => {
  writeTrustFile(trustFile, [cmdEntry()]);
  const leftovers = readdirSync(scratch).filter((n) => n.endsWith('.tmp'));
  eq(leftovers, [], '留下了临时文件');
  const text = readFileSync(trustFile, 'utf8');
  eq(text.endsWith('\n'), true, '文件末尾没有换行（手改时不好看）');
});

check('F6 父目录不存在 ⇒ **抛**（调用方必须自己接住，绝不静默成功）', () => {
  let threw = false;
  try {
    writeTrustFile(join(scratch, '没有这个目录', TRUST_FILE_NAME), [cmdEntry()]);
  } catch {
    threw = true;
  }
  eq(threw, true, '写不进盘却当成成功了');
});

check('G1 展示文案把键本身写出来（用户认得出撤销的是哪一条）', () => {
  const a = describeTrust(cmdEntry());
  const b = describeTrust(dirEntry('D:\\out'));
  ok(a.includes(CMD) && a.includes(CWD_A), `命令档文案丢了关键信息：${a}`);
  ok(b.includes('D:\\out'), `目录档文案丢了路径：${b}`);
  ok(a !== b, '两种档位文案一样');
});

check('G2 isForbiddenTrustDir：盘根 / 家目录的父目录 都算禁', () => {
  eq(isForbiddenTrustDir('D:\\'), true, '盘根没被禁');
  eq(isForbiddenTrustDir(''), true, '空目录没被禁');
  eq(isForbiddenTrustDir('D:\\proj'), false, '普通目录被误禁');
  if (HOME) {
    eq(isForbiddenTrustDir(HOME), true, '家目录没被禁');
    eq(isForbiddenTrustDir(dirname(HOME)), true, '家目录的父目录没被禁（那等于交出了整个用户目录）');
  }
});

// ---------- 收尾 ----------

try {
  rmSync(scratch, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}

if (failures.length) {
  console.log(`\n✗ ${failures.length} 条没过（共 ${passed + failures.length} 条）`);
  process.exitCode = 1;
} else {
  console.log(`\n✓ 全部通过（${passed} 条）`);
  process.exitCode = 0;
}
