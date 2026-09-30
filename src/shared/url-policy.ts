// sidebarmobile — URL 策略（shared）
// 2026-09-29 | Kimi(speckit-implement) | T011：实现以通过 T010（FR-002/FR-003/FR-005）
// 2026-09-29 | Kimi(speckit-fix) | 终审 B5：协议判定拆为两级，修复 example.com:8080 / localhost:8000 被误判为不支持协议

/**
 * [DONE] URL 校验与规范化。
 *
 * 职责：把用户输入或网页上报的地址收敛为「可安全加入网站列表 / 可加载」的 http(s) URL，
 * 并给出可理解的中文失败原因。本模块是唯一的协议准入点（spec FR-002/FR-003），
 * 其它模块不得自行 `new URL()` 后直接使用未校验地址。
 */

/** 支持解析的协议白名单（spec FR-003：拒绝 javascript:/data:/file:/chrome:/ftp: 等） */
const ALLOWED_PROTOCOLS = ['http:', 'https:'] as const;

/** 失败原因分类：供 UI 选择文案，不直接展示机器码 */
export type UrlPolicyFailureReason = 'empty-input' | 'unsupported-protocol' | 'malformed';

export interface UrlPolicySuccess {
  ok: true;
  /** 规范化后的 URL（可直接用于 iframe src 与存储） */
  url: string;
  /** 用户原始输入（保留以便编辑，spec FR-003） */
  raw: string;
}

export interface UrlPolicyFailure {
  ok: false;
  reason: UrlPolicyFailureReason;
  /** 面向用户的中文说明 */
  detail: string;
  /** 用户原始输入 */
  raw: string;
}

export type UrlPolicyResult = UrlPolicySuccess | UrlPolicyFailure;

function failure(reason: UrlPolicyFailureReason, detail: string, raw: string): UrlPolicyFailure {
  return { ok: false, reason, detail, raw };
}

/**
 * [DONE] 判断输入是否已带协议（含 `javascript:` 这类**无 `//`** 的协议）。
 *
 * 用于决定是否补 `https://`。两级判定（终审 B5 修复的要点）：
 *
 * 1. 先把 `协议 ://` 视作显式协议 —— `http://`、`ftp://` 等；
 * 2. 再单独识别**危险的无斜杠协议**（`javascript:`、`data:`、`mailto:` 等）。
 *    它们必须被当成"有协议"送进白名单校验，否则补上 https 后会被解析成畸形 URL，
 *    错误码从 `unsupported-protocol` 退化成 `malformed` —— 提示变差且语义不准。
 *
 * 关键在于**不能**把 `example.com:8080` 里的 `example.com:` 认成协议（那是 B5 的原始缺陷）：
 * 真实协议名要么后跟 `//`，要么属于已知的危险协议清单。
 */
const SCHEME_WITH_SLASHES = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const DANGEROUS_SCHEME = /^(javascript|data|vbscript|blob|about|file|chrome|chrome-extension|moz-extension|ftp|ftps|ws|wss|mailto|tel|sms|view-source):/i;

function isExplicitSchemeInput(input: string): boolean {
  return SCHEME_WITH_SLASHES.test(input) || DANGEROUS_SCHEME.test(input);
}

/**
 * [DONE] 解析用户输入的地址。
 *
 * 行为：先 trim；缺协议时按 https 补全（用户通常只粘贴域名或"主机:端口"）；
 * 协议不在白名单则拒绝；其余交给 URL 解析器判定畸形。
 */
export function parseUrlInput(rawInput: string): UrlPolicyResult {
  const raw = rawInput;
  const trimmed = rawInput.trim();

  if (trimmed.length === 0) {
    return failure('empty-input', '请输入要添加的网址', raw);
  }

  const candidate = isExplicitSchemeInput(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return failure('malformed', '网址格式无法识别，请检查后重试', raw);
  }

  if (!isAllowedProtocol(parsed.protocol)) {
    return failure('unsupported-protocol', '只支持 http 与 https 开头的网址', raw);
  }

  // 必须有主机名；`https://` 这类输入解析后会得到空主机
  if (parsed.hostname.length === 0) {
    return failure('malformed', '网址缺少域名，请检查后重试', raw);
  }

  return { ok: true, url: normalizeUrl(parsed.toString()), raw };
}

/** [DONE] 协议是否在白名单内 */
export function isAllowedProtocol(protocol: string): boolean {
  return (ALLOWED_PROTOCOLS as readonly string[]).includes(protocol);
}

/**
 * [DONE] 规范化 URL。
 *
 * 规则：主机转小写、默认端口去掉、去除哈希片段（片段不参与资源身份，
 * 保留会让同一页面的历史产生大量近重复条目）。
 */
export function normalizeUrl(urlText: string): string {
  const parsed = new URL(urlText);

  const scheme = parsed.protocol.toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port;
  const isDefaultPort = (scheme === 'https:' && port === '443') || (scheme === 'http:' && port === '80');
  const authority = isDefaultPort || port.length === 0 ? host : `${host}:${port}`;

  const pathname = parsed.pathname.length === 0 ? '/' : parsed.pathname;
  const search = parsed.search;

  return `${scheme}//${authority}${pathname}${search}`;
}

/** [DONE] 校验任意字符串是否为可用的 http(s) URL（网页上报与存储读取时使用） */
export function isNavigableUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return isAllowedProtocol(parsed.protocol) && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}
