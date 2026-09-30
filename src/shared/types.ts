// sidebarmobile — 数据模型类型（shared）
// 2026-09-29 | Kimi(speckit-implement) | T018：按 data-model.md 定义全部持久化与运行时实体

import type { OriginKey } from './origin-key.ts';

/**
 * [DONE] 项目数据模型（data-model.md 的类型化表达）。
 *
 * 分层：SiteEntry/SiteSettings 属站点域；BrowserTab/HistoryEntry 属标签域；
 * SessionSnapshot 是标签域的持久化外壳；CapabilityState 是运行时计算值，**不持久化**。
 */

/** 显示模式：按精确来源保存，默认 mobile（spec FR-008） */
export type DisplayMode = 'mobile' | 'desktop';

/**
 * 授权标记（**不代表能力成功**）。
 *
 * never → granted 由用户开启开关并批准权限触发；
 * granted → revoked 由用户关闭开关或浏览器外部撤销触发（spec FR-013/FR-030）。
 * 持久化的是「用户意愿」，每次使用前必须用 permissions.contains 复核。
 */
export type GrantState = 'never' | 'granted' | 'revoked';

/** 网站条目来源：区分用户显式添加与网页导航自动加入（spec FR-019） */
export type SiteEntrySource = 'user' | 'navigation';

/** 站点入口（同一精确来源下的一个可打开地址） */
export interface EntryPoint {
  url: string;
  label: string | null;
}

/** 站点设置：按精确来源保存（spec FR-008/FR-009/FR-011/FR-038） */
export interface SiteSettings {
  displayMode: DisplayMode;
  /** 真实移动 User-Agent 授权；与 cookieGrant 严格独立 */
  uaGrant: GrantState;
  /** 登录状态复用授权；与 uaGrant 严格独立 */
  cookieGrant: GrantState;
}

/** 网站条目（spec FR-005） */
export interface SiteEntry {
  /** 序列化后的精确来源键（originKeyToString） */
  originKey: string;
  title: string;
  faviconUrl: string | null;
  entryPoints: EntryPoint[];
  settings: SiteSettings;
  addedBy: SiteEntrySource;
  createdAt: string;
  updatedAt: string;
  lastVisitedAt: string | null;
}

/** 标签页历史中的一条记录（不存页面内容，spec FR-018） */
export interface HistoryEntry {
  url: string;
  title: string | null;
  visitedAt: string;
}

/** 标签加载状态（data-model §7 状态机） */
export type TabLoadState = 'idle' | 'loading' | 'loaded' | 'failed' | 'blocked';

/** 浏览标签页（spec FR-014/FR-015） */
export interface BrowserTab {
  tabId: string;
  /** 当前 URL 的精确来源；随导航更新。无法解析时为 null（如初始空白） */
  originKey: string | null;
  currentUrl: string;
  title: string | null;
  /** 完整 URL 历史栈；长度上限 HISTORY_LIMIT */
  history: HistoryEntry[];
  /** 当前历史位置，0 ≤ index < history.length */
  historyIndex: number;
  loadState: TabLoadState;
  createdAt: string;
}

/** 会话快照：标签域的唯一持久化载体（spec FR-017） */
export interface SessionSnapshot {
  version: 1;
  tabs: BrowserTab[];
  /** 必须指向 tabs 中存在的 tabId，否则读取时置 null */
  activeTabId: string | null;
  savedAt: string;
}

/** 站点列表持久化外壳 */
export interface SiteRegistrySnapshot {
  version: 1;
  sites: SiteEntry[];
}

/** 存储元信息（迁移与诊断） */
export interface StorageMeta {
  schemaVersion: 1;
  createdAt: string;
  lastSavedAt: string;
}

/** 每个标签页最多持久化的历史条数（spec FR-015） */
export const HISTORY_LIMIT = 100;

/** 存储键空间（contracts/storage-schema.md） */
export const STORAGE_KEYS = {
  session: 'session:v1',
  sites: 'sites:v1',
  /**
   * 站点设置（显示模式 + 两项授权标记），按 originKey 索引。
   *
   * 与 sites:v1 分开存的原因：设置的"粒度"是**精确来源**，而 sites:v1 的粒度是网站条目；
   * 两者虽然当前都用 originKey 做键，但生命周期不同 —— 用户可以在尚未加入网站列表的来源上
   * 改显示模式（例如从网页导航抵达时）。侧栏与后台都读写这一条键，保证只有一份授权真相。
   */
  siteSettings: 'site-settings:v1',
  meta: 'meta:v1',
} as const;

/** 空站点设置：新增站点默认移动端、未授权（spec FR-008） */
export function createDefaultSiteSettings(): SiteSettings {
  return { displayMode: 'mobile', uaGrant: 'never', cookieGrant: 'never' };
}

/** 运行时能力状态（**不持久化**，data-model §6） */
export type UaCapabilityState = 'unknown' | 'unauthorized' | 'active' | 'degraded' | 'failed' | 'unsupported';

/**
 * Cookie 能力状态（终审 B2）。
 *
 * `absent` 与 `available` 是两档而**不是**同一档：能力可用（API 正常、权限在手）与会话是否存在
 * 是两件事。合并会让"授权了但没登录"的站点显示「已检测到会话」—— 用户据此以为登录态可用。
 */
export type CookieCapabilityState = 'unknown' | 'unauthorized' | 'available' | 'absent' | 'limited' | 'failed';

export type NavigationCapabilityState = 'tracked' | 'partial' | 'uncertain';

export type EmbedCapabilityState = 'ok' | 'suspected-blocked' | 'failed' | 'unknown';

/** 能力状态集合：界面必须如实呈现，禁止把降级显示为成功（spec FR-029） */
export interface CapabilityState {
  ua: UaCapabilityState;
  cookie: CookieCapabilityState;
  navigation: NavigationCapabilityState;
  embed: EmbedCapabilityState;
}

/** 初次打开站点时的保守能力状态 */
export function createInitialCapabilityState(): CapabilityState {
  return { ua: 'unknown', cookie: 'unknown', navigation: 'uncertain', embed: 'unknown' };
}

/** 便于在适配层之间传递的精确来源别名 */
export type { OriginKey };
