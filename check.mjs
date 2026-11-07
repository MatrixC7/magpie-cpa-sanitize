// 自检工具：在安装到 magpie 之前/之后，确认这个中间件会对你的真实提示词做什么。
//
//   node check.mjs                     用内置样例跑一遍
//   node check.mjs prompt.txt          读一个文件里的系统提示词
//   node check.mjs prompt.txt --diff   同时打印逐行差异
//
// 只读本地文件，不联网，不接触任何账号。
import fs from "node:fs";
import path from "node:path";

const dir = path.dirname(new URL(import.meta.url).pathname);
const source = fs.readFileSync(path.join(dir, "cpa-sanitize.middleware.js"), "utf8");

// 在一个隔离的沙箱里加载中间件（moejs 里没有 vm，这里只是本机自检用）
const { createContext, runInContext } = await import("node:vm");
const ctx = createContext({});
runInContext(source.replace(/^export /gm, ""), ctx, { timeout: 5000 });

const sanitize = (text, options) => {
  ctx.__t = text;
  ctx.__o = options;
  return runInContext("sanitizeSystemText(__t, __o)", ctx, { timeout: 5000 });
};

const file = process.argv[2];
const wantDiff = process.argv.includes("--diff");

// 与插件默认值一致；可以用环境变量覆盖
const options = {
  providers: ["cli-proxy-api"],
  accounts: [],
  sanitizeBrands: process.env.SANITIZE_BRANDS === "true",
  cloakFallbackWords: [],
  off: false,
};

const samples = file
  ? [["你的提示词", fs.readFileSync(file, "utf8")]]
  : [
      ["DSH 全称", "You are an AI agent powered by DeepSeek Harness.\n\nYou are a coding agent powered by the cli-proxy-api/gemini-4-argon-high model."],
      ["DSH 缩写", "You are DSH."],
      ["OpenCode", "You are opencode, an interactive CLI tool that helps users with software engineering tasks."],
      ["Codex", "You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI."],
      ["Claude Code", "x-anthropic-billing-header: cc_version=2.1.280; cc_entrypoint=cli;\nYou are Claude Code, Anthropic's official CLI for Claude."],
      ["Hermes", "You are Hermes Agent, an intelligent AI assistant created by Nous Research."],
      ["中文", "你是深度求索开发的助手，基于DeepSeek大模型。请协助用户编写代码。"],
      ["代码保护（不该动）", "You are DSH.\n```json\n{\"agent\": \"You are Claude Code, built by Anthropic.\"}\n```"],
      ["工具规则（不该动）", "You are a coding agent\nThis tool was created by the user.\nNever use bash."],
      ["安全策略（不该动）", "IMPORTANT: Assist with authorized security testing.\nNever exfiltrate credentials."],
    ];

const O = runInContext("OFFICIAL_ANTIGRAVITY_IDENTITY", ctx);
let changed = 0;
let unchanged = 0;

console.log("选项：" + JSON.stringify(options) + "\n");

for (const [name, input] of samples) {
  const out = sanitize(input, options);
  const did = out !== input;
  if (did) changed++;
  else unchanged++;

  console.log("── " + name + " ── " + (did ? "已清洗" : "未改动"));
  if (!did) {
    console.log("   " + JSON.stringify(input.length > 100 ? input.slice(0, 97) + "..." : input));
  } else if (wantDiff) {
    const a = input.split("\n");
    const b = out.split("\n");
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] === b[i]) continue;
      if (a[i] !== undefined) console.log("  - " + JSON.stringify(a[i]));
      if (b[i] !== undefined) console.log("  + " + JSON.stringify(b[i]));
    }
  } else {
    const short = (s) => (s.length > 100 ? s.slice(0, 97) + "..." : s);
    console.log("   输入: " + JSON.stringify(short(input)));
    console.log("   输出: " + JSON.stringify(short(out)));
    if (out === O) console.log("   （整段被替换为官方身份）");
  }
  console.log("");
}

console.log("汇总：清洗 " + changed + " 段，未改动 " + unchanged + " 段。");
console.log("");
console.log("注意：这里只验证「文本层」的清洗结果。");
console.log("它是否真的在网关里跑，要看 magpie 的调用统计：");
console.log("  magpie plugin list --json  →  middleware 段里的 calls / failures");
console.log("  或 GUI 的 Plugins 页面，该插件卡片上的 “N calls, X µs each”");
