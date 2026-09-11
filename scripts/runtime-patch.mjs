/**
 * 便携运行时的补丁层 —— C5：把「恢复已落盘的 DSH 会话」接到 JSON-RPC wire 上。
 *
 * 为什么非打补丁不可（2026-09-11 在 DSH 检出侧实证，结论见 docs/backlog.md 的 C5 节）：
 *   · wire 只认 initialize / session/prompt / shutdown，**没有 resume 方法**；
 *   · 把已落盘的 sessionId 直接交给 session/prompt **不是「续上」，是「炸」** ——
 *     `createSession` 走的是 `ctx.agents.create`（纯内存、从不读盘），紧接着持久化协调器
 *     在 `session/created` 上 `adoptLivePrefix`，`seedCoversPrefix` 不成立就抛
 *     `session "<id>" already has a persisted log on disk that does not match this live session (id collision)`；
 *   · 能力本身是有的：`ctx.agents.resume` 是公开接口，且 upstream 自己就有 resume-first 的
 *     写法（agent-loop 的 `restoreOrCreateConfigured`）。缺的只是这根接线。
 *
 * **打的是构建产物，不是用户的 DSH 检出。** build-runtime.mjs 在物化符号链接之后、打包/冒烟
 * 之前调用本模块；锚点漂移会让构建当场失败 —— 这里就是漂移检测点（`scripts/update-dsh.mjs`
 * 不能担此任：它跑在 `pnpm run build` **之前**，那时 lib/ 还没重新生成）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 写进 runtime.json 的 `patches` 数组。扩展侧据此判断「这个运行时能不能跨进程复用 DSH id」。 */
export const PATCH_NAME = 'resume-first-session';

/** 被打的产物（相对便携运行时目录）。 */
export const PATCHED_SERVER_REL = 'node_modules/@deepseek-ai/dsh-sdk-jsonrpc-server/lib/index.js';

/** 幂等标记：替换文本里带这一行，重跑时据此直接跳过。 */
const MARKER = '// [hello-c5] resume-first-session';

/**
 * 锚点 —— **逐字**取自构建产物（LF、tab 缩进，2026-09-11 核过：全文件 CRLF 0 处、本锚点命中 1 处）。
 * 改一个空格就再也对不上，构建会大声失败而不是悄悄放过。
 * 用数组拼是为了让 tab 可见，比一行带字面制表符的字符串好核对。
 */
const ANCHOR = [
  '\tasync createSession(sessionId) {',
  '\t\tconst rec = { handle: await this.ctx.agents.create({',
  '\t\t\tsessionId: SessionId(sessionId),',
  '\t\t\tmeta: { cwd: this.cwd },',
  '\t\t\tagentOptions: {',
  '\t\t\t\tprovider: this.provider,',
  '\t\t\t\tmodel: this.model,',
  '\t\t\t\t...this.maxTokens === void 0 ? {} : { maxTokens: this.maxTokens }',
  '\t\t\t}',
  '\t\t}) };',
  '\t\tthis.sessions.set(sessionId, rec);',
  '\t\treturn rec;',
  '\t}',
].join('\n');

/**
 * 替换文本 —— **严格镜像 upstream `restoreOrCreateConfigured` 的纪律**：
 * 先 resume，**只有确实没有磁盘工件**时才回落 create，报错/损坏一律照抛
 * （upstream 原话："corruption and backend failures stay loud"）。
 *
 * 两个易错点，实现时已核对：
 *   · `ResumeAgentOptions` **没有** `sessionId` / `meta` —— cwd 从盘上 header 来，不是我们传；
 *   · `this.ctx.get("...")` 是这个文件自己的取服务写法（同文件 `hasAdapterFor` 里就是 `this.ctx.get("llm")`）。
 */
const REPLACEMENT = [
  '\tasync createSession(sessionId) {',
  `\t\t${MARKER}`,
  '\t\tconst agentOptions = {',
  '\t\t\tprovider: this.provider,',
  '\t\t\tmodel: this.model,',
  '\t\t\t...this.maxTokens === void 0 ? {} : { maxTokens: this.maxTokens }',
  '\t\t};',
  '\t\tlet handle;',
  '\t\ttry {',
  '\t\t\thandle = await this.ctx.agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions });',
  '\t\t} catch (error) {',
  '\t\t\tconst persistence = this.ctx.get("sessionPersistence");',
  '\t\t\tlet exists = false;',
  '\t\t\ttry {',
  '\t\t\t\texists = persistence !== void 0 && (await persistence.list()).some((header) => header.id === sessionId);',
  '\t\t\t} catch {}',
  '\t\t\tif (exists) throw error;',
  '\t\t\thandle = await this.ctx.agents.create({ sessionId: SessionId(sessionId), meta: { cwd: this.cwd }, agentOptions });',
  '\t\t}',
  '\t\tconst rec = { handle };',
  '\t\tthis.sessions.set(sessionId, rec);',
  '\t\treturn rec;',
  '\t}',
].join('\n');

/** 该运行时目录里被打的那个产物的绝对路径。 */
export function serverArtifactPath(runtimeDir) {
  return join(runtimeDir, PATCHED_SERVER_REL);
}

/** 这个运行时目录**是否已经**带上补丁（读产物里的标记；产物读不到就是 false）。 */
export function isRuntimePatched(runtimeDir) {
  try {
    return readFileSync(serverArtifactPath(runtimeDir), 'utf8').includes(MARKER);
  } catch {
    return false;
  }
}

/**
 * 给构建产物打上 resume-first 补丁（幂等）。已打过则原样返回。
 *
 * @param {string} runtimeDir 便携运行时目录
 * @returns {{ changed: boolean, file: string }}
 * @throws 产物不存在、或锚点出现次数 ≠ 1（DSH 升级把 createSession 改动了）—— 一律带精确诊断。
 */
export function applyResumePatch(runtimeDir) {
  const file = serverArtifactPath(runtimeDir);

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`resume 补丁的目标产物不存在：${file}（${err.code ?? err.message}）`);
  }
  if (text.includes(MARKER)) return { changed: false, file };

  const hits = text.split(ANCHOR).length - 1;
  if (hits !== 1) {
    throw new Error(
      `resume 补丁的锚点在 ${file} 里出现 ${hits} 次（期望恰好 1 次）——` +
        'DSH 升级改动了 createSession，补丁已失效。' +
        '请比对 upstream 的 restoreOrCreateConfigured（packages/core/agent-loop/src/index.ts）后更新 scripts/runtime-patch.mjs。'
    );
  }

  writeFileSync(file, text.replace(ANCHOR, REPLACEMENT));
  return { changed: true, file };
}

/**
 * 把补丁从构建产物上**撤掉**（还原成未打补丁的样子）。已打过则是空操作。
 *
 * 两个用途：① probe-resume.mjs 用它保证「补丁前」那一轮跑在真正的原始产物上
 * （否则上一轮探针留下的补丁会让对照组成立不了）；② 万一补丁出问题，这是一条摘掉它的退路。
 */
export function revertResumePatch(runtimeDir) {
  const file = serverArtifactPath(runtimeDir);

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { changed: false, file };
  }
  if (!text.includes(MARKER)) return { changed: false, file };

  const hits = text.split(REPLACEMENT).length - 1;
  if (hits !== 1) {
    throw new Error(`无法撤销 resume 补丁：${file} 里的替换文本出现 ${hits} 次（期望恰好 1 次）——产物被本模块之外的东西改过。`);
  }
  writeFileSync(file, text.replace(REPLACEMENT, ANCHOR));
  return { changed: true, file };
}
