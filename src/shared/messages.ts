// sidebarmobile — 运行时消息协议（shared）
// 2026-09-29 | Kimi(speckit-implement) | T015：实现以通过 T014（contracts/runtime-messages.md）
// 2026-09-29 | Kimi(speckit-fix) | 终审 [建议修改]：删除三条死协议消息（tabs.open-external / ua.sync-rules / session.dirty），并为 capabilities.changed 补齐生产者

import { parseOriginKey } from './origin-key.ts';
import { isNavigableUrl } from './url-policy.ts';

/**
 * [DONE] 侧栏页 / 后台 / content script 之间的消息协议（v1）。
 *
 * 原则（宪法 III + spec FR-033/FR-034）：收发两端都必须校验形状，不信任发送方；
 * 未知类型一律忽略；错误信息面向用户可读且不含内部堆栈。
 */

/** 授权能力类型：UA 与 Cookie 严格分离（spec FR-009/FR-011） */
export type GrantKind = 'ua' | 'cookie';

/**
 * 消息类型全集（contracts/runtime-messages.md）。
 *
 * **只列真实存在的消息**：类型集合就是协议的可执行清单，留着"声明了但没人发"的条目
 * 会让契约与实现不一致 —— 读代码的人会以为存在一条其实不存在的通道
 * （终审 [建议修改] 死协议面）。此前 `tabs.open-external` / `session.dirty` / `ua.sync-rules`
 * 三者既无生产者（`ua.sync-rules` 还多一个无人使用的后台分支）也无人需要，已删除：
 *
 * - 打开外部标签页：侧栏自己经 `adapters/browser-api.ts` 的 `tabsApi` 完成，无需绕后台；
 * - 会话写入结果（FR-032）：写入发生在侧栏进程内，结果直接由 `session-store` 的订阅分发；
 * - UA 规则同步：规则的注册/注销已包含在授权协调器里（`permissions.request-grant` /
 *   `permissions.revoke-grant` 的执行路径中）。
 */
export type RuntimeMessageType =
  | 'permissions.request-grant'
  | 'permissions.revoke-grant'
  | 'capabilities.query'
  | 'frame.report'
  | 'frame.open-request'
  | 'capabilities.changed';

const KNOWN_MESSAGE_TYPES: readonly RuntimeMessageType[] = [
  'permissions.request-grant',
  'permissions.revoke-grant',
  'capabilities.query',
  'frame.report',
  'frame.open-request',
  'capabilities.changed',
];

/** [DONE] 类型判别：未知类型返回 false，调用方应忽略而非报错 */
export function isKnownMessageType(value: unknown): value is RuntimeMessageType {
  return typeof value === 'string' && (KNOWN_MESSAGE_TYPES as readonly string[]).includes(value);
}

export interface RawRuntimeMessage {
  type: RuntimeMessageType;
  payload: Record<string, unknown>;
}

export type MessageValidation =
  | { ok: true; message: RawRuntimeMessage }
  | { ok: false; code: 'invalid-message'; detail: string };

function invalid(detail: string): MessageValidation {
  return { ok: false, code: 'invalid-message', detail };
}

/** [DONE] 校验消息形状；payload 内字段按类型逐项检查 */
export function validateRuntimeMessage(input: unknown): MessageValidation {
  if (typeof input !== 'object' || input === null) {
    return invalid('消息必须是对象');
  }

  const candidate = input as { type?: unknown; payload?: unknown };
  if (!isKnownMessageType(candidate.type)) {
    return invalid('未知的消息类型');
  }
  if (typeof candidate.payload !== 'object' || candidate.payload === null) {
    return invalid('缺少 payload');
  }

  const payload = candidate.payload as Record<string, unknown>;
  const payloadCheck = validatePayload(candidate.type, payload);
  if (payloadCheck !== null) {
    return invalid(payloadCheck);
  }

  return { ok: true, message: { type: candidate.type, payload } };
}

/**
 * [DONE] 按消息类型校验 payload 字段。
 *
 * 返回 null 表示通过；返回字符串为失败原因。
 */
function validatePayload(type: RuntimeMessageType, payload: Record<string, unknown>): string | null {
  switch (type) {
    case 'permissions.request-grant':
    case 'permissions.revoke-grant': {
      if (!isValidOriginKeyText(payload['originKey'])) {
        return 'originKey 非法';
      }
      const grant = payload['grant'];
      if (grant !== 'ua' && grant !== 'cookie') {
        return 'grant 必须是 ua 或 cookie';
      }
      return null;
    }

    case 'capabilities.query': {
      return isValidOriginKeyText(payload['originKey']) ? null : 'originKey 非法';
    }

    case 'frame.report': {
      if (!isNavigableUrl(payload['url'])) {
        return 'url 非法';
      }
      if (typeof payload['title'] !== 'string') {
        return 'title 必须是字符串';
      }
      const navKind = payload['navKind'];
      return navKind === 'load' || navKind === 'history' || navKind === 'hash' ? null : 'navKind 非法';
    }

    case 'frame.open-request': {
      if (!isNavigableUrl(payload['url'])) {
        return 'url 非法';
      }
      return isNavigableUrl(payload['sourceUrl']) ? null : 'sourceUrl 非法';
    }

    case 'capabilities.changed': {
      if (!isValidOriginKeyText(payload['originKey'])) {
        return 'originKey 非法';
      }
      return typeof payload['state'] === 'object' && payload['state'] !== null ? null : 'state 必须是对象';
    }

    default: {
      // 穷尽检查：新增消息类型会在此处触发 TS 错误，提醒补校验
      const exhaustiveCheck: never = type;
      return `未处理的类型 ${String(exhaustiveCheck)}`;
    }
  }
}

/** [DONE] originKey 文本必须是可解析的 http(s) 精确来源 */
function isValidOriginKeyText(value: unknown): boolean {
  return typeof value === 'string' && parseOriginKey(value) !== null;
}

/** 错误码：面向 UI 的失败分类（contracts/runtime-messages.md） */
export type RuntimeErrorCode =
  | 'invalid-message'
  | 'invalid-url'
  | 'permission-denied'
  | 'capability-unsupported'
  | 'storage-failed';

export interface RuntimeOkResponse<T> {
  ok: true;
  data: T;
}

export interface RuntimeErrorResponse {
  ok: false;
  error: { code: RuntimeErrorCode; message: string };
}

export type RuntimeResponse<T> = RuntimeOkResponse<T> | RuntimeErrorResponse;

/** [DONE] 成功信封 */
export function createOkResponse<T>(data: T): RuntimeOkResponse<T> {
  return { ok: true, data };
}

/** [DONE] 失败信封；message 面向用户，禁止包含堆栈或内部路径 */
export function createErrorResponse(code: RuntimeErrorCode, message: string): RuntimeErrorResponse {
  return { ok: false, error: { code, message } };
}
