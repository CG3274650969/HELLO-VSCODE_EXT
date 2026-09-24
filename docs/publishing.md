# 打包与发布

> 中文单语、**维护者向** —— 这份不是手册的一部分（手册那两本要中英对拍，这份不用）。
> 它只回答一件事：**怎么把这个扩展变成一个别人能装的东西。**

## 0. 两件必须先知道的事

**① 有两条互不相通的上传路，只有命令行那条需要 PAT：**

| 路 | 要什么 | 适合 |
|---|---|---|
| **网页上传 `.vsix`** | 只要**登录成该 publisher 的 Owner/Contributor**（微软账号） | **没有 Azure 订阅/不想绑卡就走这条** —— 不需要 PAT、不需要 Azure DevOps 组织、不需要订阅 |
| 命令行 `vsce publish` | 一个 PAT（⇒ 要一个 Azure DevOps 组织） | 想一条命令发版、或想接 CI |

⚠️ 建 **Azure DevOps 组织**才是会要「有效 Azure 订阅（绑卡）」的那一步；PAT 只是给命令行用的凭证。
网页上传完全不经过它。

**② publisher 的身份是账号，不是名字。** `package.json` 的 `publisher` 必须与
marketplace.visualstudio.com/manage 上的 publisher **ID 一字不差**；ID 建完**不能改**
（显示名可以改）。本仓当前是：

```json
"publisher": "cg123link"
```

（2026-09-24 实测：`cg123link` 这个 publisher 在市场上已存在；`starmerx-local` 不存在 ⇒
要么用 `cg123link`，要么去 Manage 新建一个 ID 为 `starmerx-local` 的，别两边各写各的。）
另：`displayName`（`AlohaDSH`）必须**全市场唯一**，撞名会在上传时被拒。

## 1. 打包（出 `.vsix`）

```sh
# 1) 编译（仓里的 node 是给运行时用的；系统 node 16 跑不动新版 vsce）
./dist-runtime/node/node.exe node_modules/typescript/bin/tsc -p .

# 2) 打包。vsce 不必装进本仓（本仓零运行时依赖），装在仓外任意目录即可：
#    mkdir -p /tmp/vsce-tool && cd /tmp/vsce-tool && npm i @vscode/vsce
./dist-runtime/node/node.exe /tmp/vsce-tool/node_modules/@vscode/vsce/vsce package
```

产出 `hello-vscode-ext-<version>.vsix`（文件名取 `package.json` 的 `name`，不是 `displayName`）。

⚠️ **别用系统 node（本机是 v16）跑 vsce**：新版要求 node ≥ 20，会直接报引擎错误。
⚠️ 别用 `spawnSync('npm.cmd', …)` 那套去调构建 —— 在这台机器上它会**静默返回空**。

## 2. 三条「打包器会当场中止」的坑

1. **`.vscodeignore` 不能删。** vsce 找不到它就会退回去把 `.gitignore` 当排除表，而 `out/`
   正在 `.gitignore` 里 ⇒ 入口被排除、打出一个装起来不会动的包**且不报错**。反过来，`out/`、
   `media/**` 这些**不能**写进 `.vscodeignore`。
2. **README 里的图片必须是绝对 https 的 PNG。** vsce 的三条规矩（`out/package.js`）：
   裸 HTML 的 `<img src="相对路径">` 会被判 `Invalid image source`；图片源不是 https 会被判
   `must come from an HTTPS source`；`.svg` 还要求 host 落在 `TrustedSVGSources` 白名单里
   （`github.com` / `raw.githubusercontent.com` **都不在**）⇒ 报 `SVGs are restricted`。
   markdown 的 `[文字](相对路径)` 会被自动改写成绝对地址，**只有裸 HTML 不会**。
   → 本仓头图已改成指向 `main` 分支的绝对 https `.png`（源文件仍是 `media/logo-*.svg`：
   改造型改 SVG，另存为同名 `.png` 即可；渲法 = 任意 SVG→PNG 工具，例如无头 Edge
   `--screenshot --default-background-color=00000000 --window-size=660,388` 截一张
   `width:660px` 的原图，透明底）。
3. **头图 URL 与所有相对链接都钉在默认分支（`main`）上** ⇒ **发版前必须先把 `dev` 合进
   `main`**，否则 Marketplace 上头像裂、文档链接指向旧内容。

## 3. 包里有什么、没什么

进包：`package.json`、`out/**`、`media/**`（除下一行）、`README.md`、`CHANGELOG.md`、
`LICENSE`、`THIRD_PARTY_NOTICES.md`。

**`media/dsh-live/**` 当前是进包的**（2026-09-24 拍板，`.vscodeignore` 末尾那行被注释掉了）——
它是 DSH 构建产物（内含 `@deepseek-ai` 组件实现，MIT、归属已写在 `THIRD_PARTY_NOTICES.md`），
仓库本身 gitignore 它（公开仓不带 5.4 MB 构建产物），但发布包里带，好处是**装完即得
「真 DSH 组件画面」，不用使用者自己重建**。

它只决定观感、不影响功能：缺失时扩展自动退回 VS Code 观感，其余一个不少（手册里有重建方法）。
所以这是一个可以随时翻的开关 —— 要发一个不带它的包，把那一行的注释去掉重新打包即可（−5.4 MB）。

## 4. 发版 checklist

1. 改 `package.json` 的 `version`（Marketplace **不允许**重复版本号；`0.0.x` 随便跳）。
2. `npm run compile`，然后**跑全套探针**（[scripts/](../scripts/)，F5 前的老规矩）。
3. 按上面 §1 打包。
4. **先把 `dev` 合进 `main`**（§2.3），再上传。
5. 上传，二选一：
   - **网页**：<https://marketplace.visualstudio.com/manage> → 选中 publisher → **New
     extension → Visual Studio Code** → 把 `.vsix` 拖上去。（这条不用 PAT。）
   - **命令行**：`vsce publish`（要 PAT，见 §5）。注意 `vsce publish` 会自己跑一遍
     `vscode:prepublish`（= `npm run compile`）。
6. 建一个 GitHub **Release**，把 `.vsix` 当附件挂上去（README「安装」一节指的就是它）——
   没有 Marketplace 账号的人靠这个装。
7. 回 `dev` 继续干。

## 5. 万一要走命令行（PAT）

Azure DevOps → User settings → Personal access tokens → New Token：

- **Organization 选 `All accessible organizations`**（选单个组织是 401/403 的头号原因）；
- **Scopes 选 Custom defined → Show all scopes → 只勾 `Marketplace → Manage`**。

⚠️ **PAT 绝不入库、绝不粘进对话或 issue**：它等价于你账号的发布权。本机存它只该存在于
vsce 自己的凭据里（`vsce login <publisher>`）。另外 Azure DevOps 已公布 **global PAT 于
2026-12-01 退场**，之后走 Entra ID + workload identity federation ⇒ 长期看命令行这条路
会越来越依赖 Azure 订阅。这也是「先用网页上传」更耐用的原因。

> `DEEPSEEK_API_KEY` 与本文件无关：它只进子进程环境变量和 VS Code SecretStorage，
> 见手册的「开发与安全提示」。
