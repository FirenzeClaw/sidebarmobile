// sidebarmobile — 会话存储（shared）
// 2026-09-29 | Kimi(speckit-implement) | T017：实现以通过 T016（contracts/storage-schema.md）
// 2026-09-29 | Kimi(speckit-fix) | 终审 A1/A2：新增 onChanged 订阅通道；saveSiteSettings 改按字段合并写入，避免整份快照覆盖抹掉授权标记

import { isNavigableUrl, normalizeUrl } from './url-policy.ts';
import { originKeyFromUrl, originKeyToString } from './origin-key.ts';
import {
  HISTORY_LIMIT,
  STORAGE_KEYS,
  type BrowserTab,
  type HistoryEntry,
  type SessionSnapshot,
  type SiteEntry,
  type SiteSettings,
  type StorageMeta,
  type TabLoadState,
} from './types.ts';

/**
 * [DONE] 会话与站点列表的持久化层。
 *
 * 设计要点：
 * - 存储后端是 storage.local（MV3 SW 无常驻状态，持久态必须落 storage，宪法 III）。
 * - 读取一律做逐条校验，坏记录**粒度化丢弃**而非整份作废（spec FR-031）。
 * - 写入失败重试一次，再失败返回结构化结果而非抛异常（spec FR-032）；
 *   调用方据此提示「会话可能无法完整恢复」。
 * - 本模块只认 http(s) URL；Cookie 值、密码、表单、页面内容永不写入（spec FR-018/FR-033）。
 */

/** 存储变更事件：键 → 新值（与 browser.storage.onChanged 的形状一致） */
export interface StorageChange {
  newValue?: unknown;
  oldValue?: unknown;
}

/** 存储后端抽象：便于用 mock 替换（真实使用时传入 browser.storage.local） */
export interface StorageArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  /**
   * 订阅**任意写入者**对存储的改动（终审 A1）。
   *
   * 为什么必需：授权标记的唯一写入者是后台，它与侧栏不在同一上下文。没有这条通道，
   * 侧栏只能看到自己写的东西 —— "用户点了允许、界面开关仍关"就是这么来的。
   * 由适配层接 `browser.storage.onChanged` 实现；测试替身同理。
   * 未实现该方法的后端视为不支持外部变更通知（订阅者只会看到自己触发的写入）。
   */
  onChanged?(listener: (changes: Record<string, StorageChange>) => void): () => void;
}

/** 写入结果：persisted 为 false 时 UI 应提示会话可能无法完整恢复 */
export interface SaveResult {
  persisted: boolean;
  reason?: 'storage-failed';
}

/**
 * 读取诊断：报告本次读取丢弃了多少坏记录。
 *
 * 为什么需要它：粒度丢弃是**静默**的（spec FR-031 只要求"不影响其余数据"），
 * 但用户有权知道"我的几个标签没恢复" —— 否则只会看到标签无声消失而不知原因。
 * 由 `loadSessionWithDiagnostics` 之类的方法填充，`loadSession` 保持原签名不变，
 * 以免既有调用方与测试受影响。
 */
export interface LoadDiagnostics {
  /** 存储中原始记录的条数（丢弃前） */
  rawCount: number;
  /** 成功通过校验的条数 */
  acceptedCount: number;
  /** 被丢弃的条数 */
  discardedCount: number;
}

/** 会话读写接口 */
export interface SessionStore {
  loadSession(): Promise<SessionSnapshot>;
  /**
   * 同 loadSession，但额外回报丢弃诊断。
   *
   * 恢复路径用这个版本，以便把"部分数据未能恢复"如实告知用户（spec FR-032）。
   */
  loadSessionWithDiagnostics(): Promise<{ session: SessionSnapshot; diagnostics: LoadDiagnostics }>;
  saveSession(snapshot: Omit<SessionSnapshot, 'version' | 'savedAt'>): Promise<SaveResult>;
  saveSessionDebounced(snapshot: Omit<SessionSnapshot, 'version' | 'savedAt'>, delayMs?: number): Promise<SaveResult | null>;
  loadSites(): Promise<SiteEntry[]>;
  loadSitesWithDiagnostics(): Promise<{ sites: SiteEntry[]; diagnostics: LoadDiagnostics }>;
  saveSites(sites: SiteEntry[]): Promise<SaveResult>;
  /**
   * 读取站点设置（originKey → SiteSettings）。
   *
   * 与 loadSites 分开：设置的粒度是精确来源，且用户可以在来源尚未成为网站条目时就改设置。
   * 读取时逐条校验，坏记录粒度丢弃（spec FR-031），非法字段回落默认值。
   */
  loadSiteSettings(): Promise<Record<string, SiteSettings>>;
  saveSiteSettings(settings: Record<string, SiteSettings>): Promise<SaveResult>;
  /**
   * 订阅外部对站点设置的改动（终审 A1）。
   *
   * 授权标记的唯一写入者是后台；侧栏订阅这条通道，才能把"用户点了允许"如实反映到开关上。
   * 事件源是 `StorageArea.onChanged`（浏览器保证任何写入者都会被通知），不是自造的转发消息。
   * 返回退订函数。
   */
  onSiteSettingsChanged(listener: (settings: Record<string, SiteSettings>) => void): () => void;
  /**
   * 订阅每次写入的结果（spec FR-032）。
   *
   * 主要给**防抖路径**用：那条路径没有调用方可以接收返回值，失败会静默丢失。
   * 订阅后界面能在写入失败时显示「会话可能无法完整恢复」。
   * 返回退订函数。
   */
  onWriteResult(listener: (result: SaveResult) => void): () => void;
  flushPendingWrites(): Promise<SaveResult | null>;
}

const DEFAULT_DEBOUNCE_MS = 300;

/** 空会话常量；每次返回新对象，避免调用方意外共享引用 */
function emptySession(): SessionSnapshot {
  return { version: 1, tabs: [], activeTabId: null, savedAt: new Date(0).toISOString() };
}

/** 判断值是否为普通对象 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * [DONE] 裁剪历史到上限。
 *
 * 契约：保留**最新**的 HISTORY_LIMIT 条；同时平移 historyIndex，
 * 保证裁剪后当前项仍是同一页面（spec FR-015）。
 */
export function trimHistory(
  history: HistoryEntry[],
  historyIndex: number,
): { history: HistoryEntry[]; historyIndex: number } {
  if (history.length <= HISTORY_LIMIT) {
    const clampedIndex = Math.min(Math.max(historyIndex, 0), Math.max(history.length - 1, 0));
    return { history, historyIndex: clampedIndex };
  }

  const overflow = history.length - HISTORY_LIMIT;
  const trimmedHistory = history.slice(overflow);
  const shiftedIndex = historyIndex - overflow;
  const clampedIndex = Math.min(Math.max(shiftedIndex, 0), trimmedHistory.length - 1);
  return { history: trimmedHistory, historyIndex: clampedIndex };
}

/** [DONE] 校验并规范化单条历史；非法返回 null */
function normalizeHistoryEntry(value: unknown): HistoryEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const url = value['url'];
  if (!isNavigableUrl(url)) {
    return null;
  }
  const title = typeof value['title'] === 'string' ? value['title'] : null;
  const visitedAt = typeof value['visitedAt'] === 'string' ? value['visitedAt'] : new Date(0).toISOString();
  return { url: normalizeUrl(url), title, visitedAt };
}

const VALID_LOAD_STATES: readonly TabLoadState[] = ['idle', 'loading', 'loaded', 'failed', 'blocked'];

/** [DONE] 校验并规范化单个标签页；不可修复时返回 null（调用方丢弃该条） */
function normalizeTab(value: unknown): BrowserTab | null {
  if (!isRecord(value)) {
    return null;
  }
  const tabId = value['tabId'];
  const currentUrl = value['currentUrl'];
  if (typeof tabId !== 'string' || tabId.length === 0 || !isNavigableUrl(currentUrl)) {
    return null;
  }

  const rawHistory = Array.isArray(value['history']) ? value['history'] : [];
  const normalizedHistory = rawHistory
    .map((entry) => normalizeHistoryEntry(entry))
    .filter((entry): entry is HistoryEntry => entry !== null);

  if (normalizedHistory.length === 0) {
    return null;
  }

  // 越界或非整数的 historyIndex 视为损坏记录：静默钳制会让「当前页」与历史错位，
  // 因此按 spec FR-031 直接丢弃该标签，由其余标签继续加载。
  const rawIndex = value['historyIndex'];
  if (typeof rawIndex !== 'number' || !Number.isInteger(rawIndex) || rawIndex < 0 || rawIndex >= normalizedHistory.length) {
    return null;
  }

  const { history, historyIndex } = trimHistory(normalizedHistory, rawIndex);

  const loadStateCandidate = value['loadState'];
  const loadState: TabLoadState =
    typeof loadStateCandidate === 'string' && (VALID_LOAD_STATES as readonly string[]).includes(loadStateCandidate)
      ? (loadStateCandidate as TabLoadState)
      : 'idle';

  const parsedOriginKey = originKeyFromUrl(currentUrl);

  return {
    tabId,
    originKey: parsedOriginKey === null ? null : originKeyToString(parsedOriginKey),
    currentUrl: normalizeUrl(currentUrl),
    title: typeof value['title'] === 'string' ? value['title'] : null,
    history,
    historyIndex,
    loadState,
    createdAt: typeof value['createdAt'] === 'string' ? value['createdAt'] : new Date(0).toISOString(),
  };
}

/** [DONE] 校验站点设置；缺失字段回落到默认值（向后兼容旧数据） */
function normalizeSettings(value: unknown): SiteEntry['settings'] {
  const fallback = { displayMode: 'mobile' as const, uaGrant: 'never' as const, cookieGrant: 'never' as const };
  if (!isRecord(value)) {
    return fallback;
  }
  const displayMode = value['displayMode'] === 'desktop' ? 'desktop' : 'mobile';
  const uaGrant = normalizeGrant(value['uaGrant']);
  const cookieGrant = normalizeGrant(value['cookieGrant']);
  return { displayMode, uaGrant, cookieGrant };
}

function normalizeGrant(value: unknown): 'never' | 'granted' | 'revoked' {
  return value === 'granted' || value === 'revoked' ? value : 'never';
}

/** [DONE] 校验并规范化站点条目；来源非法则返回 null */
function normalizeSite(value: unknown): SiteEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const originKeyText = value['originKey'];
  if (typeof originKeyText !== 'string' || originKeyFromUrl(originKeyText) === null) {
    return null;
  }

  const rawEntryPoints = Array.isArray(value['entryPoints']) ? value['entryPoints'] : [];
  const entryPoints = rawEntryPoints
    .map((entry) => {
      if (!isRecord(entry) || !isNavigableUrl(entry['url'])) {
        return null;
      }
      return { url: normalizeUrl(entry['url']), label: typeof entry['label'] === 'string' ? entry['label'] : null };
    })
    .filter((entry): entry is { url: string; label: string | null } => entry !== null);

  if (entryPoints.length === 0) {
    return null;
  }

  const now = new Date(0).toISOString();
  return {
    originKey: originKeyText,
    title: typeof value['title'] === 'string' && value['title'].length > 0 ? value['title'] : originKeyText,
    faviconUrl: typeof value['faviconUrl'] === 'string' ? value['faviconUrl'] : null,
    entryPoints,
    settings: normalizeSettings(value['settings']),
    addedBy: value['addedBy'] === 'navigation' ? 'navigation' : 'user',
    createdAt: typeof value['createdAt'] === 'string' ? value['createdAt'] : now,
    updatedAt: typeof value['updatedAt'] === 'string' ? value['updatedAt'] : now,
    lastVisitedAt: typeof value['lastVisitedAt'] === 'string' ? value['lastVisitedAt'] : null,
  };
}

/** [DONE] 创建会话存储实例 */
export function createSessionStore(storage: StorageArea, debounceMs: number = DEFAULT_DEBOUNCE_MS): SessionStore {
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingSnapshot: Omit<SessionSnapshot, 'version' | 'savedAt'> | null = null;

  /**
   * 写入结果订阅者（spec FR-032）。
   *
   * 为什么必需：**防抖路径没有调用方可以接收返回值** —— 定时器回调里写入失败后，
   * 没有任何人知道，用户会以为数据安全但实际上没落盘。这个通道让"存储失败"这件事
   * 能传到界面（顶部警示条「会话可能无法完整恢复」），而不是被静默吞掉。
   */
  const writeListeners = new Set<(result: SaveResult) => void>();

  /**
   * 站点设置变更订阅者（终审 A1）。
   *
   * 授权标记的唯一写入者是后台，侧栏必须能感知它的写入 —— 否则"用户点了允许、
   * 界面开关仍关"。由适配层接 `storage.onChanged` 后调用 `emitSiteSettingsChanged` 分发。
   */
  const settingsListeners = new Set<(settings: Record<string, SiteSettings>) => void>();

  /** [DONE] 通知订阅者一次写入结果 */
  function emitWriteResult(result: SaveResult): void {
    for (const listener of writeListeners) {
      try {
        listener(result);
      } catch {
        // 订阅者自身出错不该影响存储层：记录一次失败没有任何意义，直接忽略
      }
    }
  }

  /** [DONE] 读取并逐条校验站点设置；坏记录粒度丢弃（spec FR-031） */
  async function readSiteSettings(): Promise<Record<string, SiteSettings>> {
    const raw = await storage.get(STORAGE_KEYS.siteSettings);
    const stored = raw[STORAGE_KEYS.siteSettings];
    if (!isRecord(stored)) {
      return {};
    }
    const restored: Record<string, SiteSettings> = {};
    for (const [originKey, value] of Object.entries(stored)) {
      // 来源键非法则丢弃该条；字段非法则回落默认值（spec FR-031 粒度丢弃）
      if (originKeyFromUrl(originKey) === null) {
        continue;
      }
      restored[originKey] = normalizeSettings(value);
    }
    return restored;
  }

  /** [DONE] 由适配层调用：把一个外部的设置变更分发给订阅者 */
  function emitSiteSettingsChanged(settings: Record<string, SiteSettings>): void {
    for (const listener of settingsListeners) {
      try {
        listener(settings);
      } catch {
        // 订阅者自身出错不影响存储层
      }
    }
  }

  /**
   * [DONE] 订阅存储后端的改动，把**他人写入**的站点设置分发出去（终审 A1）。
   *
   * 为什么在这里而不是在适配层：读取与校验规则属于存储层（坏记录粒度丢弃、字段回落默认值），
   * 让订阅者各自解析一遍原始值会造成同一份数据两套解读。这里统一读成已校验的映射再分发。
   *
   * 生命周期：存储实例与页面同寿，不需要退订点（侧栏/后台都不会中途换 store）。
   * 后端不提供 onChanged（部分测试替身）时不订阅：此时没有外部写入的概念，行为不变。
   */
  if (typeof storage.onChanged === 'function') {
    storage.onChanged((changes) => {
      if (!(STORAGE_KEYS.siteSettings in changes)) {
        return;
      }
      void readSiteSettings().then(
        (settings) => {
          emitSiteSettingsChanged(settings);
        },
        () => {
          // 读取失败不发事件：宁可不通知，也不要把"读不到"谎报成"设置被清空"
        },
      );
    });
  }

  /** [DONE] 带一次重试的写入；失败返回结构化结果，并广播给订阅者（FR-032） */
  async function writeWithRetry(items: Record<string, unknown>): Promise<SaveResult> {
    let result: SaveResult;
    try {
      await storage.set(items);
      result = { persisted: true };
    } catch {
      try {
        await storage.set(items);
        result = { persisted: true };
      } catch {
        result = { persisted: false, reason: 'storage-failed' };
      }
    }
    emitWriteResult(result);
    return result;
  }

  /** [DONE] 组装并落盘会话；写入前统一裁剪历史 */
  async function persistSession(snapshot: Omit<SessionSnapshot, 'version' | 'savedAt'>): Promise<SaveResult> {
    const tabs = snapshot.tabs
      .map((tab) => {
        const { history, historyIndex } = trimHistory(tab.history, tab.historyIndex);
        return { ...tab, history, historyIndex };
      })
      .filter((tab) => tab.history.length > 0);

    const activeTabId =
      snapshot.activeTabId !== null && tabs.some((tab) => tab.tabId === snapshot.activeTabId)
        ? snapshot.activeTabId
        : null;

    const session: SessionSnapshot = {
      version: 1,
      tabs,
      activeTabId,
      savedAt: new Date().toISOString(),
    };

    const meta: StorageMeta = {
      schemaVersion: 1,
      createdAt: new Date(0).toISOString(),
      lastSavedAt: session.savedAt,
    };

    return writeWithRetry({ [STORAGE_KEYS.session]: session, [STORAGE_KEYS.meta]: meta });
  }

  return {
    async loadSession(): Promise<SessionSnapshot> {
      const { session } = await this.loadSessionWithDiagnostics();
      return session;
    },

    /**
     * [DONE] 读取会话并回报丢弃诊断（spec FR-031/FR-032）。
     *
     * 与 loadSession 的唯一区别是多返回一份计数；校验逻辑完全共用，避免两套实现漂移。
     */
    async loadSessionWithDiagnostics(): Promise<{ session: SessionSnapshot; diagnostics: LoadDiagnostics }> {
      const raw = await storage.get(STORAGE_KEYS.session);
      const stored = raw[STORAGE_KEYS.session];
      if (!isRecord(stored)) {
        // 顶层结构损坏：整份作废，但这不是"丢了几条"，而是"这份数据不可用"
        return { session: emptySession(), diagnostics: { rawCount: 0, acceptedCount: 0, discardedCount: 0 } };
      }

      const rawTabs = Array.isArray(stored['tabs']) ? stored['tabs'] : [];
      const tabs = rawTabs.map((tab) => normalizeTab(tab)).filter((tab): tab is BrowserTab => tab !== null);

      const rawActiveTabId = stored['activeTabId'];
      const activeTabId =
        typeof rawActiveTabId === 'string' && tabs.some((tab) => tab.tabId === rawActiveTabId) ? rawActiveTabId : null;

      return {
        session: {
          version: 1,
          tabs,
          activeTabId,
          savedAt: typeof stored['savedAt'] === 'string' ? stored['savedAt'] : new Date(0).toISOString(),
        },
        diagnostics: {
          rawCount: rawTabs.length,
          acceptedCount: tabs.length,
          discardedCount: rawTabs.length - tabs.length,
        },
      };
    },

    async saveSession(snapshot): Promise<SaveResult> {
      return persistSession(snapshot);
    },

    async saveSessionDebounced(snapshot, delay = debounceMs): Promise<SaveResult | null> {
      pendingSnapshot = snapshot;
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
      }
      pendingTimer = setTimeout(() => {
        const snapshotToWrite = pendingSnapshot;
        pendingTimer = null;
        pendingSnapshot = null;
        if (snapshotToWrite !== null) {
          /**
           * 失败详情已经由 writeWithRetry 广播给订阅者（FR-032），这里只需吞掉 promise 拒绝，
           * 避免变成未处理的 rejection。不再写注释说"无人可回报"—— 现在有人了。
           */
          persistSession(snapshotToWrite).catch(() => undefined);
        }
      }, delay);
      return null;
    },

    /** [DONE] 立即落盘待写快照（关闭标签页等需要即时语义的场景使用） */
    async flushPendingWrites(): Promise<SaveResult | null> {
      const snapshotToWrite = pendingSnapshot;
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
        pendingSnapshot = null;
      }
      if (snapshotToWrite === null) {
        return null;
      }
      return persistSession(snapshotToWrite);
    },

    async loadSites(): Promise<SiteEntry[]> {
      const { sites } = await this.loadSitesWithDiagnostics();
      return sites;
    },

    /** [DONE] 读取网站列表并回报丢弃诊断（spec FR-031/FR-032） */
    async loadSitesWithDiagnostics(): Promise<{ sites: SiteEntry[]; diagnostics: LoadDiagnostics }> {
      const raw = await storage.get(STORAGE_KEYS.sites);
      const stored = raw[STORAGE_KEYS.sites];
      if (!isRecord(stored)) {
        return { sites: [], diagnostics: { rawCount: 0, acceptedCount: 0, discardedCount: 0 } };
      }
      const rawSites = Array.isArray(stored['sites']) ? stored['sites'] : [];
      const sites = rawSites.map((site) => normalizeSite(site)).filter((site): site is SiteEntry => site !== null);
      return {
        sites,
        diagnostics: {
          rawCount: rawSites.length,
          acceptedCount: sites.length,
          discardedCount: rawSites.length - sites.length,
        },
      };
    },

    async saveSites(sites: SiteEntry[]): Promise<SaveResult> {
      const normalized = sites.map((site) => normalizeSite(site)).filter((site): site is SiteEntry => site !== null);
      return writeWithRetry({ [STORAGE_KEYS.sites]: { version: 1, sites: normalized } });
    },

    async loadSiteSettings(): Promise<Record<string, SiteSettings>> {
      return readSiteSettings();
    },

    async saveSiteSettings(settings: Record<string, SiteSettings>): Promise<SaveResult> {
      // 写前逐条校验：宁可少写一条坏记录，也不让它在下次读取时才暴露
      const normalized: Record<string, SiteSettings> = {};
      for (const [originKey, value] of Object.entries(settings)) {
        if (originKeyFromUrl(originKey) === null) {
          continue;
        }
        normalized[originKey] = normalizeSettings(value);
      }

      /**
       * **合并写入：保留存储中已有的授权标记**（终审 A2 修复）。
       *
       * 问题的性质是"两个写入者共享一个键"：侧栏写 displayMode，后台写 uaGrant/cookieGrant。
       * 若侧栏把自己的整份内存快照覆盖上去，就会把后台刚写的 `granted` 抹成 `never` ——
       * 表现为"用户点了允许、规则也生效了，重启后授权却没了"，直接违反 FR-039。
       *
       * 修法是按字段划分归属：**授权标记以存储为准**（后台是唯一写入者），侧栏只写显示模式。
       * 逐字段合并而不是整体覆盖，才能让"侧栏改显示模式"与"后台改授权"互不抹除。
       * 保留键同理：只更新本次传入的来源，存储里其它来源原样保留。
       */
      const existingRaw = await storage.get(STORAGE_KEYS.siteSettings);
      const existingStored = existingRaw[STORAGE_KEYS.siteSettings];
      const existingMap = isRecord(existingStored) ? existingStored : {};

      const merged: Record<string, SiteSettings> = {};
      for (const [originKey, incoming] of Object.entries(normalized)) {
        const existingEntry = existingMap[originKey];
        const existingSettings = isRecord(existingEntry) ? normalizeSettings(existingEntry) : null;
        merged[originKey] =
          existingSettings === null
            ? incoming
            : {
                displayMode: incoming.displayMode,
                // 授权标记以存储现有值为准：它们由后台写入，侧栏不拥有
                uaGrant: existingSettings.uaGrant,
                cookieGrant: existingSettings.cookieGrant,
              };
      }
      // 存储里有、本次没传的来源原样保留（避免"只提交一个来源"把别的来源删掉）
      for (const [originKey, value] of Object.entries(existingMap)) {
        if (merged[originKey] === undefined && originKeyFromUrl(originKey) !== null) {
          merged[originKey] = normalizeSettings(value);
        }
      }

      return writeWithRetry({ [STORAGE_KEYS.siteSettings]: merged });
    },

    /**
     * [DONE] 广播外部对站点设置的改动（终审 A1 修复）。
     *
     * 侧栏需要知道后台写了授权标记，否则会出现"用户点了允许、界面开关仍关"（A1）。
     * 这条通道由适配层接 `storage.onChanged` 驱动，因此任何写入者（后台、另一个侧栏实例）
     * 的改动都能被感知 —— 不需要规定"谁必须先通知谁"。
     */
    onSiteSettingsChanged(listener: (settings: Record<string, SiteSettings>) => void): () => void {
      settingsListeners.add(listener);
      return () => {
        settingsListeners.delete(listener);
      };
    },

    onWriteResult(listener: (result: SaveResult) => void): () => void {
      writeListeners.add(listener);
      return () => {
        writeListeners.delete(listener);
      };
    },
  };
}
