# magpie-middleware-antigravity-identity

[简体中文](README.md) | **English**

Third-party clients behind any Antigravity-reverse-proxying provider, on Antigravity, as [magpie](https://usemagpie.ai) gateway middleware.

A client such as DSH (DeepSeek Harness), OpenCode, Claude Code or Codex puts its own name in the system prompt it sends. When that request is routed through a provider that reverse-proxies Antigravity to Antigravity, the prompt still says who wrote it, and Antigravity answers some of these with `429 Resource has been exhausted` however much quota is left — which the provider reads as a real quota running out and rests the account.

Such providers include CPA (CLIProxyAPI), new-api, one-api and self-hosted relays. magpie's built-in cloak only acts on an `antigravity` account, and these are usually custom providers reached by API key (`ctx.provider.account` is empty). This middleware runs on `onProvider` for such a provider and rewrites the system prompt just before the request leaves for it.

What it does:

- deletes Anthropic billing lines, `x-anthropic-billing-header: …`, which are metadata and not part of the prompt;
- replaces an opening identity declaration — `You are DSH.`, `You are opencode, …`, `You are Codex, a coding agent based on GPT-5.`, `You are Hermes Agent, …`, `You are Claude Code, …`, `你是…开发的助手` — with one official Antigravity identity line.

What it leaves alone:

- code: fenced blocks, indented code, inline code spans and their contents, verbatim;
- tool rules, safety constraints and anything after a comma or a new sentence;
- user and assistant history: only `system` / `developer` / `instructions` text is touched;
- security-policy text such as "Assist with authorized security testing".

It needs a magpie with the `onProvider` hook (v0.1.1283 or later): an older magpie loads it and never calls it, so requests go as they came.

## Install

```sh
magpie plugin add github:MatrixC7/magpie-antigravity-identity
```

Then put your provider's id in the options — the default is `cli-proxy-api`; another reverse proxy takes its own id:

```sh
magpie plugin options magpie-antigravity-identity '{"providers":["<your provider id>"]}'
```

Restart magpie and check it is running on the GUI's Plugins page (see "Is it working?").

## Before you turn it on

- This changes what Google is sent so that a request it means to refuse isn't refused. It may be against Antigravity's terms, and Google can ban the account for it. Use it on an account you can afford to lose.
- Google can change what it matches at any time. Then the refusal comes back, and magpie may no longer recognise it as this refusal: it can read as a real quota running out and rest the account.
- Only an opening identity line is handled. A client's name in a tool name, a skill id, a path or a later sentence is not touched — renaming those would break tool calls.

## Is it working?

Two layers: the **text** (what it would do to a prompt) and the **calls** (whether magpie is running it at all).

### 1. Before installing: the text result

```sh
node check.mjs
```

Runs the middleware over a set of sample prompts and prints each input and output. With your own text:

```sh
node check.mjs prompt.txt          # show before/after
node check.mjs prompt.txt --diff   # show only the changed lines
```

Reads a local file only; no network, no account. It tells you whether the text-level result is right, but it does not prove magpie is calling it.

### 2. After installing: the calls — GUI only

**Open magpie's Plugins page and find this plugin's card.** It shows:

```
21 calls, 10891 µs each
```

plus a failure count when there are any.

**Why not the command line?** `calls` / `avgMicros` / `failures` in `magpie plugin list --json` are **always 0**. This is not a bug: the counters live in the **gateway process's memory** (Go `atomic.Int64`), and every `magpie` command starts a **new process** that has never run a hook, so it reads 0. The GUI is served by the gateway process itself, so it sees the real values.

For the same reason the counters reset when magpie restarts — they are not persisted.

### 3. Reading those two numbers

| What you see | What it means |
|---|---|
| `calls` stays at 0 | The hook loaded but never ran. Check the plugin is not off and `off` is not `true` |
| `calls` grows, but `µs each` is tiny (< 10 µs) | The hook ran but `shouldRun` returned early. Almost always `providers` / `models` did not match |
| `calls` grows, `µs each` is tens to hundreds of µs | It is really parsing and rewriting text |

For scale: a request with a ~400K context taking about **10 ms** (10,000 µs) is normal — the time goes into JSON parsing and the line scan.

### 4. After installing: is the provider id and model name right?

```sh
magpie providers                  # every provider and its id
magpie provider cli-proxy-api     # one provider's model list
```

Compare your provider's id against `providers` in the options. If they differ, the middleware loads and is never called: nothing in the request changes and no error is reported.

Model names are covered in the next section.

## Only for models served by Antigravity

Such a provider usually proxies several sources at once: Antigravity, Codex, and various third-party endpoints. By default this middleware acts on **every** request through that provider, which may not be what you want.

**magpie cannot know who the provider routed the request to internally.** `ctx.provider` carries only `id` / `name` / `account` / `model`; to magpie, it is just an HTTP endpoint. Its `/v1/models` returns names only, without provenance.

The model name is the one reliable, visible signal, so limit with the `models` allowlist:

```json
{
  "providers": ["cli-proxy-api"],
  "models": ["gemini-3.8-flash-high", "gemini-4-argon-high"]
}
```

### Finding the Antigravity model names

First, see the models a provider exposes:

```sh
magpie provider cli-proxy-api
```

Its output looks like:

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

Pick the ones Antigravity serves.

Take the provider's exclusion list as the guide — CPA's config, for instance, has `excluded-models.antigravity`: those are the **excluded** ones, and what is not listed there is usually what Antigravity serves.

### The name you list carries no provider prefix

The `cli-proxy-api/gemini-3.8-flash-high` shown above is magpie's **full model id** (provider id, a slash, then the model name). The middleware receives the **bare model name after the slash**:

| Where | Value |
|---|---|
| `magpie provider cli-proxy-api` shows | `cli-proxy-api/gemini-3.8-flash-high` |
| `ctx.provider.model` in the middleware | `gemini-3.8-flash-high` |

So list the **bare** name in `models`; do not add the `cli-proxy-api/` prefix.

These are two different fields in magpie's `provider.Entry`:

```go
ID    string `json:"id"`    // what the agent sends magpie
Model string `json:"model"` // what magpie sends the vendor
```

`provider.Resolve` returns the latter.

### It is not the alias the client wrote

`models` is matched against the model name magpie resolves and sends to the provider, not an alias in the client's request. If your client routes through an alias like `group/flash` while the provider receives `gemini-3.8-flash-high`, list the **latter**.

### `models: []` disables the whole middleware

The easiest trap:

| Configuration | Behaviour |
|---|---|
| `models` not present | every model is handled |
| `"models": []` | **nothing is handled** (an empty array matches no model) |
| `"models": ["x"]` | only `x` is handled |

Either leave the field out entirely, or list concrete model names. Never leave it as an empty array.

### List only the models you actually use

You do not need every Antigravity model. List the ones you really send through that provider and that carry the identity-leak risk:

```json
{
  "providers": ["cli-proxy-api"],
  "models": ["gemini-4-argon-high"]
}
```

Other models (Codex, DeepSeek, …) are left alone — they are not served by Antigravity and do not need this.

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

- `providers`: provider ids it acts on. Default `["cli-proxy-api"]`, the id CPA usually has in magpie; another reverse proxy takes its own id here.
- `accounts`: subscription kinds it acts on, for a provider logged in directly. Empty by default: a provider reached by API key is matched by id. Set `["antigravity"]` to also act on a direct Antigravity account.
- `models`: exact model allowlist; see "Filter order" below and "Only for models served by Antigravity". **Do not leave it as an empty array** — that disables the whole middleware.
- `sanitizeBrands`: also replace competitor brand words with `Google`. Off by default because it is lossy — it rewrites API names, hostnames and model ids in prose too.
- `cloakFallbackWords`: extra words to break with a zero-width space (U+200B) instead of replacing. Empty by default.
- `off`: leave every request as it came.

### Filter order

The three filters are not peers; they are checked in this order:

```
1. off === true?                  → skip
2. providers or accounts match?   → neither matches: skip
3. models match?                  → no match: skip
4. handle
```

In detail:

- **`providers` and `accounts` are OR'd**: a provider id match, or an account kind match, is enough. This covers both ways a provider is reached — an API-key provider matched by id, and a directly signed-in subscription matched by account kind.
- **`models` is AND'd**: it is only checked once the previous step matched.
- **`models` absent = no filtering**; `models: []` = nothing matches.

Examples:

| providers | accounts | models | Result |
|---|---|---|---|
| `["cli-proxy-api"]` | `[]` | absent | every model of that provider |
| `["cli-proxy-api"]` | `[]` | `["gemini-3-flash"]` | that model only |
| `["cli-proxy-api"]` | `["antigravity"]` | absent | that provider **or** a direct Antigravity account |
| `[]` | `[]` | absent | nothing at all |

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
