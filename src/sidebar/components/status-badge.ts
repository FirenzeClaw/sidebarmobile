// sidebarmobile — 能力状态文案（sidebar）
// 2026-09-29 | Kimi(speckit-implement) | T039：按 ui-states.md 徽章表逐字定文案（FR-029）
// 2026-09-29 | Kimi(speckit-fix) | 终审 B2：新增 absent 档文案「未检测到会话」（无会话不得显示为已检测到会话）

import type { CapabilityState } from '../../shared/types.ts';

/**
 * [DONE] 能力状态 → 界面文案与颜色语义的唯一映射。
 *
 * 为什么单独成模块（而不是写在 status-badge.ts 里）：FR-029 是**语义约束**，不是渲染细节。
 * 把「哪个状态说什么话、用哪类颜色」集中在一处，才能被单测锁定；徽章组件只负责画出来。
 *
 * 逐字依据 contracts/ui-states.md §能力状态徽章：
 *   unauthorized        「未授权」            中性灰
 *   active / available  「真实移动 UA」/「已检测到会话」  正常色
 *   degraded            「已降级为移动视口」  警示色
 *   failed              「加载失败」          错误色
 *   uncertain / unknown 「地址可能未同步」/「未知」      中性灰
 *
 * 硬约束（spec SC-005）：禁止出现「视口模式显示为真实 UA」之类的误导文案。
 */

/** 徽章颜色语义（对应 app.css 的 .badge 变体） */
export type BadgeTone = 'neutral' | 'ok' | 'warn' | 'danger';

export interface CapabilityBadge {
  /** 面向用户的文案 */
  label: string;
  tone: BadgeTone;
}

/** [DONE] UA 能力徽章 */
export function uaBadgeFor(state: CapabilityState['ua']): CapabilityBadge {
  switch (state) {
    case 'active': {
      return { label: 'UA：真实移动 UA', tone: 'ok' };
    }
    case 'degraded': {
      return { label: 'UA：已降级为移动视口', tone: 'warn' };
    }
    case 'unsupported': {
      return { label: 'UA：当前浏览器不支持', tone: 'warn' };
    }
    case 'failed': {
      return { label: 'UA：加载失败', tone: 'danger' };
    }
    case 'unauthorized': {
      return { label: 'UA：未授权', tone: 'neutral' };
    }
    case 'unknown':
    default: {
      return { label: 'UA：未知', tone: 'neutral' };
    }
  }
}

/** [DONE] Cookie 能力徽章 */
export function cookieBadgeFor(state: CapabilityState['cookie']): CapabilityBadge {
  switch (state) {
    case 'available': {
      return { label: 'Cookie：已检测到会话', tone: 'ok' };
    }
    case 'absent': {
      // 能力可用但没会话：中性色。既不是成功（无会话可据），也不是故障（能力本身没问题）
      return { label: 'Cookie：未检测到会话', tone: 'neutral' };
    }
    case 'limited': {
      return { label: 'Cookie：能力受限', tone: 'warn' };
    }
    case 'failed': {
      return { label: 'Cookie：加载失败', tone: 'danger' };
    }
    case 'unauthorized': {
      return { label: 'Cookie：未授权', tone: 'neutral' };
    }
    case 'unknown':
    default: {
      return { label: 'Cookie：未知', tone: 'neutral' };
    }
  }
}

/** [DONE] 导航能力徽章（Tier 1 只能观察到"发生了导航"，如实标不确定） */
export function navigationBadgeFor(state: CapabilityState['navigation']): CapabilityBadge {
  switch (state) {
    case 'tracked': {
      return { label: '导航：可追踪', tone: 'ok' };
    }
    case 'partial': {
      return { label: '导航：部分可追踪', tone: 'warn' };
    }
    case 'uncertain':
    default: {
      return { label: '导航：地址可能未同步', tone: 'neutral' };
    }
  }
}

/** [DONE] 嵌入能力徽章 */
export function embedBadgeFor(state: CapabilityState['embed']): CapabilityBadge {
  switch (state) {
    case 'ok': {
      return { label: '嵌入：正常', tone: 'ok' };
    }
    case 'suspected-blocked': {
      return { label: '嵌入：疑似拒绝嵌入', tone: 'warn' };
    }
    case 'failed': {
      return { label: '嵌入：加载失败', tone: 'danger' };
    }
    case 'unknown':
    default: {
      return { label: '嵌入：未知', tone: 'neutral' };
    }
  }
}

/** [DONE] 生成某来源的完整徽章集合（顺序固定，界面按同一顺序渲染） */
export function capabilityBadges(state: CapabilityState): CapabilityBadge[] {
  return [
    uaBadgeFor(state.ua),
    cookieBadgeFor(state.cookie),
    navigationBadgeFor(state.navigation),
    embedBadgeFor(state.embed),
  ];
}

/** [DONE] 用户拒绝授权后的提示文案（runtime-messages.md 错误码表） */
export const DENIED_NOTICE = '未授权，已使用降级模式';

/** [DONE] 浏览器不支持该能力时的提示文案 */
export const UNSUPPORTED_NOTICE = '当前浏览器不支持该能力';

/**
 * [DONE] 移动/桌面模式的解释文案。
 *
 * 明确区分「视口适配」与「真实 UA」：改的是版面宽度，不是请求头（spec FR-007/SC-005）。
 */
export function displayModeHint(mode: 'mobile' | 'desktop'): string {
  return mode === 'desktop' ? '当前以桌面版面请求' : '当前以移动视口显示';
}
