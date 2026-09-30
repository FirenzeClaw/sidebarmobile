// sidebarmobile — frame 上报的标签归属（sidebar）
// 2026-09-29 | Kimi(speckit-fix) | 终审 B4：同来源多标签时不得静默错配

import type { BrowserTab } from '../../shared/types.ts';
import { originKeyTextFromUrl } from '../../shared/origin-key.ts';

/**
 * [DONE] 由上报的 iframe URL 反查归属标签。
 *
 * **为什么必须单独成模块**：这是"把第三方页面的自述写进用户标签状态"的判定点，
 * 判错不是显示问题而是数据损坏（A 标签的页面被写进 B 标签的历史栈）。把它从装配文件里
 * 提出来，才能用穷尽的单测锁定各种歧义场景。
 *
 * 上报消息里**没有帧身份**，只有 URL，因此归属只能靠"哪些标签正处在该来源"推断。
 * 判据按可信度递减，宁可拒认也不猜：
 *
 * 1. 该来源**只有一个**标签 → 无歧义；
 * 2. 多个标签，但按"去掉 hash 后的地址"精确匹配恰好命中一个 → 是它
 *    （导航完成的 load 上报走这条：侧栏已知新地址，其余标签还停在旧地址）；
 * 3. 仍无法区分（典型：两个标签都停在同一页，其中一个 SPA 跳走了）→ 拒绝。
 *
 * 第 3 种情况拒绝的代价是"该来源的 Tier 2 推进暂停"，换来的是**不篡改用户标签**。
 * 调用方据此不记入已追踪集合，顶栏会如实显示「地址可能未同步」（FR-021），
 * 而不是假装同步好了（契约边界见 contracts/runtime-messages.md）。
 */

/** [DONE] 去掉 URL 的 hash 片段：hash 变化不产生新文档，不该影响"这是哪个标签" */
export function withoutHash(url: string): string {
  const index = url.indexOf('#');
  return index < 0 ? url : url.slice(0, index);
}

/**
 * [DONE] 由上报 URL 找归属标签；无法无歧义判定时返回 null。
 *
 * @param tabs 当前全部标签
 * @param url 上报的 iframe 地址（已过 URL 策略校验）
 */
export function findTabForFrameUrl(tabs: readonly BrowserTab[], url: string): BrowserTab | null {
  const originKey = originKeyTextFromUrl(url);
  if (originKey === null) {
    return null;
  }

  const candidates = tabs.filter((tab) => tab.originKey === originKey);
  if (candidates.length === 1) {
    return candidates[0] ?? null;
  }
  if (candidates.length === 0) {
    return null;
  }

  const target = withoutHash(url);
  const exactMatches = candidates.filter((tab) => withoutHash(tab.currentUrl) === target);
  return exactMatches.length === 1 ? (exactMatches[0] ?? null) : null;
}

/** 侧栏对一次新窗口请求的决定 */
export type OpenRequestDecision =
  | { handled: true; url: string; originKey: string }
  | { handled: false };

/**
 * [DONE] 侧栏是否接手一次新窗口请求（终审 D1，spec FR-023/FR-040）。
 *
 * **为什么这个判定必须单独成模块并被测试**：它的返回值直接决定 content script 要不要
 * 退回浏览器的普通新标签页 —— 而**没有人一并回答"谁负责开"时，两边都会开**，
 * 用户一次点击得到两个标签页（终审 D1 的现象）。契约是"恰好一个结果"：
 * 侧栏接手 → 浏览器不开；侧栏不接手 → 浏览器开。判定出错就破坏这个契约。
 *
 * 判定项：
 * 1. `url` / `sourceUrl` 形状与 URL 策略（不信任发送方）；
 * 2. `url` 必须是 http(s)：其他协议不该在侧栏内打开，由浏览器自己处理更合适；
 * 3. `sourceUrl` 的来源必须**正在被 Tier 2 追踪**（已授权）—— 未授权来源的脚本本就不该存在。
 *
 * @param url 请求打开的目标地址（未校验）
 * @param sourceUrl 发出请求的页面地址（未校验）
 * @param isTracked 该来源是否处于 Tier 2 追踪（已授权）
 */
export function decideOpenRequest(
  url: unknown,
  sourceUrl: unknown,
  isTracked: (originKey: string) => boolean,
): OpenRequestDecision {
  if (typeof url !== 'string' || url.length === 0 || typeof sourceUrl !== 'string') {
    return { handled: false };
  }

  const targetOriginKey = originKeyTextFromUrl(url);
  if (targetOriginKey === null) {
    return { handled: false };
  }

  const sourceOriginKey = originKeyTextFromUrl(sourceUrl);
  if (sourceOriginKey === null || !isTracked(sourceOriginKey)) {
    return { handled: false };
  }

  return { handled: true, url, originKey: targetOriginKey };
}
