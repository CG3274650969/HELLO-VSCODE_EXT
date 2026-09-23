/**
 * C17b 图片说明的**另一个家**：从用户消息里搬出来，挂进系统提示词。
 *
 * **不 import vscode** —— 同 `effortPlugin.ts` / `toolPolicyPlugin.ts` 的体例，
 * `scripts/probe-image-prompt.mjs` 把下面的 `IMAGE_PROMPT_PLUGIN_SCRIPT` 当纯模块直接载入、喂假 ctx。
 *
 * ## 为什么搬（用户的一句话）
 *
 * C17 把那段说明（`图片附件：x.png（image/png，344 KB…）` + 路径 + 四句约束）拼进**用户消息正文**，
 * 而 DSH 自己的转写面是「所见即所发」—— 于是这段说给模型听的话被原样显示在用户气泡里，
 * 用户每贴一张图都要在自己的话下面读一遍机器告示。用户要的是：**气泡里只剩自己写的那句话**。
 *
 * 这条没有「渲染层」的解法：`SessionPromptParams` 只有 `contentBlocks`、且是
 * 「sent verbatim as the user message」，**没有隐藏通道**（wire 上压根没有 additionalContext 这种东西）。
 * 要去掉，只能不写进消息 —— 而那段约束又必须到得了模型，于是它搬到系统提示词。
 *
 * ## 为什么是「一个小节 + 一份状态文件」
 *
 * 系统提示词那一侧只有 `ctx.systemPrompt.section({name, order, text})` 一条路可以插话，
 * 但 `text` **可以是函数、每次 assembly 现算**（`dsh-system-prompt/lib/index.js:271`），
 * 且 `renderPrompt` 会把插值后为空的小节整个丢掉（`index.js:66`）——
 * 也就是「**没有图片的会话，这一节一个字节都不存在**」，零开销、零痕迹。
 * 而 `AssembleContext` 带着 `agent`（`dsh-agent` 扩展过），`agent.id` 就是 DSH 会话 id，
 * 所以我们**不需要按 agent 注册**：一个全局小节，读表时按会话取。
 *
 * 文字本身由**扩展侧**渲染（`imageAttach.imagePromptText`，纯函数、有探针钉着），
 * 这里只做「读表 → 返回那一串」。插件越哑，它出错的空间越小。
 *
 * ## 两条纪律
 *
 *  ① **`inject = ['systemPrompt']` 不是可选的**：DSH 里所有用系统提示词的插件都这么写
 *     （`dsh-persona` 就是 `inject=['systemPrompt']` + `ctx.effect(() => …section(…))`）。
 *     不声明时，若该服务尚未提供，`ctx.systemPrompt` 会抛
 *     `cannot get property "systemPrompt" without inject` —— 声明了 cordis 就会等它就绪再 apply。
 *  ② **纯增益**：任何异常、任何读不到、任何形状不对，唯一可接受的行为都是「什么都不加」。
 *     一次请求因为一个说明文字挂掉是不可接受的形状。
 */

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

/** 派生配置里的块 id 与插件 `name`（同一个字符串，便于人肉对账）。 */
export const IMAGE_PROMPT_PLUGIN_ID = 'hello-chat-image-prompt';

/** 系统提示词小节名。带命名空间前缀，免得与 DSH 自己的小节撞名。 */
export const IMAGE_PROMPT_SECTION_NAME = 'aloha:image-attachments';

/**
 * 承载正文的那个**提示词变量**名（小节正文只写 `{{hello_image_list}}`）。
 *
 * 为什么要绕这一道（不是洁癖，是防一个会让会话永久坏掉的坑）：
 * `renderPrompt` 对**每个** section 都跑 `interpolate`（`dsh-system-prompt/lib/index.js:66`、`:105-131`），
 * 文本里出现 `{{某个没注册的名字}}` 就直接 **throw** —— 而那一步的 assembly 抛了，这一步就失败。
 * 我们的正文里带的是**用户数据**（文件名与路径）：一张叫 `{{草稿}}.png` 的图（模板生成的文件很常见）
 * 会让那个会话**每一轮**都抛，而状态表是整份重写的（只要那张图还在历史里就一直在）⇒
 * **用户没有任何出路**。而 `interpolate` 的文档明说「substituted values are not scanned again」，
 * 变量值又是每次 assembly 现算的（`assemble` 里 `variables[name] = provider(context)`，`:245`）——
 * 所以把正文从**变量**送进去，`{{` 就再也不会被当成引用，路径还能逐字保真。
 *
 * 名字必须匹配 `[a-z][a-z0-9_]*`（`:227-229` 校验）。
 */
export const IMAGE_PROMPT_VARIABLE_NAME = 'hello_image_list';

/** 调试/探针用：小节正文该长什么样（**恰是一个变量引用**）。
 *  真正的字面量写在插件脚本里（脚本内不许做 `${}` 插值），两条有探针钉着一致。 */
export const IMAGE_PROMPT_SECTION_TEXT = `{{${IMAGE_PROMPT_VARIABLE_NAME}}}`;

/**
 * 小节排序。取一个靠后的值：这一节是**附加提醒**，不该插到 DSH 自己那几节（人设、工具说明、
 * 工作区约定）的前面去改变它们的相对次序。它排在新旧小节之间都无所谓，只要稳定 ——
 * 值一变，所有会话的 `request/header.system` 就会变一次，前缀缓存白丢一轮。
 */
export const IMAGE_PROMPT_SECTION_ORDER = 150;

/** 挂进派生配置的入参（`writeDerivedConfig` 的 `imagePrompt`）。 */
export interface ImagePromptMount {
  /** 插件文件的 `file:///…` URL —— 派生配置里 `name:` 直接写它 */
  pluginUrl: string;
  /** 状态表（`{dsh会话id: 渲染好的说明块}`）的路径，插件每次 assembly 现读它 */
  statePath: string;
}

export interface ImagePromptPluginFiles {
  /** 插件本体（生成的） */
  scriptPath: string;
  /** 状态表（每次写入重写整份） */
  statePath: string;
  /** 派生配置里 `name:` 要写的值 */
  pluginUrl: string;
}

/**
 * 写出插件文件，返回三个路径。落在 `<storageDir>/dsh-plugins/`（与 C1 的 `dsh-hooks/`、
 * C11 的档位插件并列，都在扩展 globalStorage 里，绝不进仓库/工作区）。
 *
 * `pluginUrl` 用 `pathToFileURL().href` 而不是手拼 `file:///`：盘符大小写、空格、非 ASCII
 * 目录名（本机用户目录就是中文）全靠它。
 */
export function writeImagePromptPluginFiles(opts: { storageDir: string }): ImagePromptPluginFiles {
  const dir = path.join(opts.storageDir, 'dsh-plugins');
  fs.mkdirSync(dir, { recursive: true });
  const scriptPath = path.join(dir, 'image-prompt.mjs');
  fs.writeFileSync(scriptPath, IMAGE_PROMPT_PLUGIN_SCRIPT, 'utf8');
  const statePath = path.join(dir, 'image-prompt-state.json');
  return { scriptPath, statePath, pluginUrl: pathToFileURL(scriptPath).href };
}

/**
 * 写状态表。**每次都整份重写**（同 `writeEffortState`），而且调用方给的是**全量** ——
 * 一个 DSH 进程服务多个会话、切会话不重启，表里必须同时有所有会话的说明。
 *
 * 写盘用 tmp + rename：插件在**每次 assembly** 都读这个文件，读到半截 JSON 会让这一轮
 * 悄悄少一段说明 —— 那不是崩溃，是「偶尔不提醒」，最难查的那种。
 *
 * 空串与非字符串一律丢掉（**空串就是「这个会话没有图片」**，写进去等于给表塞垃圾；
 * 插件那边也有一道，但那道是兜底）。
 */
export function writeImagePromptState(statePath: string, byId: Record<string, unknown>): void {
  const clean: Record<string, string> = {};
  for (const [id, value] of Object.entries(byId ?? {})) {
    if (typeof id === 'string' && id && typeof value === 'string' && value.length > 0) {
      clean[id] = value;
    }
  }
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, statePath);
}

/**
 * 插件本体。用 `String.raw` 是因为里面全是 `\s`/`\n` 这类转义（体例同 `EFFORT_PLUGIN_SCRIPT`），
 * 脚本内**不使用 `${}` 插值** —— 需要的东西一律从 `config` 入参读。
 */
export const IMAGE_PROMPT_PLUGIN_SCRIPT = String.raw`/**
 * AlohaDSH · C17b 图片说明插件（由扩展自动生成，请勿手工编辑）。
 *
 * 这是个被 import 的插件模块，不是可执行脚本 —— 所以没有 shebang。
 *
 * 挂进派生 cordis.yml（id: hello-chat-image-prompt）。做两件事：
 *   ① 注册一个提示词**变量**（名字见下），它的值 = 「本会话附过哪些图片 + 你看不见它们」，
 *      由扩展渲染好放在 statePath 里，**每次 assembly 现读**；没有记录就是空串。
 *   ② 注册一个**小节**，正文**恰是那一个变量引用**。
 *
 * 为什么绕这一道（不是洁癖）：renderPrompt 对每个 section 都跑 interpolate，文本里出现
 * {{没注册的名字}} 会直接 throw —— 而那一步的 assembly 抛了这一步就失败。正文里带的是
 * 文件名与路径这类**用户数据**，一张叫 {{草稿}}.png 的图会让这个会话**每一轮**都抛
 * （状态表整份重写 ⇒ 只要那张图还在历史里就一直在，用户没有出路）。
 * interpolate 的文档明说「substituted values are not scanned again」⇒ 从变量送进去的正文
 * 不会再被扫描，路径逐字保真。
 *
 * ⚠️ 顺序是承重的：**先注册变量、再注册小节**。反过来的话，变量注册失败（比如名字被别的插件
 * 占了）就会留下一个引用不存在变量的小节 ⇒ 每一次 assembly 都抛。现在这样最坏只是"没这个功能"。
 *
 * 为什么不是发在用户消息里：那段说明会出现在气泡里（DSH 的转写面是"所见即所发"），
 * 而用户要的是气泡干净。见 imageAttach.ts / imagePromptPlugin.ts 的注释。
 *
 * ⚠️ 本插件是纯增益：任何异常、任何读不到，唯一可接受的行为都是「什么都不加」。
 */
import { readFileSync } from 'node:fs'

export const name = 'hello-chat-image-prompt'

/** 不用 systemPrompt 服务就什么都不用谈；不声明的话 cordis 可能在服务就绪前就 apply 我们。 */
export const inject = ['systemPrompt']

const VARIABLE_NAME = 'hello_image_list'
const SECTION_NAME = 'aloha:image-attachments'
const SECTION_ORDER = 150

/** 现读状态表；坏 JSON / 文件不在 / 任何异常 → 空表（= 不加任何内容） */
function readState(statePath) {
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function apply(ctx, config) {
  const statePath = config && typeof config.statePath === 'string' ? config.statePath : ''
  if (!statePath) return
  try {
    if (!ctx || !ctx.systemPrompt || typeof ctx.systemPrompt.variable !== 'function') return
    if (typeof ctx.systemPrompt.section !== 'function') return
    if (typeof ctx.effect !== 'function') return

    /** 本会话（= agent.id）的那段说明；没有就是空串（空 ⇒ renderPrompt 把小节整个丢掉） */
    const textFor = (context) => {
      try {
        const id = context && context.agent ? context.agent.id : undefined
        if (typeof id !== 'string' || !id) return ''
        const hit = readState(statePath)[id]
        return typeof hit === 'string' ? hit : ''
      } catch {
        return ''
      }
    }

    ctx.effect(() => {
      // ① 先变量（失败就抛出去、绝不注册下面那个引用它的小节）
      const dispose = ctx.systemPrompt.variable(VARIABLE_NAME, (context) => textFor(context))
      // ② 再小节：正文只有一个引用，别的什么都不写
      try {
        ctx.systemPrompt.section({
          name: SECTION_NAME,
          order: SECTION_ORDER,
          text: '{{' + VARIABLE_NAME + '}}',
        })
      } catch (err) {
        // 小节注册不上就把变量一起撤了，不留半套
        try {
          if (typeof dispose === 'function') dispose()
        } catch {}
        throw err
      }
      return dispose
    })
  } catch {
    // 注册不上就等于没有这个功能，绝不让它影响一次请求
  }
}
`;
