# magpie-middleware-cpa-sanitize

Third-party clients behind CLIProxyAPI, on Antigravity, as [magpie](https://usemagpie.ai) gateway middleware.

A client such as DSH (DeepSeek Harness), OpenCode, Claude Code or Codex puts its own name in the system prompt it sends. When that request is routed through CLIProxyAPI (CPA) to Antigravity, the prompt still says who wrote it, and Antigravity answers some of these with `429 Resource has been exhausted` however much quota is left — which CPA reads as a real quota running out and rests the account.

magpie's built-in cloak only acts on an `antigravity` account, and CPA is a custom provider reached by API key (`ctx.provider.account` is empty). This middleware runs on `onProvider` for a CPA provider and rewrites the system prompt just before the request leaves for CPA.

What it does:

- deletes Anthropic billing lines, `x-anthropic-billing-header: …`, which are metadata and not part of the prompt;
- replaces an opening identity declaration — `You are DSH.`, `You are opencode, …`, `You are Codex, a coding agent based on GPT-5.`, `You are Hermes Agent, …`, `You are Claude Code, …`, `你是…开发的助手` — with one official Antigravity identity line.

What it leaves alone:

- code: fenced blocks, indented code, inline code spans and their contents, verbatim;
- tool rules, safety constraints and anything after a comma or a new sentence;
- user and assistant history: only `system` / `developer` / `instructions` text is touched;
- security-policy text such as "Assist with authorized security testing".

It needs a magpie with the `onProvider` hook (v0.1.1283 or later): an older magpie loads it and never calls it, so requests go as they came.

## Before you turn it on

- This changes what Google is sent so that a request it means to refuse isn't refused. It may be against Antigravity's terms, and Google can ban the account for it. Use it on an account you can afford to lose.
- Google can change what it matches at any time. Then the refusal comes back, and magpie may no longer recognise it as this refusal: it can read as a real quota running out and rest the account.
- Only an opening identity line is handled. A client's name in a tool name, a skill id, a path or a later sentence is not touched — renaming those would break tool calls.

## Options

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

- `providers`: provider ids it acts on. Default `["cli-proxy-api"]`, the id a CPA provider usually has in magpie.
- `accounts`: subscription kinds it acts on, for a provider logged in directly. Empty by default: a CPA provider is matched by id. Set `["antigravity"]` to also act on a direct Antigravity account.
- `models`: exact model allowlist. Absent or empty means every model.
- `sanitizeBrands`: also replace competitor brand words with `Google`. Off by default because it is lossy — it rewrites API names, hostnames and model ids in prose too.
- `cloakFallbackWords`: extra words to break with a zero-width space (U+200B) instead of replacing. Empty by default.
- `off`: leave every request as it came.

An empty `providers` and `accounts` together disable it entirely.

## What it will not catch

These are deliberate limits, not defects:

- **Role words** outside `agent, assistant, ai, tool, cli, programmer, companion, engineer, bot, harness` (e.g. `You are a tutor created by Acme.`) are left as they are.
- **Compound owners** such as `created by Acme and Bob` are left alone. Opening up `and` would risk swallowing a constraint like `created by Acme and must never run bash`.
- **Owners longer than 80 characters or 6 words** are left alone, for the same reason.
- **A single system text over 1,000,000 characters** is passed through untouched, so a hook never runs into magpie's 250 ms limit. That is far above a real system prompt.
- **At most 64 identity replacements per line**, and no inference in a single sentence over 2048 characters.
- **Markdown beyond the common cases**: setext headings, HTML blocks and tables are not modelled as code containers.

## Tests

```sh
node test.mjs
```

`cases.json` holds 94 cases: each gives a request, the provider and protocol it arrives on, and the body that must be sent. A case with no `expect_request` must come back unchanged. The runner reproduces magpie's contract — a changed body must be returned as an object, and `undefined` means "send the original".

## 中文

DSH（DeepSeek Harness）、OpenCode、Claude Code、Codex 这类客户端会把自己的名字写进系统提示词。请求经 CLIProxyAPI（CPA）转到 Antigravity 时，提示词里仍带着这些身份，Antigravity 对其中一些会回一个假的 `429 Resource has been exhausted`，CPA 会当成配额真的用光，从而让账号进入冷却。

magpie 内置的 cloak 只对 `antigravity` 账号生效，而 CPA 是以 API key 接入的自定义供应商（`ctx.provider.account` 为空）。这个中间件在 `onProvider` 上针对 CPA 供应商工作，在请求发出前改写系统提示词。

它做两件事：

- 删除 Anthropic 的计费头行 `x-anthropic-billing-header: …`，那是元数据，不属于提示词内容；
- 把开场的身份声明（`You are DSH.`、`You are opencode, …`、`You are Codex, a coding agent based on GPT-5.`、`You are Hermes Agent, …`、`You are Claude Code, …`、`你是…开发的助手`）替换为一句官方 Antigravity 身份。

它不会改动：代码块与行内代码（逐字保留）、工具规则与安全约束、逗号之后或换句之后的任何内容、user/assistant 历史，以及 "Assist with authorized security testing" 这类安全策略文本。

**风险提示**：这样做会改变发给 Google 的内容，使本应被拒绝的请求不被拒绝，可能违反 Antigravity 的条款并导致账号被封，请只用在可以承受损失的账号上。Google 也可能随时改变匹配规则。

**已知边界**（有意为之，非缺陷）：白名单之外的角色词、`created by Acme and Bob` 这类复合归属、超过 80 字符或 6 词的归属对象、单段超过 100 万字符的输入，以及 setext 标题 / HTML 块 / 表格这些 Markdown 结构，都不做处理。

## License

MIT
