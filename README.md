# magpie-middleware-cpa-sanitize

**简体中文** | [English](README.en.md)

把经 CLIProxyAPI 转发的第三方客户端，接到 Antigravity 上的 [magpie](https://usemagpie.ai) 网关中间件。

DSH（DeepSeek Harness）、OpenCode、Claude Code、Codex 这类客户端会把自己的名字写进所发送的系统提示词里。当该请求经 CLIProxyAPI（CPA）路由到 Antigravity 时，提示词里仍然写着它是谁写的，而 Antigravity 对其中一些会回一个 `429 Resource has been exhausted`——无论配额还剩多少。CPA 会把它读成配额真的用光了，从而让账号进入冷却。

magpie 内置的 cloak 只对 `antigravity` 账号生效，而 CPA 是以 API key 接入的自定义供应商（`ctx.provider.account` 为空）。这个中间件在 CPA 供应商的 `onProvider` 上运行，在请求发往 CPA 之前改写系统提示词。

它做的事：

- 删除 Anthropic 计费头行 `x-anthropic-billing-header: …`，那是元数据，不属于提示词内容；
- 把开场的身份声明——`You are DSH.`、`You are opencode, …`、`You are Codex, a coding agent based on GPT-5.`、`You are Hermes Agent, …`、`You are Claude Code, …`、`你是…开发的助手`——替换为一句官方 Antigravity 身份。

它不改动的内容：

- 代码：围栏代码块、缩进代码、行内代码及其内容，逐字保留；
- 工具规则、安全约束，以及逗号之后或换句之后的任何内容；
- user 与 assistant 历史：只处理 `system` / `developer` / `instructions` 文本；
- 诸如「Assist with authorized security testing」这类安全策略文本。

它需要带有 `onProvider` 钩子的 magpie（v0.1.1283 或更新版本）：旧版 magpie 会加载它但从不调用，因此请求会原样发出。

## 启用之前

- 这会改变发给 Google 的内容，使本应被拒绝的请求不被拒绝。这可能违反 Antigravity 的条款，Google 可能因此封禁账号。请只用在可以承受损失的账号上。
- Google 可以随时改变它匹配的内容。届时拒绝会再次出现，而 magpie 可能不再把它识别为这种拒绝：它可能被读成配额真的用光，从而让账号进入冷却。
- 只处理开场的身份行。客户端名称若出现在工具名、技能 id、路径或后面的句子里，不会被改动——改这些会破坏工具调用。

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

- `providers`：它作用的供应商 id。默认为 `["cli-proxy-api"]`，即 CPA 供应商在 magpie 中通常使用的 id。
- `accounts`：它作用的订阅类型，针对直接登录的供应商。默认为空：CPA 供应商按 id 匹配。设为 `["antigravity"]` 可同时作用于直连的 Antigravity 账号。
- `models`：精确的模型白名单。缺省或为空表示所有模型。
- `sanitizeBrands`：同时把竞品厂牌词替换为 `Google`。默认关闭，因为它是有损的——它会连散文中的 API 名称、主机名和模型 id 一起改写。
- `cloakFallbackWords`：额外的词，用零宽空格（U+200B）拆开而不是替换。默认为空。
- `off`：所有请求原样发出。

`providers` 与 `accounts` 同时为空时，中间件完全不生效。

## 它不会覆盖的情况

以下是刻意的限制，不是缺陷：

- **角色词**不在 `agent, assistant, ai, tool, cli, programmer, companion, engineer, bot, harness` 之列时（例如 `You are a tutor created by Acme.`），原样保留。
- **复合归属**如 `created by Acme and Bob` 不做处理。若放开 `and`，就有吞掉 `created by Acme and must never run bash` 这类约束的风险。
- **归属对象超过 80 字符或 6 个词**时不做处理，原因同上。
- **单段系统文本超过 1,000,000 字符**时原样透传，使钩子不会撞上 magpie 的 250 毫秒上限。这远高于真实系统提示词的长度。
- **每行最多 64 次身份替换**，且不在超过 2048 字符的单句内做推断。
- **常见情形之外的 Markdown**：setext 标题、HTML 块和表格不会被当作代码容器处理。

## 测试

```sh
node test.mjs
```

`cases.json` 含 94 个用例：每个给出一个请求、它到达时的供应商与协议，以及必须发送出去的 body。没有 `expect_request` 的用例必须原样返回。运行器复现了 magpie 的契约——被修改的 body 必须以对象返回，而 `undefined` 表示「发送原始内容」。

## 许可证

MIT
