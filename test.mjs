// Standalone runner for cases.json — no external dependencies.
// Mirrors how magpie's middleware harness treats a case:
//   request  -> onProvider(body, ctx) -> undefined means "send the original"
//   expect_request  -> the body that must be sent
// A case with no expect_request must come back undefined (nothing changed).
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";

const dir = path.dirname(new URL(import.meta.url).pathname);
const middlewarePath = path.join(dir, "cpa-sanitize.middleware.js");
const casesPath = path.join(dir, "cases.json");

const source = fs.readFileSync(middlewarePath, "utf8");
const ctx = vm.createContext({});
vm.runInContext(source.replace(/^export /gm, ""), ctx, { timeout: 5000 });

const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
const clone = (v) => JSON.parse(JSON.stringify(v));

let passed = 0;
const failures = [];

for (const c of cases) {
  try {
    const body = clone(c.request);
    const before = JSON.stringify(body);
    const ctxObj = {
      protocol: (c.ctx && c.ctx.protocol) || "anthropic",
      model: (c.request && c.request.model) || "m",
      stream: false,
      path: "/v1/messages",
      options: c.options || {},
      state: {},
    };
    if (c.provider !== undefined) ctxObj.provider = c.provider;

    ctx.body = body;
    ctx.ctx = ctxObj;
    const returned = vm.runInContext("onProvider(body, ctx)", ctx, { timeout: 5000 });

    if (returned === null) throw new Error("onProvider returned null");
    if (returned !== undefined && (typeof returned !== "object" || Array.isArray(returned))) {
      throw new Error("onProvider returned a non-object");
    }

    const after = JSON.stringify(ctx.body);
    if (after !== before && returned === undefined) {
      throw new Error("body changed but onProvider returned undefined (host would drop it)");
    }

    const sent = returned === undefined ? clone(c.request) : clone(ctx.body);

    if (c.expect_request === undefined) {
      if (returned !== undefined) throw new Error("expected no change, got a modified body");
    } else if (JSON.stringify(sent) !== JSON.stringify(c.expect_request)) {
      throw new Error(
        "sent body mismatch\n  got:  " + JSON.stringify(sent) + "\n  want: " + JSON.stringify(c.expect_request)
      );
    }
    passed++;
  } catch (e) {
    failures.push({ name: c.name, error: String(e.message || e) });
  }
}

console.log(JSON.stringify({ total: cases.length, passed, failed: failures.length, failures }, null, 2));
if (failures.length) process.exitCode = 1;
