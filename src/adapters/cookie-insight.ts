// sidebarmobile — Cookie 存在性检测适配（adapters）
// 2026-09-29 | Kimi(speckit-implement) | T044：实现以通过 T042（FR-012/FR-033，research R6）

import { originKeyFromUrl, originKeyToString } from '../shared/origin-key.ts';

/**
 * [DONE] Cookie **存在性**检测（research R6：检测 + 自然携带，不搬运值）。
 *
 * 本模块的职责边界是安全红线本身，任何扩展都必须先读这段再改代码：
 *
 * 1. **只读数量**：调用 `cookies.getAll({ url })` 后只取 `length`。返回结构里**没有** Cookie
 *    的名称与值字段，因此调用方在物理上无法把这些数据写进存储或日志（spec FR-033）。
 * 2. **不打日志**：失败路径只回报分类，绝不输出 API 响应内容 —— 响应里就是凭据。
 * 3. **不做搬运**：iframe 请求是否携带 Cookie 完全由浏览器按 SameSite / 第三方 Cookie /
 *    分区策略决定。复制或改写 Cookie 值既改变不了这些规则，又制造凭据泄漏面，故不实现。
 * 4. **不删数据**：撤销授权只撤权限，永不删除用户 Cookie。
 *
 * 失败一律映射为分类结果（`unsupported` / `failed`），绝不抛异常 —— 授权被拒后用户仍须能
 * 正常浏览（spec FR-036）。
 */

/**
 * 会话存在性结论。
 *
 * 三种取值对应界面上三种不同说法，不能混用：
 * - `present` / `absent` = **能力可用**，且给出了存在性事实；
 * - `unsupported` = 当前环境没有 cookies API（权限未授予时就是这个）；
 * - `failed` = API 在但调用出错。
 */
export type SessionPresenceStatus = 'present' | 'absent' | 'unsupported' | 'failed';

/**
 * 检测结果：**只含数量，不含任何 Cookie 明细**。
 *
 * 这个类型是刻意的窄接口。若未来需要展示"检测到几个会话 Cookie"，也必须通过新增计数派生字段
 * 实现，而不是把 Cookie 对象透传出去。
 */
export interface SessionPresence {
  status: SessionPresenceStatus;
  /** 该来源可见的 Cookie 数量；失败或不可用时为 0 */
  cookieCount: number;
  /** 失败时的简短原因分类（面向开发者与 UI 文案选择，不含凭据） */
  reason?: string;
}

/**
 * cookies API 的最小面。
 *
 * 只声明 `getAll`：本项目不需要 `get` / `set` / `remove`，不声明就无法误用 —— 这是把
 * 「不搬运 Cookie」从约定变成类型层面的约束（宪法 III 权限最小化 + FR-033）。
 */
export interface CookiesApiLike {
  getAll(details: { url: string }): Promise<Array<Record<string, unknown>>>;
}

export interface CookieInsightPort {
  /** 检测某精确来源是否存在会话 Cookie */
  detectSession(originKey: string): Promise<SessionPresence>;
}

/**
 * 常见会话 Cookie 名提示。
 *
 * 用途说明：仅用于**界面文案解释**（例如"该站点通常用 sessionid 记录登录"），
 * 不参与判定。判定只看数量，因为无 host 权限时连名称都读不到（research R6）。
 */
export const SESSION_COOKIE_NAME_HINTS: readonly string[] = [
  'sessionid',
  'session_id',
  'PHPSESSID',
  'JSESSIONID',
  'connect.sid',
  'auth',
  'token',
];

/** [DONE] 由来源键构造查询 URL（cookies.getAll 需要 url 而不是 origin pattern） */
function queryUrlFromOriginKey(originKeyText: string): string | null {
  const parsed = originKeyFromUrl(originKeyText);
  if (parsed === null) {
    return null;
  }
  // 用根路径 + 尾斜杠：cookies.getAll 按 URL 匹配作用域，根路径能覆盖 path=/ 的会话 Cookie
  return `${originKeyToString(parsed)}/`;
}

/**
 * [DONE] 创建 Cookie 存在性检测端口。
 *
 * `api` 为 undefined 表示当前环境没有 cookies API —— 这正是「未授权」在运行时的真实表现
 * （可选权限未授予时该命名空间不存在，与 DNR 的表现一致，见 research R5 spike）。
 */
export function createCookieInsight(api: CookiesApiLike | undefined): CookieInsightPort {
  return {
    async detectSession(originKey: string): Promise<SessionPresence> {
      const queryUrl = queryUrlFromOriginKey(originKey);
      if (queryUrl === null) {
        return { status: 'unsupported', cookieCount: 0, reason: 'invalid-origin' };
      }

      if (api === undefined || typeof api.getAll !== 'function') {
        return { status: 'unsupported', cookieCount: 0, reason: 'no-cookies-api' };
      }

      try {
        // 只传 url：多传 storeId / domain 会把查询范围扩大到本来源之外（权限最小化）
        const cookies = await api.getAll({ url: queryUrl });
        if (!Array.isArray(cookies)) {
          return { status: 'failed', cookieCount: 0, reason: 'malformed-response' };
        }

        /**
         * 只取长度。
         *
         * 不要在这里 .map / .filter 去读 Cookie 的 name 或 value —— 一旦读了，值就进入了本进程
         * 的内存与可能的日志路径。数量已足够支撑「已检测到会话」这一界面结论（FR-012）。
         */
        const cookieCount = cookies.length;
        return cookieCount > 0
          ? { status: 'present', cookieCount }
          : { status: 'absent', cookieCount: 0 };
      } catch {
        // 吞掉异常详情：错误对象可能携带 API 响应内容（即凭据），不能进日志
        return { status: 'failed', cookieCount: 0, reason: 'api-error' };
      }
    },
  };
}

/** [DONE] 生产端口由后台构造时注入真实 API；此处仅声明依赖形状以便测试替换 */
export function createAppCookieInsight(api: CookiesApiLike | undefined): CookieInsightPort {
  return createCookieInsight(api);
}
