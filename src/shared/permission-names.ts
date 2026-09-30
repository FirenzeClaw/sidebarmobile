// sidebarmobile — 可选权限名单（shared）
// 2026-09-29 | Kimi(speckit-implement) | T035：把权限名单与浏览器 API 出口分离，使权限适配层可被单测
// 2026-09-29 | Kimi(speckit-implement) | T055：按 web-ext lint 实测修正 Firefox 侧的 DNR 权限名
// 2026-09-29 | Kimi(speckit-fix) | 终审 A3：两项授权均申请 scripting（此前从不申请，Tier 2 全链路不可达）
// 2026-09-29 | Kimi(speckit-fix) | 终审 A3 联动：撤销权限改为逐权限名判断（共享 host 权限 pattern 下避免连带撤销）

import type { GrantKind } from './messages.ts';

/**
 * [DONE] 本项目实际使用的可选权限名（contracts/manifest-permissions.md）。
 *
 * 为什么单独成文件：名单是**纯数据**，而 `adapters/browser-api.ts` 会 import
 * `webextension-polyfill`（该模块在非扩展上下文会直接抛错）。把名单放在这里，
 * 权限适配层就能在不拉起 polyfill 的前提下做单测；`browser-api.ts` 仍然对外
 * 转出同一份名单，公开契约不变。
 */

/**
 * [DONE] DNR 能力在两端的声明位置不同（T055 用 `web-ext lint` 实测发现，非文档推断）。
 *
 * 实测事实：
 * - Chrome：`declarativeNetRequestWithHostAccess` 可作为**可选权限**按需申请；
 * - Firefox：DNR 权限**不能是可选权限** —— web-ext lint 对 `declarativeNetRequest` 与
 *   `declarativeNetRequestWithHostAccess` 都报 `MANIFEST_OPTIONAL_PERMISSIONS: Invalid`，
 *   它只能在 `permissions` 里声明。
 *
 * 因此本项目分平台处理：
 * - Chrome：DNR 走可选权限，用户开启某来源的真实 UA 时才申请（严格满足 FR-035）；
 * - Firefox：DNR API 权限随安装声明，但**真正决定"能改哪个站点"的 host 权限仍是按需、按来源申请**。
 *   单独持有 DNR API 权限不足以修改任何请求（没有 host 权限就没有可命中的 requestDomains），
 *   因此这不构成越权 —— 这只是 Firefox 平台把"能力存在"与"对某站点生效"拆成了两层。
 *
 * 该差异在**构建期**由 `__BROWSER__` 编译常量决定，运行时不判断浏览器（宪法 VII）。
 */
export const DNR_PERMISSION_BY_PLATFORM = {
  chrome: 'declarativeNetRequestWithHostAccess',
  firefox: 'declarativeNetRequest',
} as const;

/** 构建期注入的浏览器标识；未注入时按 chrome 处理（单测环境即如此） */
declare const __BROWSER__: string | undefined;

/** [DONE] 当前构建目标（构建期常量，不是运行时嗅探） */
export function currentPlatform(): 'chrome' | 'firefox' {
  return typeof __BROWSER__ !== 'undefined' && __BROWSER__ === 'firefox' ? 'firefox' : 'chrome';
}

/** [DONE] 当前平台可**作为可选权限申请**的名单（Firefox 不含 DNR，见上） */
export const OPTIONAL_PERMISSION_NAMES: readonly string[] = [
  'cookies',
  'scripting',
  ...(currentPlatform() === 'chrome' ? [DNR_PERMISSION_BY_PLATFORM.chrome] : []),
];

/**
 * 权限名的字面量联合。
 *
 * 类型收紧的理由：chrome 类型把权限名限定为字面量联合，宽 string[] 无法直接传递。
 * 这里同时收录两端的 DNR 名字（同一套源码要服务两个平台），并额外允许 string —— 因为
 * 平台名是在构建期决定的常量，类型系统无法在编译期把它收敛成单个字面量。
 * 放宽的是**类型**，不是校验：`createPermissionsPort` 仍按 OPTIONAL_PERMISSION_NAMES 过滤。
 */
export type OptionalPermissionName =
  | 'cookies'
  | 'scripting'
  | 'declarativeNetRequest'
  | 'declarativeNetRequestWithHostAccess';

/**
 * [DONE] 某项授权需要**在授权时申请**的 API 权限名列表。
 *
 * 两项授权都会一并申请 `scripting`（终审 A3 修复）：Tier 2 的 content script 注入需要它，
 * 而它是 optional —— 不申请就永远是 undefined，导致 `frame.report`/`frame.open-request`
 * 永不产生（追踪永为 uncertain、嵌入永不到 ok）。契约 `manifest-permissions.md:32` 正是这样要求的：
 * 「任一开关闭启后 → `scripting`」。申请它不扩大实际权限面：真正限定"能注入哪个站点"的是
 * 同一批申请里的 host 权限（origins），没有 host 权限时 scripting 本身不足以注入任何站点。
 *
 * Firefox 的 UA 授权不申请 DNR 名字：该权限随安装声明（Firefox 不接受它作为可选权限，
 * 见 T055 的 web-ext lint 实测），此刻真正要申请的是该来源的 host 权限（由调用方附加 origins）。
 */
export function apiPermissionForGrant(grant: GrantKind): OptionalPermissionName[] {
  if (grant !== 'ua') {
    return ['cookies', 'scripting'];
  }
  return currentPlatform() === 'chrome'
    ? [DNR_PERMISSION_BY_PLATFORM.chrome, 'scripting']
    : ['scripting'];
}
