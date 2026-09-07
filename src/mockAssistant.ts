/**
 * 假回复源（可替换的「产出器」）。
 *
 * 设计成 async generator：消费方 `for await (const chunk of ...)`。
 * 将来接真实 Anthropic API 时，另写一个相同签名的 `anthropicStream()`，
 * 把它的每个「文本块」映射成 assistant-delta 即可——本文件之外零改动。
 *
 * 停止/中断全靠外部传入的 AbortSignal：sleep() 被 abort 时会立刻 reject，
 * 不会傻等满一个间隔。
 */

/** 可中断延时：abort 时立刻以 AbortError 拒绝。 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(t);
      reject(abortError());
    }

    if (signal) {
      if (signal.aborted) {
        clearTimeout(t);
        reject(abortError());
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function abortError(): Error {
  const e = new Error('操作已被中止');
  e.name = 'AbortError';
  return e;
}

/** 抛出的错误是否来自用户主动中止（stop / 清屏 / 视图关闭）。 */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** 随机整数 [min,max]。 */
const rand = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

export interface MockOptions {
  /** 首段前模拟「思考中」的停顿，默认 60ms */
  initialDelay?: number;
  /** 每块之间的随机间隔下限/上限(ms) */
  minDelay?: number;
  maxDelay?: number;
  /** 每块字符数下限/上限；越大越快（块太大则重渲染次数少、近乎一次出现） */
  minChunk?: number;
  maxChunk?: number;
}

/**
 * 把一段「已固定文本」切成小块流式产出：每个 yield 是一小段纯文本(= 一条 assistant-delta)。
 *
 * 单独拆出来供 harness 复用——它要流式输出的是预先算好的助手正文，与 chat 模式同一条
 * 渲染管线。mock 的固定文字刻意默认大块 + 极短间隔，让文字几乎一次性出现（仍走 delta
 * 管线，停止按钮/光标逻辑照常可测）。将来接真实模型，模型文本本来一路快推，不受这里
 * 默认值影响。
 */
export async function* streamText(
  text: string,
  opts: MockOptions = {},
  signal?: AbortSignal
): AsyncGenerator<string> {
  const { initialDelay = 60, minDelay = 6, maxDelay = 16, minChunk = 24, maxChunk = 80 } = opts;
  await sleep(initialDelay, signal);
  for (let i = 0; i < text.length; ) {
    await sleep(rand(minDelay, maxDelay), signal);
    const chunk = text.slice(i, i + rand(minChunk, maxChunk));
    i += chunk.length;
    yield chunk;
  }
}

/** 每条 mock 回复都刻意塞满各种 markdown 分支，方便一次性验证渲染。 */
const CANNED_REPLIES: Array<(prompt: string) => string> = [
  (prompt: string) => `收到你的消息：**${prompt}**

这是第一条演示回复，包含多种样式：

## 要点

- 用户消息在**右侧**、助手在左侧
- 流式输出逐字出现，并带闪烁光标
- 下面的代码块里是纯文本

\`\`\`python
# 你好，这是假回复里的代码块
def mock(prompt):
    return "这是" + prompt
\`\`\`

行内代码如 \`npm run compile\` 也会被高亮。`,
  (prompt: string) => `关于「${prompt}」，我是第二条演示回复：

> 等真正接上模型后，这里会换成模型生成的正文。

1. 第一步：\`npm run compile\`
2. 第二步：按 **F5** 打开扩展开发窗口
3. 第三步：在这块面板里聊天

\`\`\`ts
// TypeScript 代码块演示
interface Msg {
  role: 'user' | 'assistant';
  text: string;
}
\`\`\`

用 \`Ctrl+Enter\` 之类习惯调整输入体验也留到后面。`,
  (prompt: string) => `第三条演示回复，呼应「${prompt}」。

## 架构提示

- **扩展进程**持有消息记录（事实源）
- **webview** 只是纯视图，靠 \`snapshot\` 重建
- \`assistant-delta\` 与真实 SSE 的文本增量**一一对应**

\`\`\`js
// 接真实 API 时只换下面的产出器
for await (const delta of stream) {
  post({ type: 'assistant-delta', id, delta });
}
\`\`\``,
];

let replyIndex = 0;

function pickReply(prompt: string): string {
  const tpl = CANNED_REPLIES[replyIndex % CANNED_REPLIES.length];
  replyIndex++;
  return tpl(prompt);
}

/**
 * 流式产出一条 mock 回复：先选一条预置的固定文字，再用 streamText 切成块慢放。
 * 将来接真实模型后换同名产出器即可，消费方零改动。
 */
export async function* streamMockReply(
  prompt: string,
  opts: MockOptions = {},
  signal?: AbortSignal
): AsyncGenerator<string> {
  const reply = pickReply(prompt);
  yield* streamText(reply, opts, signal);
}

// ---------- harness/Agent 模式：mock 工具调用 ----------

/** 一条 mock 计划步骤：要么「说句话」要么「跑一个工具」。 */
export type HarnessStep =
  | { kind: 'say'; text: string }
  | {
      kind: 'tool';
      name: string;
      input: string;
      /** 最终结果 */
      output: string;
      /** 是否演示失败（error 红卡） */
      error?: boolean;
      /** 模拟运行耗时(ms) */
      delayMs?: number;
    };

/**
 * 依据用户输入拼出一份 mock 的 Agent 执行计划：
 * 先来一小段"规划"文本 → 跑两个工具 → 一个失败工具 → 最后给结论正文。
 * 返回的步骤序列由 _runHarness 逐条执行，将来接真实 harness（如 deepseek harness）
 * 的事件流时，把这里的产出换成真事件即可，渲染结构不变。
 */
export function buildHarnessPlan(prompt: string, attachmentNames: string[]): HarnessStep[] {
  const userNote = prompt.trim();
  const files =
    attachmentNames.length > 0
      ? `其中包含 ${attachmentNames.length} 个附件：${attachmentNames.join('、')}。`
      : '';
  return [
    {
      kind: 'say',
      text:
        userNote
          ? `收到任务：「${userNote}」。` + (files ? ` ${files}` : '') + ' 我先规划一下再动手。'
          : '收到任务。我先规划一下再动手。',
    },
    {
      kind: 'tool',
      name: 'plan',
      input: JSON.stringify({ objective: userNote, steps: 3 }, null, 2),
      output: '已拆解为 3 步：1) 收集上下文 2) 定位关键文件 3) 汇总结论。',
      delayMs: 500,
    },
    {
      kind: 'tool',
      name: 'bash',
      input: "ls *.md",
      output: 'README.md\nCHANGELOG.md\ndocs/guide.md',
      delayMs: 700,
    },
    {
      kind: 'tool',
      name: 'glob',
      input: 'src/**/*.ts',
      output: 'src/extension.ts\nsrc/protocol.ts\nsrc/chatViewProvider.ts\nsrc/mockAssistant.ts',
      delayMs: 500,
    },
    {
      kind: 'tool',
      name: 'read',
      input: 'src/protocol.ts',
      output:
        '// 前后端共享的「单一事实源」…\nexport type Mode = \'chat\' | \'harness\';',
      error: true,
      delayMs: 600,
    },
    {
      kind: 'say',
      text:
        '执行结束：上面的模拟过程中 `read` 这一步刻意演示了**失败工具卡**。\n\n' +
        '等接上真正的 harness（例如 deepseek harness 的事件流）后，这里会换成真实的\n' +
        '`tool_use` / `tool_result` 事件，界面渲染结构不变。',
    },
  ];
}
