# DSH 运行时依赖治理（目标 B：稳定长期用 + 追 DSH 版本）

本文记录一个决定：**把本地 DeepSeek-Harness（DSH）检出当作「版本化运行时依赖」治理** —— 锁 tag、可复现地升级、升级后冒烟 —— 而不是改成用官方 npm 发行。配套脚本 `scripts/update-dsh.mjs`。

> 适用目标 B 的阶段性结论。若下面的「切官方 npm 的观察清单」三个条件都满足，应重新评估直接消费官方运行时。

## 决策摘要：为什么先治理源码检出

扩展目前以子进程拉起检出里的 jsonrpc-demo 入口（裸 JSON-RPC，自己消费帧）。官方 npm 是否已有可替换的「交互 stdio JSON-RPC」成熟运行时？逐包核过（当时最新版）：

| 包 | 版本 | 状态 → 结论 |
|---|---|---|
| `@deepseek-ai/dsh` | `0.1.2-rc.1` | 提供 `dsh` bin（完整交互应用发行）。版本号轨迹与其它包不一致。 |
| `@deepseek-ai/dsh-sdk-jsonrpc-server` | `0.0.1-rc.5` | 发布了一个接缝，但 README 为空，用法文档缺失。 |
| `@deepseek-ai/dsh-headless` | `0.0.1-rc.1` | **一次性非交互**：`dsh --profile headless "task"` 跑完即退，不是能维持会话的 stdio 运行时。 |
| `@deepseek-ai/agent-spine` | 404 未发布 | 编排插件（我们依赖的部署配置里那层）没上 npm。 |

三点硬事实：

1. **版本轨分裂**：`0.0.1-rc.x`（seam / headless）与 `0.1.2-rc.1`（CLI）不是同一发布轨，无法按一个 tag 复现「哪版和哪版配套」。
2. **接缝未成熟**：`dsh-sdk-jsonrpc-server` 空 README、`agent-spine` 没发布 —— 官方「可交互 stdio runtime」尚不可用。
3. **交互发行主要在应用层**：`dsh` 是完整应用，不是干净可嵌入的 stdio JSON-RPC 服务。

结论：官方 npm **目前不是可替换交互 stdio JSON-RPC 的成熟 drop-in**。而源码检出走 git tag 可复现、可冒烟、可跟随上游，先把「浮动检出」变成「vendored runtime」更稳。等官方发布轨收敛（见下）再换不迟。

## 当前锁定版本

- 检出 package：`@deepseek-ai/dsh-root` **`0.1.0-rc.8`**
- git 锁点 tag：**`dsh-v0.1.0-rc.8`**（`git describe --exact-match --tags HEAD` 命中）
- 引擎要求：`engines.node: ^22.19.0 || >=24.0.0`（构建/冒烟需 `--import` → node ≥18.19；用 24.x 的独立 node）

**验证当前是否仍锁在版本上**（只读，不联网）：

```bash
node scripts/update-dsh.mjs <DSH检出根>
```

输出里应见：`在 tag 上: dsh-v0.1.0-rc.8 ✓ 可复现锁点`、各关键路径 `✓`、`✓ 冒烟通过`。若显示 `⚠ 不在任何 tag 上` 说明检出漂了，别在漂移状态继续用。

断言版本一致性（CI / 例行可用）：

```bash
node scripts/update-dsh.mjs <DSH检出根> --expected 0.1.0-rc.8
```

## 升级仪式

平时保持锁在 release tag；升 DSH 只走一条可复现的路：

```bash
# 1) 把仓库最新 tag 拉下来看有没有新的
node scripts/update-dsh.mjs <DSH检出根> --fetch

# 2) 升级到目标 tag（自动：fetch → checkout → pnpm install → pnpm run build → 冒烟）
node scripts/update-dsh.mjs <DSH检出根> --to dsh-vX.Y.Z-rc.N
```

`--to` 结束后脚本会打印 **F5 手动冒烟清单**，别跳过：

1. 打开扩展 → Harness 页签，状态点转绿「在线 · \<模型\>」。
2. 发一句话，确认工具卡 + 转写正常（真实会话）。
3. 若跨了大版本，跑一次 `node scripts/capture-dsh-frames.mjs …` 核对 JSON-RPC 事件词表有无漂移。
4. 升级成功后把本文「当前锁定版本」与上面 `--expected` 的示例更新到新版本。

### 选项

| 选项 | 作用 |
|---|---|
| `--node <node.exe>` | 指定冒烟/构建用 node（默认自动选：`DSH_NODE` → `DSH_CAP_NODE` → 检出旁的 `tools/node-v*/node.exe` → `process.execPath`；太旧会直接 fail 并提示）。 |
| `--skip-build` | 跳过 `pnpm run build`（仅本地已构建的调试场景）。 |
| `--allow-dirty` | 允许工作区含已跟踪改动时升级（默认要求干净）。**react-live 雷点：正常需要它**，见下。 |

## react-live 产物：升级时的雷点

`media/dsh-live/`（DSH 真对话组件画面）产自检出内一个**本地未提交 spike**：`apps/web/dsh-webview/vite.config.mts` + 手工加进 `apps/web/package.json` 的 `build:dsh-webview` script，`outDir` 指向本扩展的 `media/dsh-live`。

后果：

- 该 spike 让 `apps/web/package.json` 长期处于**已跟踪改动**状态 —— 升级默认要求干净工作区，所以 `--to` 需带 `--allow-dirty`；升级切 tag 时若上游也改了这份文件，会**冲突**。
- 建议把 spike 与升级解耦：平时用 `git stash`（或单独 worktree）管 spike，升级时留干净树免冲突，升级完重建前端产物。
- DSH 升完后**重建一次** `media/dsh-live`，否则 webview 里真组件画面可能落后于运行时行为（不重建也能对话 —— 回落 DOM 转录渲染 —— 只是没有真组件观感）。

构建产物不入库（gitignore）；缺失时扩展自动回落，详见主 README 的 react-live 一节。

## 什么时候切官方 npm：观察清单

三个条件**同时**满足再重新评估；满足几个先验证几个（都只读 npm）：

1. **可交互 stdio 运行时出现**：官方提供能维持会话的交互 stdio JSON-RPC 服务（不是 `dsh-headless` 那种跑完即退的一次性模式）。
   ```bash
   npm view @deepseek-ai/dsh version
   npm view @deepseek-ai/dsh-headless description   # 应不再是 one-shot
   ```
2. **编排层已发布**：`agent-spine`（或等价编排插件）上 npm，部署配置能整段装齐。
   ```bash
   npm view @deepseek-ai/agent-spine version        # 404 → 仍缺
   ```
3. **发布轨收敛**：`dsh` / `dsh-sdk-jsonrpc-server` / `dsh-headless` 回到同一条 `-rc`/稳定轨，能按一个版本号复现配套，README/文档可用。
   ```bash
   npm view @deepseek-ai/dsh-sdk-jsonrpc-server version
   npm view @deepseek-ai/dsh version                 # 与上面对得上号
   ```

三条齐了，迁移目标才应是官方 npm（替换 spawn 对象 + 移除 vendored 治理），否则维持现状成本更低也更稳。

## 故障排查

- **`--fetch` / `--to` 拉不动 tag**：多半是直连 GitHub 被断。手动经本地代理执行，或照脚本报错里的命令：
  ```bash
  git -c http.proxy=http://127.0.0.1:<端口> -c https.proxy=http://127.0.0.1:<端口> fetch --tags origin
  ```
- **冒烟报 `bad option: --import`**：当前 node 太旧（<18.19）。用 `--node` 指向新版，或导出 `DSH_NODE`。
- **`在 tag 上` 不出现**：检出不在任何 release tag，先确认是不是上游在 release 之外的中间态。
- **升级冲突在 `apps/web/package.json`**：见上「react-live 产物」一节，先 stash spike 再升级。

## 相关

- 决策前因（三硬事实、npm 元数据核对）见本仓库对话记录；脚本本体 `scripts/update-dsh.mjs` 头部注释同步说明。
- 抓帧工具 `scripts/capture-dsh-frames.mjs`（`DSH_CAP_*`）仍用于跨版本事件词表核对。
