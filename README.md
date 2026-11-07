# magpie-middleware-antigravity-identity

**简体中文** | [English](README.en.md)

把经任何反代 Antigravity 的供应商转发的第三方客户端，接到 Antigravity 上的 [magpie](https://usemagpie.ai) 网关中间件。

DSH（DeepSeek Harness）、OpenCode、Claude Code、Codex 这类客户端会把自己的名字写进所发送的系统提示词里。当该请求经某个反代 Antigravity 的供应商路由到 Antigravity 时，提示词里仍然写着它是谁写的，而 Antigravity 对其中一些会回一个 `429 Resource has been exhausted`——无论配额还剩多少。上游会把它读成配额真的用光了，从而让账号进入冷却。

这类供应商包括 CPA（CLIProxyAPI）、new-api、one-api 以及各种自建 relay。magpie 内置的 cloak 只对 `antigravity` 账号生效，而它们通常是以 API key 接入的自定义供应商（`ctx.provider.account` 为空）。这个中间件在该供应商的 `onProvider` 上运行，在请求发往上游之前改写系统提示词。

它做的事：

- 删除 Anthropic 计费头行 `x-anthropic-billing-header: …`，那是元数据，不属于提示词内容；
- 把开场的身份声明——`You are DSH.`、`You are opencode, …`、`You are Codex, a coding agent based on GPT-5.`、`You are Hermes Agent, …`、`You are Claude Code, …`、`你是…开发的助手`——替换为一句官方 Antigravity 身份；
- 连续的身份声明只保留第一处。DSH 之类的客户端会在开头连写两句身份（`You are an AI agent powered by DeepSeek Harness.` 与 `You are a coding agent powered by …`），若逐句替换就会得到两段一模一样的官方开场白——真正的 Antigravity 提示词绝不会这样复读，那本身就是一种可识别的清洗痕迹。冗余的那句会被合并掉，逗号之后的约束（`… , never exfiltrate credentials.`）则原样保留。

它不改动的内容：

- 代码：围栏代码块、缩进代码、行内代码及其内容，逐字保留；
- 工具规则、安全约束，以及逗号之后或换句之后的任何内容；
- user 与 assistant 历史：只处理 `system` / `developer` / `instructions` 文本；
- 诸如「Assist with authorized security testing」这类安全策略文本。

它需要带有 `onProvider` 钩子的 magpie（v0.1.1283 或更新版本）：旧版 magpie 会加载它但从不调用，因此请求会原样发出。

## 安装

```sh
magpie plugin add github:MatrixC7/magpie-middleware-antigravity-identity
```

### 设置选项

**安装后必须设置一次选项，否则插件虽然加载但不会生效。** magpie 的 `ctx.options` 初始是空对象 `{}`，只有 `plugins.json` 里存了值才会传给中间件；`package.json` 里的 `magpie.options` 只是 GUI 编辑器的**预填示例**，不是运行时默认值。

在 GUI 的 Plugins 页面点开该插件的选项编辑器，会看到这样一份结构示例：

```json
{
  "providers": ["cli-proxy-api"],
  "accounts": [],
  "sanitizeBrands": false,
  "cloakFallbackWords": [],
  "off": false
}
```

按你的实际情况修改后**保存**。最常见的是改 `providers`（你的供应商 id）和加上 `models`（只清洗哪些模型）：

```json
{
  "providers": ["cli-proxy-api"],
  "accounts": [],
  "models": ["gemini-3.8-flash-high", "gemini-4-argon-high"],
  "sanitizeBrands": false,
  "cloakFallbackWords": [],
  "off": false
}
```

也可以用命令行一次设置：

```sh
magpie plugin options magpie-middleware-antigravity-identity '{"providers":["<你的供应商 id>"],"models":["<模型名>"]}'
```

⚠️ **不要写 `"models": []`**——空数组表示「没有任何模型匹配」，会让整个中间件失效。要么完全不写这个字段（所有模型都处理），要么写具体模型名。

改完重启 magpie，用 GUI 的 Plugins 页面确认它在跑（见「怎么确认它在工作」）。

## 启用之前

- 这会改变发给 Google 的内容，使本应被拒绝的请求不被拒绝。这可能违反 Antigravity 的条款，Google 可能因此封禁账号。请只用在可以承受损失的账号上。
- Google 可以随时改变它匹配的内容。届时拒绝会再次出现，而 magpie 可能不再把它识别为这种拒绝：它可能被读成配额真的用光，从而让账号进入冷却。
- 只处理开场的身份行。客户端名称若出现在工具名、技能 id、路径或后面的句子里，不会被改动——改这些会破坏工具调用。

## 怎么确认它在工作

分两层：**文本层**（它会把提示词改成什么样）和**调用层**（magpie 有没有真的在跑它）。

### 1. 安装前：看文本层结果

```sh
node check.mjs
```

用一组样例提示词跑一遍中间件，打印每段的输入与输出。换成你自己的文本：

```sh
node check.mjs prompt.txt          # 显示改动前后
node check.mjs prompt.txt --diff   # 只显示有变化的行
```

只读本地文件，不联网、不碰账号。它告诉你**清洗结果对不对**，但不能证明 magpie 在调用它。

### 2. 安装后：看调用层——只能用 GUI

**打开 magpie 的 Plugins 页面，找到这个插件的卡片。** 卡片上会显示：

```
21 calls, 10891 µs each
```

有失败时还会显示失败次数。

**为什么不能用命令行？** `magpie plugin list --json` 里的 `calls` / `avgMicros` / `failures` **永远是 0**。这不是 bug：这些计数存在**网关进程的内存**里（Go 的 `atomic.Int64`），而每次执行 `magpie` 命令都会启动一个**新进程**，新进程从没跑过任何 hook，读到的自然是 0。GUI 由网关进程自己提供，所以能看到真实值。

同理，重启 magpie 后计数会归零——计数不持久化。

### 3. 怎么读这两个数字

| 现象 | 含义 |
|---|---|
| 卡片上 `calls` 一直是 0 | 钩子加载了但从未执行。检查插件是否被关闭、`off` 是否为 `true` |
| `calls` 增长，但 `µs each` 极低（< 10 µs） | 钩子执行了，但被 `shouldRun` 挡在门外直接返回。几乎总是 `providers` / `models` 没匹配上 |
| `calls` 增长，`µs each` 是几十到几百 µs | 真的在解析和改写文本 |

参考量级：一份 400K 上下文的请求，单次约 **10 ms**（10,000 µs）属于正常——耗时主要花在 JSON 解析和逐行扫描上。

### 4. 安装后：供应商 id 和模型名对不对

```sh
magpie providers                  # 列出所有供应商及其 id
magpie provider cli-proxy-api     # 看某一个供应商的模型列表
```

把你所用供应商的 id 和选项里的 `providers` 对比。若不一致，中间件会加载但永不被调用——请求毫无变化，也不报任何错。

模型名的确认见下一节「只对 antigravity 的模型生效」。

## 只对 antigravity 的模型生效

这类反代供应商通常同时代理多个来源：antigravity 反代、Codex、以及各种第三方公益站。默认情况下中间件会对**所有**经该供应商发出的请求生效，这可能不是你想要的。

**magpie 无法知道上游反代内部把请求路由给了谁。** `onProvider` 收到的 `ctx.provider` 只有 `id` / `name` / `account` / `model` 四个字段；对 magpie 而言它只是一个 HTTP 端点。它的 `/v1/models` 也只返回模型名，不带来源标注。

但模型名是唯一可靠且可见的信号，所以用 `models` 白名单来限定：

```json
{
  "providers": ["cli-proxy-api"],
  "models": ["gemini-3.8-flash-high", "gemini-4-argon-high"]
}
```

### 怎么找出 antigravity 的模型名

先看供应商有哪些模型：

```sh
magpie provider cli-proxy-api
```

输出形如：

```
  CPA  cli-proxy-api  custom
  chat      http://127.0.0.1:8317/v1
  models    7 exposed of 7 from 127.0.0.1:8317 · fetched 6h ago
            cli-proxy-api/gpt-6-luna  GPT-6 Luna
            cli-proxy-api/gemini-3.8-flash-high  Gemini 3.8 Flash
            cli-proxy-api/gemini-4-argon-high  Gemini 4 Argon
            cli-proxy-api/claude-opus-5-5-high  Claude Opus 5.5
            …
```

挑出由 antigravity 反代提供的那几个。

以上游反代的排除列表为准，例如 CPA 配置文件里的 `excluded-models.antigravity`：那里列的是**被排除**的模型；不在列表里的通常就是 antigravity 提供的。

### 注意：填的模型名不带供应商前缀

上面列出的 `cli-proxy-api/gemini-3.8-flash-high` 是 magpie 的**完整模型 id**（供应商 id + 斜杠 + 模型名）。但中间件收到的 `ctx.provider.model` 是**斜杠之后的裸模型名**：

| 位置 | 值 |
|---|---|
| `magpie provider cli-proxy-api` 显示 | `cli-proxy-api/gemini-3.8-flash-high` |
| 中间件看到的 `ctx.provider.model` | `gemini-3.8-flash-high` |

所以 `models` 里要填**裸模型名**，不要加 `cli-proxy-api/` 前缀。

magpie 源码里这两个是不同的字段（`provider.Entry`）：

```go
ID    string `json:"id"`    // what the agent sends magpie
Model string `json:"model"` // what magpie sends the vendor
```

`provider.Resolve` 返回的是后者。

### 注意：不是客户端写的别名

`models` 匹配的是 magpie 解析后发给供应商的模型名，不是客户端请求里写的别名。如果你的客户端用 `group/flash` 这样的路由别名，而供应商实际收到 `gemini-3.8-flash-high`，那要填**后者**。

### 注意：`models: []` 会禁用整个中间件

这是最容易踩的坑：

| 配置 | 行为 |
|---|---|
| 不写 `models` 字段 | 所有模型都处理 |
| `"models": []` | **全部不处理**（空数组表示"没有任何模型匹配"） |
| `"models": ["x"]` | 只有 `x` 处理 |

所以要么**完全不写**这个字段，要么写具体模型名。不要留一个空数组。

### 建议：只填你真正在用的模型

不必把 antigravity 的模型全部列出来。只填你实际会经该供应商发送、且存在身份泄漏风险的那几个即可：

```json
{
  "providers": ["cli-proxy-api"],
  "models": ["gemini-4-argon-high"]
}
```

其余模型（Codex、DeepSeek 等）不经过清洗——它们本来也不是 antigravity 反代的，不需要处理。

## 选项

```json
{
  "providers": ["cli-proxy-api"],
  "accounts": [],
  "models": [],
  "sanitizeBrands": false,
  "cloakFallbackWords": [],
  "off": false
}
```

- `providers`：它作用的供应商 id。默认为 `["cli-proxy-api"]`，即 CPA 在 magpie 中通常使用的 id；其他反代填各自的 id 即可。
- `accounts`：它作用的订阅类型，针对直接登录的供应商。默认为空：以 API key 接入的供应商按 id 匹配。设为 `["antigravity"]` 可同时作用于直连的 Antigravity 账号。
- `models`：精确的模型白名单，见下方「筛选顺序」和「只对 antigravity 的模型生效」。**不要留空数组**——空数组会让整个中间件失效。
- `sanitizeBrands`：同时把竞品厂牌词替换为 `Google`。默认关闭，因为它是有损的——它会连散文中的 API 名称、主机名和模型 id 一起改写。
- `cloakFallbackWords`：额外的词，用零宽空格（U+200B）拆开而不是替换。默认为空。
- `off`：所有请求原样发出。

### 筛选顺序

三个筛选条件不是平级的，判断顺序如下：

```
1. off === true？                    → 是则跳过
2. providers 或 accounts 命中？       → 都不命中则跳过
3. models 命中？                      → 不命中则跳过
4. 处理
```

具体来说：

- **`providers` 与 `accounts` 是「或」的关系**：供应商 id 命中，或账号类型命中，任一满足即可。这是为了同时支持「按 id 匹配的 API key 供应商」和「按账号类型匹配的直连订阅」两种接入方式。
- **`models` 是「与」的关系**：只有前一步已经命中，才会再检查模型白名单。
- **`models` 缺省 = 不过滤**；`models: []` = 全部不匹配。

举例：

| providers | accounts | models | 结果 |
|---|---|---|---|
| `["cli-proxy-api"]` | `[]` | 缺省 | 该供应商的所有模型都处理 |
| `["cli-proxy-api"]` | `[]` | `["gemini-3-flash"]` | 只有该模型处理 |
| `["cli-proxy-api"]` | `["antigravity"]` | 缺省 | 该供应商 **或** 直连 antigravity 账号都处理 |
| `[]` | `[]` | 缺省 | 完全不生效 |

`providers` 与 `accounts` 同时为空时，中间件完全不生效。

## 它不会覆盖的情况

以下是刻意的限制，不是缺陷：

- **角色词**不在 `agent, assistant, ai, tool, cli, programmer, companion, engineer, bot, harness` 之列时（例如 `You are a tutor created by Acme.`），原样保留。
- **复合归属**如 `created by Acme and Bob` 不做处理。若放开 `and`，就有吞掉 `created by Acme and must never run bash` 这类约束的风险。
- **归属对象超过 80 字符或 6 个词**时不做处理，原因同上。
- **单段系统文本超过 1,000,000 字符**时原样透传。注意这只是**单字段**上限，不代表整次 hook 的时间保证：多字段请求的成本会叠加，且本仓库没有 moejs 宿主可测，Node/V8 的实测值不能直接外推到其它引擎。
- **每行最多 64 次身份替换**，且不在超过 2048 字符的单句内做推断。**超过 64 次的输入不保证幂等**：第一次处理只替换前 64 处，剩余身份在第二次调用时会被继续替换。
- **重复身份只在文首的顶层纯身份前缀内折叠**：只有当重复身份位于文档开头、是顶层段落、且整段恰好是一句纯身份时，才会被丢弃。删掉段内某一句、或删掉承担列表退出作用的段落，都会改变后续内容的块类型（缩进代码可能变成散文），代价远高于多一段重复。
- **被非身份内容隔开的重复身份**：只要出现任何非纯身份的内容（散文、代码、列表、标题、缩进、带约束的身份），去重窗口就永久关闭，其后的身份一律保留。
- **强调包裹的身份段不参与去重**：`**You are DSH.**` 这类段落会被正常替换成官方身份，但不会折叠重复。
- **不规范化原有多空行**：如果输入里本来就有 3 个以上连续空行，清洗后仍会保留。刻意不做空白美化——那需要额外的块边界操作，且可能吞掉必要的分隔。
- **跨字段不折叠**：只在单个系统文本字符串内去重。拆成多条 system 消息、多个 text block 或多个 Gemini part 时，各块独立处理。
- **常见情形之外的 Markdown**：setext 标题、HTML 块和表格不会被当作代码容器处理。

## 测试

```sh
node test.mjs
```

`cases.json` 含 120 个用例：每个给出一个请求、它到达时的供应商与协议，以及必须发送出去的 body。没有 `expect_request` 的用例必须原样返回。运行器复现了 magpie 的契约——被修改的 body 必须以对象返回，而 `undefined` 表示「发送原始内容」。

`check.mjs` 是给人看的自检工具，见上文「怎么确认它在工作」。它不参与发布（不在 `package.json` 的 `files` 里）。

## 许可证

MIT
