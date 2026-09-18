/**
 * C12 项目级 agent profile —— 解析 + 编译（「只能加严」那条性质就住在这里）。
 *
 * **不 import vscode** —— 同 `contextWindow` / `runInspector` / `effortPlugin` 的体例，
 * 判据必须能在扩展宿主之外加载（`scripts/probe-agent-profile.mjs` 直接载它）。
 *
 * 一句话讲清这个模块的分工：**profile 文件是项目声明，本模块把它编译成扩展内部的策略。**
 * 编译这一步是唯一有权决定「松紧」的地方 —— 出去的每一样都只会比设置**更严**：
 *   · `patterns` 与设置里的清单**取并集**（并集只会变多，删不掉默认那十条）
 *   · `enabled` / `outsideWorkspace` 与设置**取或**（写 false 是**错误**，不是"关掉"）
 *   · `tools` 只有 `deny`，没有 `allow`（allow 表达不了"只能加严"）
 *
 * 为什么这条性质值得用一个模块来守：`.hello-chat/profile.json` 在**工作区里**，
 * agent 的 write 工具技术上能改它（工作区内的写按 C1 的设计不弹条）。与其去做一套
 * "文件完整性"机制，不如让这份文件的**全部语义就是收紧** —— 于是会改写它的 agent
 * 能做的只有勒紧自己。（另一半防线在调用方：运行期读的是激活时存下的副本，改文件不生效。）
 */
import * as fs from 'fs';

/**
 * 便携运行时里实际注册的工具名（逐个从 `dist-runtime/node_modules/@deepseek-ai/dsh-tool-*`
 * grep 出来的：bash / read / write / edit / read_image / todo_write / subagent）。
 *
 * ⚠️ 校验非做不可，而且必须在**编译**这一步做完：运行期的 `tools.restrict()` 是**整批**校验
 * 名字的 —— 一个未知名字会让**整张 deny 表**一起抛掉。于是「禁 bash」会因为旁边写错一个词
 * 而静默失效，正是最难查的那种。编译期丢掉并告警，就把它变成一条**看得见**的错。
 */
export const KNOWN_TOOL_NAMES = [
  'bash',
  'read',
  'write',
  'edit',
  'read_image',
  'todo_write',
  'subagent',
] as const;

/** 一个 profile 的规范化形态。**所有字段可选** —— 没写的就跟随设置。 */
export interface ProfileSpec {
  /** 覆盖配置条的模型（`initialize` 参数，重连生效） */
  model?: string;
  approval: {
    /** 只能出现 `true`：写 false 是错误（见文件头） */
    enabled?: true;
    outsideWorkspace?: true;
    /** 与设置里的清单取并集 */
    patterns: string[];
  };
  tools: {
    /** 只有 deny —— 被禁的工具从模型视野里消失 */
    deny: string[];
  };
}

export interface ProfileFile {
  /** 文件里定义了哪些 profile（**声明顺序 == 菜单顺序**） */
  names: string[];
  profiles: Record<string, ProfileSpec>;
  /** 文件建议的默认项（分享给同事时预选它）。**只是建议** —— 本机选过就以本机为准。 */
  recommended?: string;
  /** 逐条人话错误。**永不因为错误而整体作废** —— 好的部分照用，坏的部分丢掉并说出来。 */
  errors: string[];
}

/** profile 要覆盖的那几个设置项（调用方现读设置后传进来） */
export interface ApprovalSettings {
  enabled: boolean;
  outsideWorkspace: boolean;
  patterns: string[];
}

/** 编译结果：扩展内部真正拿去用的形态。`name === null` = 不用 profile（= 一切照设置） */
export interface EffectiveProfile {
  name: string | null;
  model?: string;
  approval: ApprovalSettings;
  /** 已过滤掉未知名字、已去重 */
  toolDeny: string[];
}

const EMPTY_SPEC = (): ProfileSpec => ({ approval: { patterns: [] }, tools: { deny: [] } });

/** 没选 profile 时用的那个 —— 与"没有这个功能"逐字节等价（零回归的根据） */
export function noProfile(settings: ApprovalSettings): EffectiveProfile {
  return { name: null, approval: { ...settings }, toolDeny: [] };
}

/**
 * 读 profile 文件。**不抛**：读不到就返回空串并标 `missing`（调用方据此走"没有 profile"）。
 * 超过 `maxBytes` 直接当没有 —— 一个几 MB 的 JSON 只会是写坏了或写错了地方。
 */
export function readProfileFile(filePath: string, maxBytes = 256 * 1024): { text: string; missing: boolean } {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > maxBytes) return { text: '', missing: true };
    return { text: fs.readFileSync(filePath, 'utf8'), missing: false };
  } catch {
    return { text: '', missing: true };
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** profile 名不许带空白首尾，也不许空 —— 它会进菜单、进消息、进日志 */
function cleanName(raw: string): string | undefined {
  const t = raw.trim();
  return t && t.length <= 64 ? t : undefined;
}

/**
 * 文本 → 规范化 profile 表。**永不抛**。
 *
 * 每一条错误都带上是**哪个 profile、哪个字段** —— 用户在配置条上看到的是这几行，
 * 「文件有问题」这种话等于没说。
 */
export function parseProfileFile(text: string): ProfileFile {
  const out: ProfileFile = { names: [], profiles: {}, errors: [] };
  if (!text.trim()) return out;

  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (err) {
    out.errors.push(`不是合法的 JSON：${err instanceof Error ? err.message : String(err)}`);
    return out;
  }
  if (!isPlainObject(root)) {
    out.errors.push('根必须是一个对象（形如 { "profiles": { … } }）');
    return out;
  }

  for (const key of Object.keys(root)) {
    if (key !== 'profiles' && key !== 'active') out.errors.push(`未知字段 "${key}"（只认 profiles / active）`);
  }

  const rawProfiles = root.profiles;
  if (!isPlainObject(rawProfiles)) {
    if (rawProfiles !== undefined) out.errors.push('"profiles" 必须是一个对象');
    return out;
  }

  for (const [rawName, rawSpec] of Object.entries(rawProfiles)) {
    const name = cleanName(rawName);
    if (!name) {
      out.errors.push(`profile 名 "${rawName}" 不合法（不能为空、不能超过 64 字）`);
      continue;
    }
    if (!isPlainObject(rawSpec)) {
      out.errors.push(`profile "${name}" 必须是一个对象`);
      continue;
    }
    const spec = EMPTY_SPEC();

    for (const key of Object.keys(rawSpec)) {
      if (key !== 'model' && key !== 'approval' && key !== 'tools') {
        out.errors.push(`profile "${name}"：未知字段 "${key}"（只认 model / approval / tools）`);
      }
    }

    const model = rawSpec.model;
    if (model !== undefined) {
      if (typeof model === 'string' && model.trim()) spec.model = model.trim();
      else out.errors.push(`profile "${name}"：model 必须是非空字符串`);
    }

    const approval = rawSpec.approval;
    if (approval !== undefined) {
      if (!isPlainObject(approval)) {
        out.errors.push(`profile "${name}"：approval 必须是一个对象`);
      } else {
        for (const key of Object.keys(approval)) {
          if (key !== 'enabled' && key !== 'outsideWorkspace' && key !== 'patterns') {
            out.errors.push(`profile "${name}"：approval 里未知字段 "${key}"`);
          }
        }
        // 这三个开关**只能往"开"的方向写**。写 false 不是"关掉"，是一条会被说出来的错 ——
        // 静默忽略用户明明白白写下的意图，比报错更坏。
        for (const flip of ['enabled', 'outsideWorkspace'] as const) {
          const v = approval[flip];
          if (v === undefined) continue;
          if (v === true) spec.approval[flip] = true;
          else out.errors.push(`profile "${name}"：approval.${flip} 只能是 true —— profile 只能加严，不能关掉它`);
        }
        const patterns = approval.patterns;
        if (patterns !== undefined) {
          if (!Array.isArray(patterns)) {
            out.errors.push(`profile "${name}"：approval.patterns 必须是字符串数组`);
          } else {
            for (const p of patterns) {
              if (typeof p === 'string' && p.trim()) spec.approval.patterns.push(p.trim());
              else out.errors.push(`profile "${name}"：approval.patterns 里有一条不是非空字符串，已跳过`);
            }
          }
        }
      }
    }

    const tools = rawSpec.tools;
    if (tools !== undefined) {
      if (!isPlainObject(tools)) {
        out.errors.push(`profile "${name}"：tools 必须是一个对象`);
      } else {
        for (const key of Object.keys(tools)) {
          if (key === 'allow') {
            out.errors.push(`profile "${name}"：只支持 tools.deny —— allow 表达不了"只能加严"`);
          } else if (key !== 'deny') {
            out.errors.push(`profile "${name}"：tools 里未知字段 "${key}"`);
          }
        }
        const deny = tools.deny;
        if (deny !== undefined) {
          if (!Array.isArray(deny)) {
            out.errors.push(`profile "${name}"：tools.deny 必须是字符串数组`);
          } else {
            for (const t of deny) {
              if (typeof t !== 'string' || !t.trim()) {
                out.errors.push(`profile "${name}"：tools.deny 里有一条不是非空字符串，已跳过`);
                continue;
              }
              const tool = t.trim();
              if (!(KNOWN_TOOL_NAMES as readonly string[]).includes(tool)) {
                out.errors.push(
                  `profile "${name}"：没有名为 "${tool}" 的工具，已跳过（已知：${KNOWN_TOOL_NAMES.join(' / ')}）`
                );
                continue;
              }
              if (!spec.tools.deny.includes(tool)) spec.tools.deny.push(tool);
            }
          }
        }
      }
    }

    out.names.push(name);
    out.profiles[name] = spec;
  }

  const active = root.active;
  if (active !== undefined) {
    const name = typeof active === 'string' ? cleanName(active) : undefined;
    if (name && name in out.profiles) out.recommended = name;
    else out.errors.push(`"active" 指向的 profile "${String(active)}" 不存在（它只是建议项，不影响本机选择）`);
  }

  return out;
}

/** 去重并保持先来后到 —— 并集要稳定，否则菜单/日志会随设置读取顺序漂 */
function union(a: readonly string[], b: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of [...a, ...b]) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/**
 * profile + 当前设置 → 真正生效的策略。**本功能的命门就是这一个函数。**
 *
 * 它是纯的、`undefined` profile 也走得通（返回设置本身），所以「装了 C12 但没选 profile」
 * 与「没有 C12」在行为上逐字节相同 —— 零回归不是靠自觉，是靠这条路径没有分支可走。
 */
export function compileProfile(
  profile: ProfileSpec | undefined,
  settings: ApprovalSettings,
  name: string | null = null
): EffectiveProfile {
  if (!profile) return noProfile(settings);
  return {
    name,
    ...(profile.model ? { model: profile.model } : {}),
    approval: {
      // 或，不是赋值 —— 方向由这里定死，UI 侧不需要任何"该不该灰"的判断
      enabled: settings.enabled || profile.approval.enabled === true,
      outsideWorkspace: settings.outsideWorkspace || profile.approval.outsideWorkspace === true,
      patterns: union(settings.patterns, profile.approval.patterns),
    },
    toolDeny: [...profile.tools.deny],
  };
}

/** 菜单里那一行摘要。让人**不点开就知道**这个 profile 要干什么。 */
export function profileSummary(spec: ProfileSpec): string {
  const bits: string[] = [];
  if (spec.model) bits.push(`模型 ${spec.model}`);
  if (spec.approval.enabled) bits.push('审批强制开');
  if (spec.approval.outsideWorkspace) bits.push('区外写强制问');
  if (spec.approval.patterns.length) bits.push(`审批 +${spec.approval.patterns.length} 条`);
  if (spec.tools.deny.length) bits.push(`禁 ${spec.tools.deny.join(' ')}`);
  return bits.join(' · ');
}
