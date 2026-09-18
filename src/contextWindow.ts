/**
 * C10 占用指示的两个判据：**分母从哪来**与**算不算接近**。
 *
 * **不 import vscode** —— 同 `runInspector` / `turnState` / `compactionNotice` 的体例，
 * 探针能在扩展宿主之外直接加载它（`scripts/probe-context-window.mjs`）。
 *
 * 为什么值得单独成模块（2026-09-18，一次 F5 之后）：这段的 bug 整整一轮真机都没被看见 ——
 * **续聊时分母永远拿不到**，于是整条占用指示「安静地不存在」（没有百分比、没有 ⚠，什么
 * 都没有）。当时判据全藏在 `chatViewProvider.ts` 的 `_contextState()` 与 `_usageReadout()`
 * 里，而那个文件 import vscode，任何探针都够不着 —— 能发现它的只有肉眼，可肉眼看不出
 * 「本该出现的东西没出现」。凡是有第二个此类判据，都往这里放。
 */

import { DEFAULT_COMPACTION_THRESHOLD_RATIO } from './dshHooks';

/**
 * 警告线 = 阈值 × 0.85，即**提前 15% 报**。
 *
 * 提前是刻意的：等 DSH 压完了再提示等于没提示。0.85 这个余量没有理论依据，是取舍 ——
 * 留得太少会在压缩前一瞬间才喊，留得太多会长期常亮、喊成噪音。
 */
export const CONTEXT_WARN_MARGIN = 0.85;

/** 0 与负数不是窗口，是坏数据 —— 一律当「不知道」。 */
function usableWindow(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * 分母取谁：**活值优先，缺了回落到本会话记住的那个**。
 *
 * - 活值 = 本次连接里 provider 亲口报的（`request/context` 那个 `contextWindow`），
 *   模型或路由一变它就变，所以必须优先。
 * - 记在会话上的那个是**续聊时唯一的来源**：DSH 只在路由**变化**时才 append 那个事件
 *   （`dsh-agent-loop` 拿从**日志**折出来的 `previousContext` 比对，三者相同就不发），
 *   而续聊的日志里早就有一条了 ⇒ 整个连接一条都不发。这不是我们能改的行为，只能自己记。
 * - 两个都没有（本次改动之前就存在的老会话）⇒ undefined，读数里那条整段不显示。
 *   **不猜一个默认窗口**：分母是 1M 还是 128K 差一个数量级，猜错比空着更坏。
 */
export function resolveContextWindow(live: unknown, remembered: unknown): number | undefined {
  return usableWindow(live) ?? usableWindow(remembered);
}

/**
 * 「越过警告线了吗」。
 *
 * ⚠️ **分子与 DSH 的判据不是同一个数，这里只是近似**：分子是 provider 上报的 prompt 侧
 * 压力（`turn.pressureTokens`），而 DSH 决定压不压缩用的是 `token-meter` 的 `totalTokens`
 * ——`CHARS_PER_TOKEN = 4` 的启发式估算，还含输出。分母两边一致（都是 provider 给的窗口）。
 * 所以文案只能说「接近压缩阈值」，**不许**说「距离压缩线还有 X token」。
 *
 * `thresholdRatio` 非法（非数字 / ≤0 / >1 / NaN）⇒ 按默认阈值算：它是用户手写的设置项，
 * 写坏了不该让整条读数变成 0 或 1 的极端值。
 *
 * `contextWindow` 不可用（0 / 负数 / NaN）⇒ `'ok'`。调用方**不该**这么调（`resolveContextWindow`
 * 与读数那处的 `!== undefined` 已经兜住），留这条是因为漏过去的话后果不对称：`used >= 0`
 * 会让**每一条**读数常亮 ⚠（一个显眼的谎），比安静地不喊坏得多。
 */
export function contextStateOf(usedTokens: number, contextWindow: number, thresholdRatio: unknown): 'ok' | 'near' {
  if (usableWindow(contextWindow) === undefined) return 'ok';
  const ratio =
    typeof thresholdRatio === 'number' &&
    Number.isFinite(thresholdRatio) &&
    thresholdRatio > 0 &&
    thresholdRatio <= 1
      ? thresholdRatio
      : DEFAULT_COMPACTION_THRESHOLD_RATIO;
  return usedTokens >= contextWindow * ratio * CONTEXT_WARN_MARGIN ? 'near' : 'ok';
}
