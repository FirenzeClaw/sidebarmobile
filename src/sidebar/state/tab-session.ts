// sidebarmobile — 标签会话状态（sidebar）
// 2026-09-29 | Kimi(speckit-implement) | T023：实现以通过 T020（FR-014/FR-015/FR-016）
// 2026-09-30 | Kimi(fix) | 用户实测反馈：新增 goToIndex（历史面板按索引跳转，保留前向分支）

import { isNavigableUrl, normalizeUrl } from '../../shared/url-policy.ts';
import { originKeyFromUrl, originKeyToString } from '../../shared/origin-key.ts';
import { trimHistory } from '../../shared/session-store.ts';
import { HISTORY_LIMIT, type BrowserTab, type HistoryEntry, type TabLoadState } from '../../shared/types.ts';

/**
 * [DONE] 标签会话的纯状态机（不接触 DOM 与浏览器 API）。
 *
 * 职责：标签的增删切换、每标签独立历史栈、会话快照与恢复。视图层只读本模块产出的
 * 快照并渲染，所有变更走本模块方法，从而保证「视图重绘」与「状态变更」解耦（spec FR-014/FR-015）。
 *
 * 关键约束：
 * - 历史栈上限 HISTORY_LIMIT，超出淘汰最旧且保持当前项不变（spec FR-015）；
 * - 关闭标签即从状态中移除，快照随之不含该标签，重启不会恢复（spec FR-016）；
 * - 非法 URL 一律拒绝，不产生标签也不污染历史（spec FR-002/FR-003）。
 */

/** 关闭标签的结果：调用方据此决定回主页或渲染相邻标签 */
export interface CloseTabOutcome {
  closed: boolean;
  remaining: number;
  activeTabId: string | null;
}

/** 会话快照：与 SessionSnapshot 的存储字段同形，但不含 version/savedAt（由存储层补齐） */
export interface TabSessionSnapshot {
  tabs: BrowserTab[];
  activeTabId: string | null;
}

export interface TabSessionOptions {
  /** 标签 ID 工厂；注入以便测试可预期，且避免依赖 crypto（侧栏可能非安全上下文） */
  createId: () => string;
  /** 时间工厂；注入以便断言历史时间戳 */
  now: () => string;
}

export interface TabSession {
  openTab(url: string): BrowserTab | null;
  closeTab(tabId: string): CloseTabOutcome;
  activateTab(tabId: string): boolean;
  navigate(tabId: string, url: string): BrowserTab | null;
  goBack(tabId: string): BrowserTab | null;
  goForward(tabId: string): BrowserTab | null;
  /**
   * 跳到历史栈中的指定位置（九宫格「历史」面板的点击）。
   *
   * 与 `navigate` 的关键区别：**这是"移动"而不是"新导航"** —— 栈原样保留，
   * 当前项之后的前向分支不会被截断。放在状态层是因为"哪些操作会截断历史"是数据模型规则
   * （spec FR-015/FR-018），散到界面层就会漂移。
   *
   * 跳到当前项、越界、非整数索引、标签不存在一律返回 null 且不产生通知。
   */
  goToIndex(tabId: string, index: number): BrowserTab | null;
  canGoBack(tabId: string): boolean;
  canGoForward(tabId: string): boolean;
  setLoadState(tabId: string, loadState: TabLoadState): boolean;
  setTitle(tabId: string, title: string | null): boolean;
  getTabs(): BrowserTab[];
  getTab(tabId: string): BrowserTab | null;
  getActiveTab(): BrowserTab | null;
  getActiveTabId(): string | null;
  snapshot(): TabSessionSnapshot;
  restore(snapshot: TabSessionSnapshot): void;
  /** 订阅状态变更（用于防抖持久化）；返回退订函数 */
  onChange(listener: () => void): () => void;
}

/** [DONE] 规范化一次的导航目标：非法或非 http(s) 返回 null */
function resolveNavigation(url: string): { url: string; originKey: string | null } | null {
  if (!isNavigableUrl(url)) {
    return null;
  }
  const normalized = normalizeUrl(url);
  const originKey = originKeyFromUrl(normalized);
  return { url: normalized, originKey: originKey === null ? null : originKeyToString(originKey) };
}

/** [DONE] 恢复时的单条校验：无法修复的记录返回 null（spec FR-031 粒度丢弃） */
function normalizeRestoredTab(value: unknown): BrowserTab | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as Partial<BrowserTab>;
  if (typeof candidate.tabId !== 'string' || candidate.tabId.length === 0) {
    return null;
  }
  if (typeof candidate.currentUrl !== 'string' || !isNavigableUrl(candidate.currentUrl)) {
    return null;
  }

  const historySource = Array.isArray(candidate.history) ? candidate.history : [];
  const history: HistoryEntry[] = [];
  for (const entry of historySource) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const restoredEntry = entry as Partial<HistoryEntry>;
    if (typeof restoredEntry.url !== 'string' || !isNavigableUrl(restoredEntry.url)) {
      continue;
    }
    history.push({
      url: normalizeUrl(restoredEntry.url),
      title: typeof restoredEntry.title === 'string' ? restoredEntry.title : null,
      visitedAt: typeof restoredEntry.visitedAt === 'string' ? restoredEntry.visitedAt : new Date(0).toISOString(),
    });
  }
  if (history.length === 0) {
    return null;
  }

  const rawIndex = candidate.historyIndex;
  if (typeof rawIndex !== 'number' || !Number.isInteger(rawIndex) || rawIndex < 0 || rawIndex >= history.length) {
    return null;
  }

  const trimmed = trimHistory(history, rawIndex);
  const currentUrl = normalizeUrl(candidate.currentUrl);
  const originKey = originKeyFromUrl(currentUrl);

  return {
    tabId: candidate.tabId,
    originKey: originKey === null ? null : originKeyToString(originKey),
    currentUrl,
    title: typeof candidate.title === 'string' ? candidate.title : null,
    history: trimmed.history,
    historyIndex: trimmed.historyIndex,
    loadState: normalizeLoadState(candidate.loadState),
    createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date(0).toISOString(),
  };
}

const VALID_LOAD_STATES: readonly TabLoadState[] = ['idle', 'loading', 'loaded', 'failed', 'blocked'];

function normalizeLoadState(value: unknown): TabLoadState {
  return typeof value === 'string' && (VALID_LOAD_STATES as readonly string[]).includes(value)
    ? (value as TabLoadState)
    : 'idle';
}

/** [DONE] 创建标签会话状态机 */
export function createTabSession(options: TabSessionOptions): TabSession {
  let tabs: BrowserTab[] = [];
  let activeTabId: string | null = null;
  const listeners = new Set<() => void>();

  /** [DONE] 通知订阅者；视图重绘与持久化都挂在这里 */
  function notify(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  /** [DONE] 生成不与现有标签冲突的 ID（恢复后继续开标签时避免撞号） */
  function nextTabId(): string {
    const generated = options.createId();
    if (!tabs.some((tab) => tab.tabId === generated)) {
      return generated;
    }
    let suffix = 2;
    while (tabs.some((tab) => tab.tabId === `${generated}-${suffix}`)) {
      suffix += 1;
    }
    return `${generated}-${suffix}`;
  }

  /** [DONE] 原位替换单个标签并保留其余引用，避免整表重排 */
  function replaceTab(tabId: string, updater: (tab: BrowserTab) => BrowserTab): BrowserTab | null {
    const index = tabs.findIndex((tab) => tab.tabId === tabId);
    if (index < 0) {
      return null;
    }
    const current = tabs[index];
    if (current === undefined) {
      return null;
    }
    const updated = updater(current);
    const nextTabs = [...tabs];
    nextTabs[index] = updated;
    tabs = nextTabs;
    return updated;
  }

  /** [DONE] 把一次导航结果写入历史：先截断前向分支再追加（浏览器前进语义） */
  function applyNavigation(tabId: string, target: { url: string; originKey: string | null }, title: string | null): BrowserTab | null {
    return replaceTab(tabId, (tab) => {
      const truncated = tab.history.slice(0, tab.historyIndex + 1);
      const appended = [...truncated, { url: target.url, title, visitedAt: options.now() }];
      // 上限裁剪集中在 trimHistory：保证裁剪后当前项仍是同一页面（spec FR-015）
      const trimmed = trimHistory(appended, appended.length - 1);
      return {
        ...tab,
        currentUrl: target.url,
        originKey: target.originKey,
        title,
        history: trimmed.history,
        historyIndex: trimmed.historyIndex,
        loadState: 'loading',
      };
    });
  }

  /** [DONE] 按历史索引定位并同步 URL/标题/来源（后退前进共用的收敛点） */
  function moveToIndex(tabId: string, targetIndex: number): BrowserTab | null {
    return replaceTab(tabId, (tab) => {
      const entry = tab.history[targetIndex];
      if (entry === undefined) {
        return tab;
      }
      const originKey = originKeyFromUrl(entry.url);
      return {
        ...tab,
        currentUrl: entry.url,
        originKey: originKey === null ? null : originKeyToString(originKey),
        title: entry.title,
        historyIndex: targetIndex,
        loadState: 'loading',
      };
    });
  }

  /**
   * [DONE] 历史栈内移动的统一入口：校验目标索引 → 应用 → 通知。
   *
   * 后退与前进最初各自写了一遍"算索引 + 校验 + 通知"，差异只在目标索引怎么算；
   * 新增的按索引跳转（历史面板）是第三条同型路径。收敛到一处后，越界与"跳到当前项"
   * 这类边界只有一份实现，新增入口也不会漏掉通知 —— 漏掉的表现是：地址变了，
   * 但底栏后退/前进按钮的状态停留在切换前。
   */
  function moveWithinHistory(tabId: string, targetIndex: number): BrowserTab | null {
    const tab = tabs.find((candidate) => candidate.tabId === tabId);
    if (tab === undefined) {
      return null;
    }
    // 非整数索引会取到 undefined 项；越界与原地不动都不产生导航
    if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= tab.history.length) {
      return null;
    }
    if (targetIndex === tab.historyIndex) {
      return null;
    }
    const updated = moveToIndex(tabId, targetIndex);
    if (updated === null) {
      return null;
    }
    notify();
    return updated;
  }

  return {
    openTab(url: string): BrowserTab | null {
      const target = resolveNavigation(url);
      if (target === null) {
        return null;
      }
      // 一次开标签只取一次时间：创建时刻与首次访问时刻相同，避免同一次操作产生两个时间戳
      const openedAt = options.now();
      const tab: BrowserTab = {
        tabId: nextTabId(),
        originKey: target.originKey,
        currentUrl: target.url,
        title: null,
        history: [{ url: target.url, title: null, visitedAt: openedAt }],
        historyIndex: 0,
        loadState: 'loading',
        createdAt: openedAt,
      };
      tabs = [...tabs, tab];
      activeTabId = tab.tabId;
      notify();
      return tab;
    },

    closeTab(tabId: string): CloseTabOutcome {
      const index = tabs.findIndex((tab) => tab.tabId === tabId);
      if (index < 0) {
        return { closed: false, remaining: tabs.length, activeTabId };
      }

      const closingActive = tabs[index]?.tabId === activeTabId;
      const nextTabs = tabs.filter((tab) => tab.tabId !== tabId);
      tabs = nextTabs;

      if (nextTabs.length === 0) {
        activeTabId = null;
      } else if (closingActive) {
        // 接管同位置的相邻标签；关掉末尾则回退到新的末尾
        const successor = nextTabs[Math.min(index, nextTabs.length - 1)];
        activeTabId = successor === undefined ? null : successor.tabId;
      }

      notify();
      return { closed: true, remaining: nextTabs.length, activeTabId };
    },

    activateTab(tabId: string): boolean {
      if (!tabs.some((tab) => tab.tabId === tabId) || activeTabId === tabId) {
        return false;
      }
      activeTabId = tabId;
      notify();
      return true;
    },

    navigate(tabId: string, url: string): BrowserTab | null {
      const target = resolveNavigation(url);
      if (target === null || !tabs.some((tab) => tab.tabId === tabId)) {
        return null;
      }
      const updated = applyNavigation(tabId, target, null);
      if (updated === null) {
        return null;
      }
      notify();
      return updated;
    },

    goBack(tabId: string): BrowserTab | null {
      const tab = tabs.find((candidate) => candidate.tabId === tabId);
      if (tab === undefined) {
        return null;
      }
      return moveWithinHistory(tabId, tab.historyIndex - 1);
    },

    goForward(tabId: string): BrowserTab | null {
      const tab = tabs.find((candidate) => candidate.tabId === tabId);
      if (tab === undefined) {
        return null;
      }
      return moveWithinHistory(tabId, tab.historyIndex + 1);
    },

    goToIndex(tabId: string, index: number): BrowserTab | null {
      return moveWithinHistory(tabId, index);
    },

    canGoBack(tabId: string): boolean {
      const tab = tabs.find((candidate) => candidate.tabId === tabId);
      return tab !== undefined && tab.historyIndex > 0;
    },

    canGoForward(tabId: string): boolean {
      const tab = tabs.find((candidate) => candidate.tabId === tabId);
      return tab !== undefined && tab.historyIndex < tab.history.length - 1;
    },

    setLoadState(tabId: string, loadState: TabLoadState): boolean {
      const current = tabs.find((tab) => tab.tabId === tabId);
      if (current === undefined || current.loadState === loadState) {
        return false;
      }
      replaceTab(tabId, (tab) => ({ ...tab, loadState }));
      notify();
      return true;
    },

    setTitle(tabId: string, title: string | null): boolean {
      const current = tabs.find((tab) => tab.tabId === tabId);
      if (current === undefined || current.title === title) {
        return false;
      }
      replaceTab(tabId, (tab) => {
        // 标题同时写回当前历史项：恢复历史位置时标题不会退回旧值
        const history = tab.history.map((entry, index) =>
          index === tab.historyIndex ? { ...entry, title } : entry,
        );
        return { ...tab, title, history };
      });
      notify();
      return true;
    },

    getTabs(): BrowserTab[] {
      return [...tabs];
    },

    getTab(tabId: string): BrowserTab | null {
      return tabs.find((tab) => tab.tabId === tabId) ?? null;
    },

    getActiveTab(): BrowserTab | null {
      if (activeTabId === null) {
        return null;
      }
      return tabs.find((tab) => tab.tabId === activeTabId) ?? null;
    },

    getActiveTabId(): string | null {
      return activeTabId;
    },

    snapshot(): TabSessionSnapshot {
      return { tabs: [...tabs], activeTabId };
    },

    restore(snapshot: TabSessionSnapshot): void {
      const restoredTabs: BrowserTab[] = [];
      for (const raw of snapshot.tabs) {
        const tab = normalizeRestoredTab(raw);
        if (tab !== null) {
          restoredTabs.push(tab);
        }
      }
      tabs = restoredTabs;
      // 活动标签必须指向存在的标签，否则置空（data-model §5 校验规则）
      const restoredActive = snapshot.activeTabId;
      activeTabId =
        typeof restoredActive === 'string' && restoredTabs.some((tab) => tab.tabId === restoredActive)
          ? restoredActive
          : null;
      notify();
    },

    onChange(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** [DONE] 供视图层复用的上限常量出口，避免各处重复 import shared/types */
export { HISTORY_LIMIT };
