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
// 目标是让 onProvider 尽量远离宿主 250ms 硬上限，但这里**不承诺**任何
// 时间上限：本仓库没有 moejs 宿主可测，Node/V8 的实测值不能代表其它引擎。
// 实测参考（Node v24.21.0）：最慢的常规形态是"大量极短行"，100 万字符
// 约 130–170ms；独立身份段约 40ms。多字段请求的总成本还会叠加。
// 因此 1M 只是**单字段**上限，不等于整次 hook 的时间保证。
// ---------------------------------------------------------------------------

/** 超过此长度的单段文本原样返回（fail-open）。 */
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

/** 该句是否已经是官方身份声明本身。让"已经洗过"的段落同样参与去重，保证幂等。 */
function isOfficialIdentity(sentence, punct) {
  return sentence === IDENTITY_STEM && (punct === "." || punct === "");
}

/**
 * 一个**完整段落**是否恰好就是一句纯身份声明。
 *
 * 去重只在段落粒度做：整段都是身份才整段丢弃。绝不在一段里挑句子删——
 * 那样会把段内剩余部分挪到行首，从而被 billing 规则、容器解析或身份匹配
 * 二次解释，也会改变后续缩进代码的块类型（见评审 F1/F2/F4/F5）。
 * 整段丢弃只影响段落之间的空行数量，不改变任何一行内部的结构。
 *
 * 注意：调用方传入的是**清洗后**的段落文本（见 flush 内的说明），
 * 不是原始文本。用原始文本判定会破坏幂等。
 *
 * 另外，本函数只回答"这一段是不是纯身份"，不回答"能不能删"。
 * 能否删除还取决于调用方的文首前缀窗口（prefixOpen）。
 *
 * @param {string} paragraph 一个完整段落（可含结尾空白）
 * @param {object} options 中间件选项
 * @returns {boolean}
 */
function isPureIdentityParagraph(paragraph, options) {
  const body = paragraph.trim();
  if (body === "" || body.length > IDENTITY_SENTENCE_LIMIT) return false;
  // 只接受单行纯散文：换行、行内代码、容器标记、强调一律不参与
  if (body.indexOf("\n") !== -1 || body.indexOf("\r") !== -1) return false;
  if (body.indexOf("`") !== -1) return false;
  if (/^[ \t]*(?:[>#]|[-+*][ \t]|\d{1,9}[.)][ \t])/.test(body)) return false;
  if (/^[*_]{1,3}[\s\S]*[*_]{1,3}$/.test(body)) return false;

  const end = sentenceEnd(body, 0);
  // 整段必须就是这一句，且句末只能是句末标点或没有标点。
  // 中文句号也要接受：否则"你是…开发的助手。"这类段落第一遍被替换成
  // 官方身份，第二遍才被认成身份段，幂等性就被破坏。
  if (end < body.length - 1) return false;
  const punct = end < body.length ? body[end] : "";
  if (punct !== "" && punct !== "." && punct !== "。" && punct !== "!" && punct !== "！") return false;
  const sentence = body.slice(0, end);
  if (isOfficialIdentity(sentence, punct)) return true;

  const matchText = options.sanitizeBrands === true ? sentence.replace(RE_BRANDS, "Google") : sentence;
  // 只认"纯身份"：带逗号约束的替换结果保留原样，不参与段落丢弃
  return matchIdentity(matchText, punct) === OFFICIAL_ANTIGRAVITY_IDENTITY;
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
 * 这里**不做**去重。连续身份在段落粒度处理（见 isPureIdentityParagraph）：
 * 在一段里挑句子删除，会让段内剩余部分挪到行首，从而被 billing 规则、
 * 容器解析或身份匹配二次解释，并改变后续缩进代码的块类型。
 *
 * @returns {string|null} null 表示该行应被删除
 */
function processLine(line, skipIdentity, partialTail, options, cloakRe) {
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

  for (;;) {
    let start = pos;
    while (start < content.length && (content[start] === " " || content[start] === "\t")) start++;
    if (start >= content.length) {
      out.push(decorate(content.slice(pos), options, cloakRe));
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

    out.push(decorate(content.slice(pos, start), options, cloakRe));
    if (replacement !== null) out.push(replacement);
    else out.push(decorate(sentence + punct, options, cloakRe));

    firstSentence = false;

    if (atEnd) break;
    pos = end + 1;
  }

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
function sanitizeParagraph(text, options, cloakRe) {
  const spans = findCodeSpans(text);
  if (spans.length === 0) return sanitizeFragment(text, options, cloakRe, false, false);

  const out = [];
  let at = 0;
  let afterCode = false;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    out.push(sanitizeFragment(text.slice(at, span.start), options, cloakRe, afterCode, true));
    out.push(text.slice(span.start, span.end));
    // code span 是实体内容，逐字保留。
    // 段落级去重只发生在整段恰好是纯身份时，而含 code span 的段落不会
    // 满足那个条件，所以这里不需要额外的状态处理。
    at = span.end;
    afterCode = true;
  }
  out.push(sanitizeFragment(text.slice(at), options, cloakRe, afterCode, false));
  return out.join("");
}

/**
 * 处理一段纯散文（不含 code span）。
 * 每个物理行连同其自身的行终止符一起处理：删除某行时，该行的换行也一并消失，
 * 因此不会在删除处留下空行，也不会吞掉相邻行之间的分隔。
 */
function sanitizeFragment(fragment, options, cloakRe, startsAfterCode, endsBeforeCode) {
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
    const result = processLine(body, startsAfterCode && isFirst, endsBeforeCode && isLast, options, cloakRe);
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

  // -------------------------------------------------------------------------
  // 连续身份去重：只在「文首的顶层纯身份前缀」范围内生效。
  //
  // 去重必须比"任意位置整段删除"更窄，因为删除一个段落会改变后续行的
  // 容器上下文（`itemIndent` 是否已被重置），使缩进代码在第二次处理时
  // 退化成散文，从而被 billing 规则或身份规则改写（评审 R1）。
  // 同理，一段里如果还夹着 billing 头这类会被删掉的行，删除后段落边界
  // 与第一遍不同，两遍决策就会不一致（评审 R2）。
  //
  // 因此：只有在**还没有输出过任何内容**（prefixOpen）时，才允许折叠
  // 顶层的纯身份段落；一旦遇到任何非纯身份的内容，窗口永久关闭。
  // 真实 DSH 的两句身份正好位于文首，仍然会被折叠。
  // -------------------------------------------------------------------------
  let prefixOpen = true;   // 文首窗口是否仍然打开
  let identityEmitted = false; // 窗口内是否已经输出过一段身份
  let suppressBlank = false;

  const flush = () => {
    if (prose.length === 0) return;
    const raw = prose.join("");
    prose = [];

    const text = sanitizeParagraph(raw, options, cloakRe);
    if (text === "") {
      suppressBlank = true;
      return;
    }

    // 判定必须基于**清洗后**的段落文本，而不是原始文本。
    // 否则：`You are DSH.` + 一行 billing 头 组成一段时，原段不是"纯身份"
    // （含换行），但清洗后恰好只剩一句身份；第二遍它就成了"纯身份"段，
    // 于是第一遍没折叠、第二遍折叠，幂等性被破坏。
    const pure = isPureIdentityParagraph(text, options);

    if (prefixOpen && pure && identityEmitted) {
      // 窗口内的冗余身份段：整段丢弃。删的是**整段**，不删段内任何一句。
      suppressBlank = true;
      return;
    }

    // 任何非纯身份内容都会永久关闭窗口——之后不再折叠任何段落。
    if (!pure) prefixOpen = false;
    else if (prefixOpen) identityEmitted = true;

    out.push(text);
    suppressBlank = false;
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
      prefixOpen = false;
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
      prefixOpen = false;
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
        prefixOpen = false;
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
        prefixOpen = false;
        continue;
      }
    }

    // 6. ATX 标题：自身是散文，但打断段落
    if (effIndent <= 3 && RE_ATX_HEADING.test(body.slice(info.contentStart))) {
      flush();
      prose.push(line);
      flush();
      paragraphOpen = false;
      // 标题开启了新的小节，其后的内容不属于文首前缀
      prefixOpen = false;
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
  // 输入不以换行结尾时，输出也不应带换行（清洗只会删减，不会新增）。
  // 用反向扫描而非 /[\r\n]+$/：后者在"长换行串 + 普通字符"上会从每个位置
  // 重新尝试并回退，实测 4 万字符约 268ms、8 万字符超过 1s，属于平方级。
  const last = text.length > 0 ? text[text.length - 1] : "";
  if (last !== "\n" && last !== "\r") {
    let cut = result.length;
    while (cut > 0 && (result[cut - 1] === "\n" || result[cut - 1] === "\r")) cut--;
    if (cut !== result.length) result = result.slice(0, cut);
  }
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
