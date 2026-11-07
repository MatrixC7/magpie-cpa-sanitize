/**
 * antigravity-identity.middleware.js — Magpie 网关中间件
 *
 * 作用于任何反代 Antigravity 的供应商（CPA/CLIProxyAPI、new-api、one-api、
 * 自建 relay 等）链路，针对其系统提示词：
 * 删除 Anthropic billing 头，并把第三方客户端的开场身份声明归一化为官方身份。
 * 代码块、行内代码、安全策略与工具规则一律保持原样。
 *
 * 处理范围：
 *   - 只处理 system / developer / instructions 等系统级文本，不动 user / assistant 历史
 *   - 只改行首（含引用、列表、标题容器内）的明确身份句，不做任意自然语言推断
 *   - 连续的身份声明只保留第一处；逗号之后的约束原样保留
 *   - 归属对象必须足够简单（≤80 字符、≤6 词、无功能词）才替换，否则保留原文
 *   - 超出预算的输入整篇原样返回（fail-open）
 *
 * 默认选项（`magpie plugin options magpie-middleware-antigravity-identity '<json>'` 覆盖）：
 *   {
 *     "providers": ["cli-proxy-api"],
 *     "accounts": [],
 *     "sanitizeBrands": false,
 *     "cloakFallbackWords": [],
 *     "off": false
 *   }
 *
 * 运行时：仅标准 ES 语法，无 Node/Web API。onProvider 有改动时返回 body，
 * 无改动返回 undefined，绝不返回 null。
 */

export const OFFICIAL_ANTIGRAVITY_IDENTITY =
  "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.";

const ZWSP = "\u200b";

// ---------------------------------------------------------------------------
// 预算常量
//
// 目标是任何输入下都不让 onProvider 接近宿主 250ms 硬上限。
// 实测最坏形态是"大量短行、每行都进入身份扫描"：100 万字符约 86ms，
// 故取 1M 作为单段上限，为 250ms 留出约 3 倍余量。
// ---------------------------------------------------------------------------

/** 超过此长度的输入整篇原样返回（fail-open）。 */
const MAX_TEXT_LENGTH = 1000000;
/** 单行内身份替换次数上限，超出部分原样保留。 */
const MAX_IDENTITY_REPLACEMENTS = 64;
/** 参与身份判定的单句最大长度；超长句子不做推断。 */
const IDENTITY_SENTENCE_LIMIT = 2048;
/** 归属对象最大字符数与最大词数。 */
const MAX_OWNER_LENGTH = 80;
const MAX_OWNER_WORDS = 6;
/** cloak 合并正则的源码长度上限，防止配置膨胀。 */
const MAX_CLOAK_PATTERN = 4096;

// ---------------------------------------------------------------------------
// 正则
// ---------------------------------------------------------------------------

// 竞品厂牌词（仅在显式 sanitizeBrands:true 时使用）
const RE_BRANDS =
  /\b(?:DeepSeek[ \t]+Harness|DeepSeek|OpenAI|Anthropic|Qwen|ByteDance|Tencent|Xiaomi|Huawei|Baidu|Mistral|Cohere|xAI)\b|(?:深度求索|字节跳动|腾讯|小米|华为|通义千问|通义灵码|百度|文心一言|文心快码|豆包|混元)/gi;

// 仅匹配「完整独立」的 billing 行
const RE_BILLING_LINE = /^[ \t]*x-anthropic-billing-header:[^\r\n]*$/i;

// 行首角色前缀：限定修饰词集合。
// 捕获组 1 是归属子句本身，用于区分"作者归属"与"运行载体/依据"两类语义。
const RE_ROLE_PREFIX =
  /^(?:you[ \t]+are|you're|i[ \t]+am|i'm|act[ \t]+as)[ \t]+(?:an?[ \t]+)?(?:(?:intelligent|advanced|automated|powerful|agentic|coding|software|development|programming|personal|ai)[ \t]+){0,6}(?:agent|assistant|ai|tool|cli|programmer|companion|engineer|bot|harness)[ \t]+((?:(?:created|built|made|developed|designed|trained|powered|maintained|published|released|provided|authored|written)[ \t]+(?:by|on|upon|at))|(?:based[ \t]+on)|(?:running[ \t]+(?:inside|in|within|on))|(?:integrated[ \t]+(?:into|in)))[ \t]+/i;

// 非作者归属类子句（based on / running in / integrated into）只有在指向
// 已知运行载体或模型标识时才视为身份声明，否则保留原文。
const RE_NON_AUTHORSHIP = /^(?:based|running|integrated)\b/i;
const KNOWN_RUNTIMES = new Set([
  "openclaw", "antigravity", "codex", "claude", "cursor", "windsurf", "aider",
  "cline", "kilocode", "devin", "opencode", "dsh", "continue", "zed", "vscode",
  "jetbrains", "terminal", "cli", "editor", "ide",
]);
const RE_MODEL_LIKE = /^(?:gpt|claude|gemini|llama|qwen|mistral|deepseek|o[1-9])[\w.-]*$/i;

// 已知客户端名（行首）
const RE_CLIENT_PREFIX =
  /^(?:you[ \t]+are|you're)[ \t]+(?:dsh|opencode|claude[ \t]+code|codex|hermes[ \t]+agent|openclaw|cursor(?:[ \t]+ai)?|cascade|cline|roo[ \t]+code|aider|kilocode|devin)\b/i;

// SDK 专用整句
const RE_SDK_IDENTITY =
  /^(?:you[ \t]+are|you're)[ \t]+a[ \t]+claude[ \t]+agent,[ \t]*built[ \t]+on[ \t]+anthropic's[ \t]+claude[ \t]+agent[ \t]+sdk$/i;

// 已知客户端的精确后缀语法：不认识的后缀原样保留
const CLIENT_DESCRIPTIONS = [
  /^,[ \t]*an?[ \t]+interactive[ \t]+cli[ \t]+tool[ \t]+that[ \t]+helps[ \t]+users[ \t]+with[ \t]+software[ \t]+engineering[ \t]+tasks$/i,
  /^,[ \t]*(?:anthropic's[ \t]+)?official[ \t]+cli[ \t]+for[ \t]+claude(?:,[ \t]*running[ \t]+within[ \t]+(?:the[ \t]+)?claude[ \t]+agent[ \t]+sdk)?$/i,
  /^,[ \t]*(?:an?[ \t]+)?(?:advanced[ \t]+)?(?:coding[ \t]+)?agent[ \t]+based[ \t]+on[ \t]+gpt-[a-z0-9._-]+$/i,
  // 真实 Codex 0.162.1 的写法：没有 "agent" 一词
  /^,[ \t]*based[ \t]+on[ \t]+gpt-[a-z0-9._-]+$/i,
  /^,[ \t]*an?[ \t]+intelligent[ \t]+ai[ \t]+assistant[ \t]+(?:created|built)[ \t]+by[ \t]+nous[ \t]+research$/i,
  /^,[ \t]*an?[ \t]+automated[ \t]+software[ \t]+development[ \t]+harness(?:[ \t]+designed[ \t]+for[ \t]+agentic[ \t]+coding[ \t]+workflows)?$/i,
];

// 已知客户端的纯自我介绍句（非工具名、非 URL/路径），可安全整体归一化。
// 来源：Magpie 内置 Codex 模板。
const CLIENT_SELF_DESCRIPTIONS = [
  /^(?:the[ \t]+)?codex[ \t]+cli[ \t]+is[ \t]+an?[ \t]+open[ \t-]+source[ \t]+project[ \t]+led[ \t]+by[ \t]+openai$/i,
  /^(?:within[ \t]+this[ \t]+context,[ \t]*)?codex[ \t]+refers[ \t]+to[ \t]+the[ \t]+open[ \t-]+source[ \t]+agentic[ \t]+coding[ \t]+interface(?:[ \t]*\([^)]*\))?$/i,
];

// 归属对象中禁止出现的闭类功能词/祈使动词。
// 这是有限闭集（英语功能词 + 少量祈使动词），用于拒绝"目的/方式短语"，
// 不能据此宣称可以解析任意自然语言。
const OWNER_STOP_WORDS = new Set([
  "a", "an", "the",
  "to", "for", "with", "without", "using", "use", "uses", "via", "from", "of", "in", "on", "at",
  "and", "or", "but", "so", "while", "if", "when", "then", "that", "which", "who", "whose",
  "it", "they", "them", "you", "your", "me", "us", "we", "i",
  "must", "shall", "should", "will", "would", "can", "could", "may", "might",
  "never", "always", "only", "just", "also", "not", "no", "do", "does", "did",
  "please", "avoid", "ensure", "make", "keep", "remember", "note",
  "run", "runs", "execute", "executes", "help", "helps", "helping",
  "created", "built", "made", "developed", "designed", "trained", "powered",
]);

// 归属对象中的单个词：允许字母/数字/撇号/连字符/下划线/斜杠，不允许点（域名/版本）与冒号
const RE_OWNER_TOKEN = /^[A-Za-z0-9][A-Za-z0-9'’\-_/]*$/;

// 模型标识形态 `<provider>/<model-id>`：允许其中的版本点号（如 codex-proxy-rs/gpt-6.1-sol）。
// 必须含斜杠才放行点号，因此 `acme.com` 这类域名仍被拒绝。
const RE_OWNER_MODEL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9'’._/-]*\/[A-Za-z0-9][A-Za-z0-9'’._/-]*$/;

// 中文开发者部分的排除词：禁令、情态、连词、常见动词。命中即保留原文。
// 注意：这里用多字词而非单字，避免把品牌名（如"华为"）中的"为"误判为停用词。
const CN_STOP_CHARS = /[禁不勿务必请且但并若如注确同只仅需应可允拒执运修改删读写访泄透把将被让使给对从向往于]/;
const CN_STOP_WORDS = /(?:为了|因为|作为|认为)/;

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function asOptions(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** 判断某位置的字符是否被反斜杠转义（奇数个前导反斜杠）。 */
function isEscaped(text, index) {
  let n = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) n++;
  return n % 2 === 1;
}

/** Tab 展开到下一个 4 列制表位。 */
function advanceColumn(ch, col) {
  return ch === "\t" ? col + (4 - (col % 4)) : col + 1;
}

/**
 * 定位句边界。后面紧跟非空白的点不算边界（覆盖域名、标识符、版本号如 5.2 / 6.1-sol）。
 */
function sentenceEnd(text, start) {
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === ".") {
      const next = i + 1 < text.length ? text[i + 1] : "";
      if (next && !/[ \t]/.test(next)) continue;
      return i;
    }
    if ("。!?！？;；".indexOf(ch) !== -1) return i;
  }
  return text.length;
}

function identityReplacement(punct) {
  return punct === "," || punct === "，"
    ? OFFICIAL_ANTIGRAVITY_IDENTITY.slice(0, -1) + punct
    : OFFICIAL_ANTIGRAVITY_IDENTITY;
}

// ---------------------------------------------------------------------------
// 归属对象校验
// ---------------------------------------------------------------------------

/**
 * 判断归属对象是否"足够简单"，可以安全地整体替换。
 * 任何不确定的情况都返回 false（保留原文），因为误删约束的代价远高于漏洗。
 */
function isSimpleOwner(owner) {
  if (!owner || owner.length > MAX_OWNER_LENGTH) return false;
  const words = owner.split(/[ \t]+/);
  if (words.length > MAX_OWNER_WORDS) return false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    // 模型标识允许版本点号（必须含斜杠），普通词不允许点
    if (!RE_OWNER_TOKEN.test(w) && !RE_OWNER_MODEL_TOKEN.test(w)) return false;
    // 首个词允许冠词，其余位置出现功能词即判为复合结构
    const low = w.toLowerCase();
    if (i === 0 && (low === "a" || low === "an" || low === "the")) continue;
    if (OWNER_STOP_WORDS.has(low)) return false;
  }
  return true;
}

/** 中文开发者部分是否为简单名称。 */
function isSimpleChineseOwner(dev) {
  if (!dev || dev.length > 20) return false;
  if (CN_STOP_WORDS.test(dev)) return false;
  return !CN_STOP_CHARS.test(dev);
}

// ---------------------------------------------------------------------------
// 单句身份匹配
// ---------------------------------------------------------------------------

/**
 * 尝试把一整句识别为身份声明并给出替换文本。
 * 返回值包含句末标点：整句替换时用官方身份自身的句号，续写时保留原句末标点。
 * @param {string} sentence 不含句末标点的句子
 * @param {string} punct 句末标点（可能为空）
 * @returns {string|null} 替换后的整句（含标点），或 null 表示不改动
 */
function matchIdentity(sentence, punct) {
  // 0. 疑问句豁免：整句是提问而非陈述时不做身份改写
  if (punct === "?" || punct === "？") return null;

  // 1. 已知客户端 + 精确后缀
  const known = RE_CLIENT_PREFIX.exec(sentence);
  if (known) {
    const tail = sentence.slice(known[0].length);
    if (tail === "") return OFFICIAL_ANTIGRAVITY_IDENTITY;
    for (let i = 0; i < CLIENT_DESCRIPTIONS.length; i++) {
      if (CLIENT_DESCRIPTIONS[i].test(tail)) return OFFICIAL_ANTIGRAVITY_IDENTITY;
    }
    return null;
  }

  // 2. SDK 整句
  if (RE_SDK_IDENTITY.test(sentence)) return OFFICIAL_ANTIGRAVITY_IDENTITY;

  // 2b. 已知客户端的纯自我介绍句
  for (let i = 0; i < CLIENT_SELF_DESCRIPTIONS.length; i++) {
    if (CLIENT_SELF_DESCRIPTIONS[i].test(sentence)) return OFFICIAL_ANTIGRAVITY_IDENTITY;
  }

  // 3. 角色 + 归属对象。归属对象是"整段剩余"或"首个逗号前"。
  let comma = -1;
  for (let i = 0; i < sentence.length; i++) {
    if (sentence[i] === "," || sentence[i] === "，") {
      comma = i;
      break;
    }
  }
  const head = comma === -1 ? sentence : sentence.slice(0, comma);
  const tailPart = comma === -1 ? "" : sentence.slice(comma);

  const prefix = RE_ROLE_PREFIX.exec(head);
  if (prefix) {
    const clause = prefix[1];
    const owner = head.slice(prefix[0].length).trim();
    if (!isSimpleOwner(owner)) return null;
    // "running in read-only mode" / "designed for secure code review" 这类
    // 描述的是工作模式或用途，不是作者归属。只有指向已知运行载体或模型时才处理。
    if (RE_NON_AUTHORSHIP.test(clause)) {
      const first = owner.split(/[ \t]+/)[0].toLowerCase();
      if (!KNOWN_RUNTIMES.has(first) && !RE_MODEL_LIKE.test(first)) return null;
    }
    if (tailPart === "") return identityReplacement(punct);
    // 逗号后是业务约束，必须原样保留（含原句末标点）
    return identityReplacement(tailPart[0]) + tailPart.slice(1) + punct;
  }

  // 4. 中文身份从句：仅匹配"你是<简单名称>开发的助手"这一窄形态
  const cn = /^(?:你是|我是)(?:由)?([^，,。！？\r\n]{1,20}?)(?:开发|制作|构建|训练)的(?:AI)?助手$/.exec(head);
  if (cn) {
    if (!isSimpleChineseOwner(cn[1])) return null;
    if (tailPart === "") return OFFICIAL_ANTIGRAVITY_IDENTITY;
    // 逗号后仅接受"基于<模型>"这种已知尾缀，其余保留
    if (/^[，,][ \t]*基于[^，,。！？\r\n]{1,40}(?:大模型|模型)$/.test(tailPart)) {
      return OFFICIAL_ANTIGRAVITY_IDENTITY;
    }
    return identityReplacement(tailPart[0]) + tailPart.slice(1) + punct;
  }

  return null;
}

// ---------------------------------------------------------------------------
// cloak：预编译 + 幂等
// ---------------------------------------------------------------------------

/**
 * 把配置词编译成单个合并正则。含零宽字符的词被拒绝（否则会自我放大）。
 */
function compileCloak(options) {
  const raw = Array.isArray(options.cloakFallbackWords) ? options.cloakFallbackWords : [];
  const parts = [];
  let budget = MAX_CLOAK_PATTERN;
  for (let i = 0; i < raw.length; i++) {
    const word = raw[i];
    if (typeof word !== "string" || word.length < 2 || word.length > 128) continue;
    if (word.indexOf(ZWSP) !== -1) continue;
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (escaped.length + 1 > budget) break;
    budget -= escaped.length + 1;
    parts.push(escaped);
  }
  if (parts.length === 0) return null;
  // 长词优先，避免短词抢先匹配
  parts.sort((a, b) => b.length - a.length);
  return new RegExp(parts.join("|"), "gi");
}

/**
 * 零宽拆词，迭代到定点以保证幂等。
 *
 * 单趟 replace 在每次匹配后从匹配末尾继续扫描，因此后缀重叠词
 * （`abcdef` 配 `bcdef`/`cdef`…）一轮只能拆一处，需要多轮才能收敛。
 * 这里放宽到 16 轮并在达到定点时提前返回；正常配置通常 1 轮即收敛。
 */
function applyCloak(text, cloakRe) {
  for (let iter = 0; iter < 16; iter++) {
    const next = text.replace(cloakRe, (m) => m[0] + ZWSP + m.slice(1));
    if (next === text) return text;
    text = next;
  }
  return text;
}

// 官方身份串去掉句末标点后的主体，用于识别两种句读形态（句号 / 逗号续写）。
const IDENTITY_STEM = OFFICIAL_ANTIGRAVITY_IDENTITY.slice(0, -1);

/** 该句是否已经是官方身份声明本身。用于让"已经洗过"的文本同样参与去重。 */
function isOfficialIdentity(sentence, punct) {
  return sentence === IDENTITY_STEM && (punct === "." || punct === "");
}

/** 句首首字母大写（仅 ASCII 字母）。 */
function capitalizeFirst(text) {
  const c = text[0];
  return c >= "a" && c <= "z" ? c.toUpperCase() + text.slice(1) : text;
}

/**
 * 从"逗号续写"形态的替换结果中取出约束部分。
 *
 * 输入 `<官方身份去句号>, and you must follow the rules.`
 * 输出 `And you must follow the rules.`
 *
 * 身份部分被去重丢弃时，逗号之后的业务约束必须完整保留，否则会误删规则。
 * 无法确认结构时返回 null，调用方退回整句原样输出（宁可不洗，不可删错）。
 */
function continuationConstraint(replacement) {
  if (replacement.indexOf(IDENTITY_STEM) !== 0) return null;
  const sep = replacement[IDENTITY_STEM.length];
  if (sep !== "," && sep !== "，") return null;
  const rest = replacement.slice(IDENTITY_STEM.length + 1).trim();
  return rest === "" ? null : capitalizeFirst(rest);
}

/**
 * 对非身份文本应用可选的品牌替换与 cloak。
 *
 * 官方身份串的两种句读形态整体豁免，否则配置词命中 Antigravity/Google/agentic 时
 * 会在刚生成的产物里插入零宽字符，使重复处理结果不一致。
 */
function decorate(text, options, cloakRe) {
  if (!text) return text;
  const needBrands = options.sanitizeBrands === true;
  if (!needBrands && !cloakRe) return text;

  const out = [];
  let at = 0;
  for (;;) {
    const hit = text.indexOf(IDENTITY_STEM, at);
    if (hit === -1) {
      out.push(applyDecorations(text.slice(at), needBrands, cloakRe));
      break;
    }
    const tail = text.slice(hit + IDENTITY_STEM.length, hit + IDENTITY_STEM.length + 1);
    // 只豁免"句号"或"逗号"结尾，其余情况视为普通文本
    if (tail !== "." && tail !== "," && tail !== "，") {
      out.push(applyDecorations(text.slice(at, hit + IDENTITY_STEM.length), needBrands, cloakRe));
      at = hit + IDENTITY_STEM.length;
      continue;
    }
    out.push(applyDecorations(text.slice(at, hit), needBrands, cloakRe));
    out.push(IDENTITY_STEM + tail);
    at = hit + IDENTITY_STEM.length + 1;
  }
  return out.join("");
}

function applyDecorations(text, needBrands, cloakRe) {
  if (!text) return text;
  if (needBrands) text = text.replace(RE_BRANDS, "Google");
  if (cloakRe) text = applyCloak(text, cloakRe);
  return text;
}

// ---------------------------------------------------------------------------
// 行处理：billing 删除 + 逐句身份归一化
// ---------------------------------------------------------------------------

/**
 * 迭代消费一行的容器前缀，返回内容起点。
 *
 * 依次识别引用 `>`、列表 `- * + 1. 1)`、ATX 标题 `#`，循环直到不再匹配，
 * 因此 `> - `、`- > `、`- # ` 等任意嵌套方向都能穿透。
 * 只消费合法标记：`-5 degrees`、`#1 priority`、`*emphasis*`、`+1` 不会被当作容器。
 */
function skipContainers(line) {
  let at = 0;
  for (let guard = 0; guard < 16; guard++) {
    let c = at;
    // 最多三个前导空格
    let spaces = 0;
    while (c < line.length && line[c] === " " && spaces < 3) {
      c++;
      spaces++;
    }
    if (c >= line.length) return at;

    // 引用标记
    if (line[c] === ">") {
      c++;
      if (c < line.length && (line[c] === " " || line[c] === "\t")) c++;
      at = c;
      continue;
    }

    const rest = line.slice(c);
    // 列表标记：必须后接空白，避免把 `-5`、`+1` 当容器
    const lm = /^(?:[-+*]|\d{1,9}[.)])([ \t]+)/.exec(rest);
    if (lm) {
      at = c + lm[0].length;
      continue;
    }
    // ATX 标题：`#` 后必须是空白或行尾，避免把 `#1` 当标题
    const hm = /^#{1,6}(?:[ \t]+|$)/.exec(rest);
    if (hm) {
      at = c + hm[0].length;
      continue;
    }
    return at;
  }
  return at;
}

/**
 * 行前缀里是否含有序列表标记（`1.` / `2)`）。
 * 删除这类行会留下编号断档，所以它们不参与整行去重。
 */
const RE_ORDERED_IN_PREFIX = /(?:^|[ \t>])\d{1,9}[.)][ \t]/;

/**
 * 剥离包裹身份句的成对强调标记（`**…**`、`*…*`、`__…__`、`_…_`）。
 * 返回 { inner, wrap } 或 null。仅在内容确实以强调开头并成对结尾时生效。
 */
function unwrapEmphasis(content) {
  const m = /^(\*\*\*|\*\*|\*|___|__|_)([\s\S]*?)\1$/.exec(content);
  if (!m) return null;
  const inner = m[2];
  if (!inner || inner.trim() === "") return null;
  // 内部不得再出现同种标记的开头，避免跨越多段强调
  return { wrap: m[1], inner };
}

/**
 * 处理一行散文：删除 billing 行，逐句归一化身份。
 *
 * 行可能带容器前缀（引用/列表/标题，可任意嵌套）或成对强调包裹；
 * 身份声明在其中语义上仍是"行首"，因此剥离后匹配，再原样拼回。
 *
 * `dedupe` 跨行共享，用于折叠连续的身份声明：`dedupe.emitted` 表示
 * 紧邻的上文已经产出了身份句。命中纯身份句时只保留第一处；命中
 * "身份 + 逗号 + 约束"时只丢身份、保留约束；遇到非身份散文即解除链。
 *
 * @param {{emitted:boolean}} dedupe 跨行的连续身份状态
 * @returns {string|null} null 表示该行应被删除
 */
function processLine(line, skipIdentity, partialTail, options, cloakRe, dedupe) {
  if (!partialTail && line.indexOf("`") === -1 && RE_BILLING_LINE.test(line)) return null;

  const base = skipContainers(line);
  const prefix = line.slice(0, base);
  let content = line.slice(base);

  // 成对强调包裹：只剥一层，替换后原样加回
  let wrap = "";
  const emph = unwrapEmphasis(content);
  if (emph) {
    wrap = emph.wrap;
    content = emph.inner;
  }

  const out = [];
  let pos = 0;
  let firstSentence = true;
  let replacements = 0;
  // 是否有整句因去重被丢弃。全部内容都被丢弃时整行返回 null（连同换行一起消失），
  // 否则会留下一个只有换行的空行。
  let dropped = false;
  // 是否已经输出过可见内容。用于区分"行首缩进"与"句间空格"：
  // 丢弃一个身份句后，它前面的空格不该变成行首空格。
  let hasVisible = false;

  // 有序列表项不能整行删除：删掉 `2.` 会留下 `1.` → `3.` 的编号断档，
  // 那是另一种比重复更显眼的异常，也会破坏工具定义的结构。这类行原样保留。
  const droppable = !RE_ORDERED_IN_PREFIX.test(prefix);

  // 输出句间空白。只有在"本行前面刚丢掉了内容、且还没输出任何可见内容"时，
  // 才吞掉纯空白——那是被丢弃身份句留下的悬挂空格。
  // 其余情况一律原样保留：code span 之间的纯空白片段也是内容。
  const pushGap = (gap) => {
    if (gap === "") return;
    if (dropped && !hasVisible && gap.trim() === "") return;
    out.push(decorate(gap, options, cloakRe));
    hasVisible = true;
  };

  for (;;) {
    let start = pos;
    while (start < content.length && (content[start] === " " || content[start] === "\t")) start++;
    if (start >= content.length) {
      // 行尾空白：整行已被清空时不再保留（否则会留下只有空格的行）
      pushGap(content.slice(pos));
      break;
    }

    const end = sentenceEnd(content, start);
    const sentence = content.slice(start, end);
    const punct = end < content.length ? content[end] : "";
    const atEnd = end >= content.length;

    const skip =
      (skipIdentity && firstSentence) ||
      (partialTail && atEnd && punct === "");

    let replacement = null;
    if (!skip && sentence.length <= IDENTITY_SENTENCE_LIMIT && replacements < MAX_IDENTITY_REPLACEMENTS) {
      // 品牌替换在身份匹配之后执行会让"华为"这类词在第二轮才变成可匹配的 "Google"，
      // 导致同一输入两轮结果不同。开启品牌替换时先归一化再做身份判定，使决策稳定。
      const matchText = options.sanitizeBrands === true ? sentence.replace(RE_BRANDS, "Google") : sentence;
      replacement = matchIdentity(matchText, punct);
      if (replacement !== null) replacements++;
    }

    // 连续身份去重：上文已经产出身份句时，本句不再重复产出。
    // 幂等性要求"已是官方身份"的句子也参与判定，否则二次处理会把
    // 首次处理留下的重复段当成普通散文保留。
    const isIdentity =
      replacement !== null || (!skip && isOfficialIdentity(sentence, punct));

    if (isIdentity && dedupe.emitted) {
      // 冗余身份句：整句丢弃；若是"身份 + 逗号 + 约束"，只丢身份、留下约束。
      const keep = replacement !== null ? continuationConstraint(replacement) : null;
      if (keep !== null) {
        pushGap(content.slice(pos, start));
        out.push(decorate(keep, options, cloakRe));
        hasVisible = true;
      } else if (droppable) {
        // 连同前导空白一起丢弃，避免留下悬挂空格
        dropped = true;
      } else {
        // 有序列表项：不能删行，退化为原样输出该句（宁可重复，不可断号）
        pushGap(content.slice(pos, start));
        if (replacement !== null) out.push(replacement);
        else out.push(decorate(sentence + punct, options, cloakRe));
        hasVisible = true;
      }
      firstSentence = false;
      if (atEnd) break;
      pos = end + 1;
      continue;
    }

    pushGap(content.slice(pos, start));
    if (replacement !== null) out.push(replacement);
    else out.push(decorate(sentence + punct, options, cloakRe));
    hasVisible = true;

    dedupe.emitted = isIdentity;
    firstSentence = false;

    if (atEnd) break;
    pos = end + 1;
  }

  // 整行没有剩下任何可见内容：返回 null 让调用方连换行一起删掉。
  // 只看正文部分——`- `、`> ` 这类容器前缀不能算"还有内容"，
  // 否则列表项/引用会被留成一个空的 `- ` 行。
  if (!hasVisible) return dropped ? null : prefix + wrap + wrap;
  return prefix + wrap + out.join("") + wrap;
}

// ---------------------------------------------------------------------------
// 行内 code span：转义感知 + 段内配对
// ---------------------------------------------------------------------------

/**
 * 从左到右配对 code span：遇到非转义开游程，向后找第一个等长游程闭合。
 *
 * 配对成立后，中间内容（含内层游程）整体属于该 span，不再单独配对，
 * 否则会产生重叠 span 导致拼接时内容重复。
 * 闭游程不检查转义：反引号进入 code span 后，内部反斜杠是字面字符。
 *
 * @returns {Array<{start:number,end:number}>} 按出现顺序且互不重叠的 span
 */
function findCodeSpans(text) {
  // 收集全部游程（转义只在开游程处判定）
  const runs = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "`") {
      i++;
      continue;
    }
    let j = i;
    while (j < text.length && text[j] === "`") j++;
    runs.push({ start: i, end: j, len: j - i });
    i = j;
  }

  const spans = [];
  let k = 0;
  while (k < runs.length) {
    const run = runs[k];
    if (isEscaped(text, run.start)) {
      k++;
      continue;
    }
    let mate = -1;
    for (let m = k + 1; m < runs.length; m++) {
      if (runs[m].len === run.len) {
        mate = m;
        break;
      }
    }
    if (mate === -1) {
      k++;
      continue;
    }
    spans.push({ start: run.start, end: runs[mate].end });
    // 跳过整段 span 内部的所有游程
    k = mate + 1;
  }
  return spans;
}

/**
 * 处理一个段落：切分 code span 与散文，只清洗散文部分。
 * 未配对的反引号按普通文字处理；配对不跨越段落（调用方已按块切分）。
 */
function sanitizeParagraph(text, options, cloakRe, dedupe) {
  const spans = findCodeSpans(text);
  if (spans.length === 0) return sanitizeFragment(text, options, cloakRe, false, false, dedupe);

  const out = [];
  let at = 0;
  let afterCode = false;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    out.push(sanitizeFragment(text.slice(at, span.start), options, cloakRe, afterCode, true, dedupe));
    out.push(text.slice(span.start, span.end));
    // code span 是实体内容，不算身份句，也不打断已有身份链
    at = span.end;
    afterCode = true;
  }
  out.push(sanitizeFragment(text.slice(at), options, cloakRe, afterCode, false, dedupe));
  return out.join("");
}

/**
 * 处理一段纯散文（不含 code span）。
 * 每个物理行连同其自身的行终止符一起处理：删除某行时，该行的换行也一并消失，
 * 因此不会在删除处留下空行，也不会吞掉相邻行之间的分隔。
 */
function sanitizeFragment(fragment, options, cloakRe, startsAfterCode, endsBeforeCode, dedupe) {
  if (!fragment) return fragment;
  const kept = [];
  let at = 0;
  let index = 0;

  while (at <= fragment.length) {
    const nl = fragment.indexOf("\n", at);
    const end = nl === -1 ? fragment.length : nl + 1;
    const raw = fragment.slice(at, end);
    at = end;

    let term = "";
    let body = raw;
    if (raw.endsWith("\r\n")) {
      term = "\r\n";
      body = raw.slice(0, -2);
    } else if (raw.endsWith("\n")) {
      term = "\n";
      body = raw.slice(0, -1);
    }

    const isFirst = index === 0;
    const isLast = nl === -1;
    const result = processLine(body, startsAfterCode && isFirst, endsBeforeCode && isLast, options, cloakRe, dedupe);
    if (result !== null) kept.push(result + term);
    index++;
    if (isLast) break;
  }
  return kept.length === 0 ? "" : kept.join("");
}

// ---------------------------------------------------------------------------
// 块级词法
// ---------------------------------------------------------------------------

const RE_FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/;
const RE_FENCE_CLOSE = /^(`{3,}|~{3,})[ \t]*$/;
const RE_LIST_MARKER = /^(?:[-+*]|\d{1,9}[.)])([ \t]+)/;
const RE_ATX_HEADING = /^#{1,6}(?:[ \t]|$)/;

/**
 * 解析一行的块级事实：缩进列数、是否空行、列表标记及其内容缩进。
 * Tab 按 4 列制表位展开。
 */
function analyzeLine(body) {
  let i = 0;
  let col = 0;

  // 引用块前缀（可嵌套）
  for (;;) {
    let j = i;
    let c = col;
    let spaces = 0;
    while (j < body.length && body[j] === " " && spaces < 3) {
      j++;
      c++;
      spaces++;
    }
    if (j < body.length && body[j] === ">") {
      j++;
      c++;
      if (j < body.length && (body[j] === " " || body[j] === "\t")) {
        c = advanceColumn(body[j], c);
        j++;
      }
      i = j;
      col = c;
      continue;
    }
    break;
  }

  // 缩进列数
  let j = i;
  let c = col;
  while (j < body.length && (body[j] === " " || body[j] === "\t")) {
    c = advanceColumn(body[j], c);
    j++;
  }
  const indentCols = c - col;
  const blank = j >= body.length;

  const info = {
    indentCols,
    blank,
    contentStart: j,
    listMarker: false,
    contentIndent: 0,
  };
  if (blank) return info;

  const rest = body.slice(j);
  const lm = RE_LIST_MARKER.exec(rest);
  if (lm) {
    info.listMarker = true;
    let k = j + lm[1].length;
    let cc = col + indentCols + lm[1].length;
    while (k < body.length && (body[k] === " " || body[k] === "\t")) {
      cc = advanceColumn(body[k], cc);
      k++;
    }
    info.contentIndent = cc;
    info.contentStart = k;
  }
  return info;
}

/** 围栏开栏判定：缩进不超过 3，反引号围栏的 info 不得含反引号。 */
function fenceOpener(text) {
  const m = RE_FENCE_OPEN.exec(text);
  if (!m) return null;
  const ch = m[1][0];
  if (ch === "`" && m[2].indexOf("`") !== -1) return null;
  return { char: ch, len: m[1].length };
}

/** 围栏闭栏判定：同字符、长度不小于开栏、其后只有空白。 */
function fenceCloser(text, fence) {
  const m = RE_FENCE_CLOSE.exec(text);
  if (!m) return false;
  return m[1][0] === fence.char && m[1].length >= fence.len;
}

/**
 * 扫描全文并输出净化后的文本。
 */
export function sanitizeSystemText(text, rawOptions = {}) {
  if (typeof text !== "string" || !text) return text;
  if (text.length > MAX_TEXT_LENGTH) return text;

  const options = asOptions(rawOptions);
  const cloakRe = compileCloak(options);

  const out = [];
  let prose = [];
  let fence = null;
  let itemIndent = 0;
  let paragraphOpen = false;

  // 连续身份去重状态：跨段落共享（空行分隔的相邻段落也算"连续"）。
  // suppressBlank 在整段被丢弃后吞掉紧随其后的空行，避免留下 3+ 个连续空行。
  const dedupe = { emitted: false };
  let suppressBlank = false;

  const flush = () => {
    if (prose.length === 0) return;
    const text = sanitizeParagraph(prose.join(""), options, cloakRe, dedupe);
    prose = [];
    if (text === "") {
      suppressBlank = true;
      return;
    }
    out.push(text);
  };

  let at = 0;
  while (at < text.length) {
    const nl = text.indexOf("\n", at);
    const end = nl === -1 ? text.length : nl + 1;
    const line = text.slice(at, end);
    at = end;

    const cr = line.endsWith("\r\n") ? "\r" : "";
    const body = cr ? line.slice(0, -2) : line.endsWith("\n") ? line.slice(0, -1) : line;

    const info = analyzeLine(body);
    // 列表容器退出：非列表行且缩进不足以维持列表项时，清除 itemIndent。
    // 否则列表后的普通段落仍按旧的列表相对缩进判断，把正常散文误当缩进代码。
    if (itemIndent > 0 && !info.blank && !info.listMarker && info.indentCols < itemIndent) {
      itemIndent = 0;
    }
    const effIndent = info.indentCols - itemIndent;

    // 1. 围栏内部
    if (fence) {
      flush();
      out.push(line);
      if (effIndent <= 3 && fenceCloser(body.slice(info.contentStart), fence)) fence = null;
      paragraphOpen = false;
      dedupe.emitted = false;
      suppressBlank = false;
      continue;
    }

    // 2. 空行
    if (info.blank) {
      flush();
      // 整段被丢弃时空行也一并吞掉，否则会留下不自然的连续空行
      if (suppressBlank) {
        paragraphOpen = false;
        continue;
      }
      out.push(line);
      paragraphOpen = false;
      continue;
    }

    suppressBlank = false;

    // 3. 缩进代码块（不能打断段落）
    if (effIndent >= 4 && !paragraphOpen) {
      flush();
      out.push(line);
      dedupe.emitted = false;
      continue;
    }

    // 4. 列表项：更新容器缩进，再看标记之后是否直接开围栏
    if (info.listMarker) {
      flush();
      itemIndent = info.contentIndent;
      const remainder = body.slice(info.contentStart);
      const opener = fenceOpener(remainder);
      if (opener) {
        out.push(line);
        fence = opener;
        paragraphOpen = false;
        dedupe.emitted = false;
        continue;
      }
      prose.push(line);
      paragraphOpen = true;
      continue;
    }

    // 5. 围栏开栏
    if (effIndent <= 3) {
      const opener = fenceOpener(body.slice(info.contentStart));
      if (opener) {
        flush();
        out.push(line);
        fence = opener;
        paragraphOpen = false;
        dedupe.emitted = false;
        continue;
      }
    }

    // 6. ATX 标题：自身是散文，但打断段落
    if (effIndent <= 3 && RE_ATX_HEADING.test(body.slice(info.contentStart))) {
      flush();
      prose.push(line);
      flush();
      paragraphOpen = false;
      // 标题开启了新的小节，跨小节的重复不算"连续身份"
      dedupe.emitted = false;
      continue;
    }

    // 7. 普通散文
    prose.push(line);
    paragraphOpen = true;
  }
  flush();

  // 末段被整段丢弃时，回退它前面的空行，避免文末留下悬挂空行
  if (suppressBlank) {
    while (out.length > 0) {
      const last = out[out.length - 1];
      if (last === "\n" || last === "\r\n") out.pop();
      else break;
    }
  }

  let result = out.join("");
  // 输入不以换行结尾时，输出也不应带换行（清洗只会删减，不会新增）
  if (!/[\r\n]$/.test(text)) result = result.replace(/[\r\n]+$/, "");
  return result;
}

// ---------------------------------------------------------------------------
// 宿主钩子
// ---------------------------------------------------------------------------

function shouldRun(ctx, options) {
  if (options.off || !ctx.provider) return false;
  const providers = Array.isArray(options.providers) ? options.providers : ["cli-proxy-api"];
  const accounts = Array.isArray(options.accounts) ? options.accounts : [];
  const p = ctx.provider;
  if (providers.indexOf(p.id) === -1 && accounts.indexOf(p.account) === -1) return false;
  if (Array.isArray(options.models) && options.models.indexOf(p.model || ctx.model) === -1) return false;
  return true;
}

export function onProvider(body, ctx) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !ctx) return;
  const options = asOptions(ctx.options);
  if (!shouldRun(ctx, options)) return;

  let changed = false;
  function apply(text) {
    const next = sanitizeSystemText(text, options);
    if (next !== text) changed = true;
    return next;
  }
  function parts(list, gemini) {
    const kept = [];
    let dirty = false;
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        item.thought === true ||
        "thoughtSignature" in item ||
        "thought_signature" in item ||
        (gemini ? item.type !== undefined && item.type !== "text" : item.type !== "text" && item.type !== "input_text") ||
        typeof item.text !== "string"
      ) {
        kept.push(item);
        continue;
      }
      const text = apply(item.text);
      if (text.trim() === "") {
        dirty = true;
        continue;
      }
      if (text !== item.text) {
        item.text = text;
        dirty = true;
      }
      kept.push(item);
    }
    if (dirty) changed = true;
    return dirty ? kept : list;
  }
  function textField(object, key) {
    const next = apply(object[key]);
    if (next.trim() === "") {
      delete object[key];
      changed = true;
    } else if (next !== object[key]) object[key] = next;
  }
  function messages(list) {
    const kept = [];
    let removed = false;
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (item && typeof item === "object" && (item.role === "system" || item.role === "developer")) {
        if (typeof item.content === "string") {
          const text = apply(item.content);
          if (text.trim() === "") {
            removed = true;
            continue;
          }
          if (text !== item.content) item.content = text;
        } else if (Array.isArray(item.content)) {
          item.content = parts(item.content, false);
          if (item.content.length === 0) {
            removed = true;
            continue;
          }
        }
      }
      kept.push(item);
    }
    if (removed) changed = true;
    return removed ? kept : list;
  }

  switch (ctx.protocol) {
    case "anthropic":
      if (typeof body.system === "string") textField(body, "system");
      else if (Array.isArray(body.system)) {
        body.system = parts(body.system, false);
        if (!body.system.length) {
          delete body.system;
          changed = true;
        }
      }
      break;
    case "chat":
      if (Array.isArray(body.messages)) body.messages = messages(body.messages);
      break;
    case "responses":
      if (typeof body.instructions === "string") textField(body, "instructions");
      if (Array.isArray(body.input)) body.input = messages(body.input);
      break;
    case "gemini":
      for (const key of ["systemInstruction", "system_instruction"]) {
        const system = body[key];
        if (system && typeof system === "object" && Array.isArray(system.parts)) {
          system.parts = parts(system.parts, true);
          if (!system.parts.length) {
            delete body[key];
            changed = true;
          }
        }
      }
      break;
  }

  return changed ? body : undefined;
}
