// sidebarmobile — 精确来源键（shared）
// 2026-09-29 | Kimi(speckit-implement) | T013：实现以通过 T012（FR-005、data-model §1）
// 2026-09-29 | Kimi(speckit-fix) | 终审 [建议修改]：新增 originKeyTextFromUrl，消除 app/background/adapters 中五处手写来源键实现（DRY）

import { isAllowedProtocol } from './url-policy.ts';

/**
 * [DONE] 精确来源（协议 + 域名 + 端口）。
 *
 * 用途：网站列表归并键、站点设置键、授权范围的唯一身份（spec FR-005）。
 * 契约：默认端口归一为 null；不做主域名合并（子域名是不同来源）；
 * Cookie 实际作用域遵循浏览器规则、不按端口隔离，界面需向用户说明这一点。
 */

export interface OriginKey {
  scheme: 'http' | 'https';
  host: string;
  /** 默认端口（http 80 / https 443）归一为 null */
  port: number | null;
}

/** [DONE] 从任意 URL 提取精确来源；非法或非 http(s) 返回 null */
export function originKeyFromUrl(urlText: string): OriginKey | null {
  let parsed: URL;
  try {
    parsed = new URL(urlText);
  } catch {
    return null;
  }

  if (!isAllowedProtocol(parsed.protocol) || parsed.hostname.length === 0) {
    return null;
  }

  const scheme = parsed.protocol === 'https:' ? 'https' : 'http';
  return {
    scheme,
    host: parsed.hostname.toLowerCase(),
    port: normalizePort(scheme, parsed.port),
  };
}

/** [DONE] 默认端口归一为 null，其余保持数字 */
function normalizePort(scheme: 'http' | 'https', rawPort: string): number | null {
  if (rawPort.length === 0) {
    return null;
  }
  const portNumber = Number(rawPort);
  if (!Number.isInteger(portNumber) || portNumber <= 0) {
    return null;
  }
  const isDefaultPort = (scheme === 'https' && portNumber === 443) || (scheme === 'http' && portNumber === 80);
  return isDefaultPort ? null : portNumber;
}

/** [DONE] 序列化为稳定字符串键（存储与权限 pattern 生成用） */
export function originKeyToString(key: OriginKey): string {
  const portSuffix = key.port === null ? '' : `:${key.port}`;
  return `${key.scheme}://${key.host}${portSuffix}`;
}

/** [DONE] 解析序列化键；非法返回 null */
export function parseOriginKey(value: string): OriginKey | null {
  if (value.length === 0) {
    return null;
  }
  return originKeyFromUrl(value);
}

/**
 * [DONE] 一步从 URL 得到序列化来源键；非法返回 null。
 *
 * 这是最常用的形态（判定两条 URL 是否同来源、给存储/权限 pattern 生成键），
 * 因此收敛成一个函数而不是让每个调用方各写一遍 `originKeyFromUrl` + `originKeyToString`。
 * 先前的代码里这段组合出现了五处，端口归一化与大小写规则随时可能在其中一处被写错。
 */
export function originKeyTextFromUrl(urlText: string): string | null {
  const parsed = originKeyFromUrl(urlText);
  return parsed === null ? null : originKeyToString(parsed);
}

/** [DONE] 两个键是否同一来源（null 安全） */
export function sameOriginKey(left: OriginKey | null, right: OriginKey | null): boolean {
  if (left === null || right === null) {
    return false;
  }
  return left.scheme === right.scheme && left.host === right.host && left.port === right.port;
}
