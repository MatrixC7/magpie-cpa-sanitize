# magpie-middleware-cpa-sanitize

[简体中文](README.md) | **English**

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

## Is it working?

Three checks, from cheapest to most conclusive.

### 1. Before installing: what it would do to your prompt

```sh
node check.mjs
```

Runs the middleware over a set of sample prompts and shows each input and output. With your own text:

```sh
node check.mjs prompt.txt          # show before/after
node check.mjs prompt.txt --diff   # show only the changed lines
```

This reads a local file only. It tells you what the text-level result is; it does not prove magpie is calling it.

### 2. After installing: is magpie calling it?

```sh
magpie plugin list --json
```

Under `middleware`, keyed by the plugin's spec, look for:

| Field | What to expect |
|---|---|
| `hooks` | `["onProvider"]` — the hook it registered |
| `error` | absent; a value here means it did not load |
| `calls` | rises with each request sent through the gateway |
| `avgMicros` | average time per call, in microseconds |
| `failures` | should stay 0 |

The GUI shows the same thing on the Plugins page, on the plugin's card: `N calls, X µs each`, plus a failure count when there are any.

**`calls` staying at 0 while you are sending requests is the signal that matters.** It means the hook is loaded but `shouldRun` never matched — almost always because the provider id is not the one in `providers`.

### 3. After installing: is the provider id right?

```sh
magpie provider list
```

Compare the id of your CPA provider against `providers` in the options. If they differ, the middleware loads and is never called; nothing in the request changes and no error is reported. Set the real id:

```sh
magpie plugin options <plugin> '{"providers":["<your provider id>"]}'
```

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

`check.mjs` is the human-facing self-check described above; it is not part of the published package (it is not in `files`).

## License

MIT
