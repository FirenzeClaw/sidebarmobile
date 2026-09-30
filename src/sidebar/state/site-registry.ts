// sidebarmobile — 网站注册表（sidebar）
// 2026-09-29 | Kimi(speckit-implement) | T024：实现以通过 T021（FR-004/FR-005/FR-019）
// 2026-09-29 | Kimi(speckit-fix) | 终审 B5：输入解析复用 parseUrlInput，消除重复的协议判定实现

import { isNavigableUrl, normalizeUrl, parseUrlInput } from '../../shared/url-policy.ts';
import { originKeyFromUrl, originKeyToString } from '../../shared/origin-key.ts';
import { createDefaultSiteSettings, type EntryPoint, type SiteEntry, type SiteEntrySource } from '../../shared/types.ts';

/**
 * [DONE] 网站列表的纯状态机（不接触 DOM 与浏览器 API）。
 *
 * 归并键是**精确来源**（协议 + 域名 + 端口），因此：
 * - 同来源不同路径共用一个条目，各路径保留为独立入口（spec FR-005）；
 * - 不同端口/协议/子域名各成一条，不做主域名合并（data-model §1）。
 *
 * 入口来源语义（spec FR-019）：用户显式添加的条目 addedBy='user'，网页导航自动加入的为
 * 'navigation'；导航**只追加入口、不改标题、不改入口顺序**，用户入口永不被覆盖。
 */

/** 添加结果：created 表示是否新建条目，addedEntryPoint 表示是否新增了入口 */
export interface SiteAddResult {
  created: boolean;
  addedEntryPoint: boolean;
  site: SiteEntry;
}

export interface SiteRegistryOptions {
  /** 时间工厂；注入以便断言时间戳与排序 */
  now: () => string;
}

export interface SiteRegistry {
  addFromUserInput(rawInput: string): SiteAddResult | null;
  addFromNavigation(url: string): SiteAddResult | null;
  addEntryPoint(originKey: string, url: string): boolean;
  removeSite(originKey: string): boolean;
  renameSite(originKey: string, title: string): boolean;
  markVisited(originKey: string): boolean;
  getSites(): SiteEntry[];
  getSite(originKey: string): SiteEntry | null;
  /** 持久化外壳：与存储层 sites:v1 的 sites 字段同形 */
  snapshot(): SiteEntry[];
  restore(sites: readonly unknown[]): void;
  /** 订阅状态变更（用于防抖持久化）；返回退订函数 */
  onChange(listener: () => void): () => void;
}

/**
 * [DONE] 解析一次用户输入：返回规范化 URL 与来源键，非法返回 null。
 *
 * **复用 `parseUrlInput` 而不是自带一份补协议逻辑**（终审 DRY 修复）：
 * 两处各写一份补协议判断曾导致行为不一致 —— `site-registry` 的旧正则把 `example.com:8080`
 * 的 `example.com:` 认成协议（B5 的同型缺陷）。输入解析只有一处真相，才不会再漂移。
 */
function resolveInput(rawInput: string): { url: string; originKey: string } | null {
  const parsed = parseUrlInput(rawInput);
  if (!parsed.ok) {
    return null;
  }
  const originKey = originKeyFromUrl(parsed.url);
  return originKey === null ? null : { url: parsed.url, originKey: originKeyToString(originKey) };
}

/** [DONE] 由来源键推导默认标题：取主机名（端口不进入标题，用户可后续重命名） */
function defaultTitle(originKey: string): string {
  const parsed = originKeyFromUrl(originKey);
  return parsed === null ? originKey : parsed.host;
}

/** [DONE] 恢复时的单条校验：来源非法或没有入口的条目丢弃（spec FR-031 粒度丢弃） */
function normalizeRestoredSite(value: unknown): SiteEntry | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Partial<SiteEntry>;
  const rawOriginKey = candidate.originKey;
  if (typeof rawOriginKey !== 'string' || originKeyFromUrl(rawOriginKey) === null) {
    return null;
  }

  const rawEntryPoints = Array.isArray(candidate.entryPoints) ? candidate.entryPoints : [];
  const entryPoints: EntryPoint[] = [];
  for (const entry of rawEntryPoints) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const restored = entry as Partial<EntryPoint>;
    if (typeof restored.url !== 'string' || !isNavigableUrl(restored.url)) {
      continue;
    }
    const entryOriginKey = originKeyFromUrl(restored.url);
    // 入口必须属于该条目的来源，否则视为坏记录（data-model §2）
    if (entryOriginKey === null || originKeyToString(entryOriginKey) !== rawOriginKey) {
      continue;
    }
    entryPoints.push({ url: normalizeUrl(restored.url), label: typeof restored.label === 'string' ? restored.label : null });
  }
  if (entryPoints.length === 0) {
    return null;
  }

  const fallbackTime = new Date(0).toISOString();
  const settings = candidate.settings;
  return {
    originKey: rawOriginKey,
    title:
      typeof candidate.title === 'string' && candidate.title.length > 0 ? candidate.title : defaultTitle(rawOriginKey),
    faviconUrl: typeof candidate.faviconUrl === 'string' ? candidate.faviconUrl : null,
    entryPoints,
    settings:
      typeof settings === 'object' && settings !== null
        ? {
            displayMode: settings.displayMode === 'desktop' ? 'desktop' : 'mobile',
            uaGrant: settings.uaGrant === 'granted' || settings.uaGrant === 'revoked' ? settings.uaGrant : 'never',
            cookieGrant:
              settings.cookieGrant === 'granted' || settings.cookieGrant === 'revoked' ? settings.cookieGrant : 'never',
          }
        : createDefaultSiteSettings(),
    addedBy: candidate.addedBy === 'navigation' ? 'navigation' : 'user',
    createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : fallbackTime,
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : fallbackTime,
    lastVisitedAt: typeof candidate.lastVisitedAt === 'string' ? candidate.lastVisitedAt : null,
  };
}

/** [DONE] 创建网站注册表 */
export function createSiteRegistry(options: SiteRegistryOptions): SiteRegistry {
  let sites: SiteEntry[] = [];
  const listeners = new Set<() => void>();

  /** [DONE] 通知订阅者；视图重绘与持久化都挂在这里 */
  function notify(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  /** [DONE] 原位替换单条条目，保持数组顺序 */
  function replaceSite(originKey: string, updater: (site: SiteEntry) => SiteEntry): SiteEntry | null {
    const index = sites.findIndex((site) => site.originKey === originKey);
    const current = index < 0 ? undefined : sites[index];
    if (current === undefined) {
      return null;
    }
    const updated = updater(current);
    const nextSites = [...sites];
    nextSites[index] = updated;
    sites = nextSites;
    return updated;
  }

  /** [DONE] 向条目追加入口；已存在时返回 false 且不写时间戳 */
  function appendEntryPoint(site: SiteEntry, url: string, timestamp: string): SiteEntry | null {
    if (site.entryPoints.some((entry) => entry.url === url)) {
      return null;
    }
    return {
      ...site,
      entryPoints: [...site.entryPoints, { url, label: null }],
      updatedAt: timestamp,
    };
  }

  /** [DONE] 增删改的统一入口：处理新建 / 追加入口 / 升格来源标记 */
  function upsert(
    resolved: { url: string; originKey: string },
    addedBy: SiteEntrySource,
  ): SiteAddResult {
    const timestamp = options.now();
    const existing = sites.find((site) => site.originKey === resolved.originKey);

    if (existing === undefined) {
      const site: SiteEntry = {
        originKey: resolved.originKey,
        title: defaultTitle(resolved.originKey),
        faviconUrl: null,
        entryPoints: [{ url: resolved.url, label: null }],
        settings: createDefaultSiteSettings(),
        addedBy,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastVisitedAt: null,
      };
      sites = [...sites, site];
      notify();
      return { created: true, addedEntryPoint: true, site };
    }

    const withEntryPoint = appendEntryPoint(existing, resolved.url, timestamp);
    // 用户显式添加视为对条目的确认：把导航自动加入的条目升格为 user（FR-019）
    const shouldPromote = addedBy === 'user' && existing.addedBy === 'navigation';
    if (withEntryPoint === null && !shouldPromote) {
      return { created: false, addedEntryPoint: false, site: existing };
    }

    const updated: SiteEntry = {
      ...(withEntryPoint ?? existing),
      addedBy: shouldPromote ? 'user' : existing.addedBy,
      updatedAt: timestamp,
    };
    const replaced = replaceSite(resolved.originKey, () => updated);
    notify();
    return { created: false, addedEntryPoint: withEntryPoint !== null, site: replaced ?? updated };
  }

  return {
    addFromUserInput(rawInput: string): SiteAddResult | null {
      const resolved = resolveInput(rawInput);
      if (resolved === null) {
        return null;
      }
      return upsert(resolved, 'user');
    },

    addFromNavigation(url: string): SiteAddResult | null {
      if (!isNavigableUrl(url)) {
        return null;
      }
      const normalized = normalizeUrl(url);
      const originKey = originKeyFromUrl(normalized);
      if (originKey === null) {
        return null;
      }
      return upsert({ url: normalized, originKey: originKeyToString(originKey) }, 'navigation');
    },

    addEntryPoint(originKey: string, url: string): boolean {
      if (!isNavigableUrl(url)) {
        return false;
      }
      const normalized = normalizeUrl(url);
      const parsedOriginKey = originKeyFromUrl(normalized);
      if (parsedOriginKey === null || originKeyToString(parsedOriginKey) !== originKey) {
        return false;
      }
      const existing = sites.find((site) => site.originKey === originKey);
      if (existing === undefined) {
        // 该来源尚无条目（如从网页导航首次抵达）：按导航来源新建
        upsert({ url: normalized, originKey }, 'navigation');
        return true;
      }
      const updated = appendEntryPoint(existing, normalized, options.now());
      if (updated === null) {
        return false;
      }
      replaceSite(originKey, () => updated);
      notify();
      return true;
    },

    removeSite(originKey: string): boolean {
      const nextSites = sites.filter((site) => site.originKey !== originKey);
      if (nextSites.length === sites.length) {
        return false;
      }
      sites = nextSites;
      notify();
      return true;
    },

    renameSite(originKey: string, title: string): boolean {
      const trimmed = title.trim();
      if (trimmed.length === 0) {
        return false;
      }
      const existing = sites.find((site) => site.originKey === originKey);
      if (existing === undefined || existing.title === trimmed) {
        return false;
      }
      const timestamp = options.now();
      replaceSite(originKey, (site) => ({ ...site, title: trimmed, updatedAt: timestamp }));
      notify();
      return true;
    },

    markVisited(originKey: string): boolean {
      const existing = sites.find((site) => site.originKey === originKey);
      if (existing === undefined) {
        return false;
      }
      const timestamp = options.now();
      replaceSite(originKey, (site) => ({ ...site, lastVisitedAt: timestamp, updatedAt: timestamp }));
      notify();
      return true;
    },

    getSites(): SiteEntry[] {
      // 最近访问的条目排在最前，其余保持加入顺序（网格首屏即最近使用）
      return [...sites].sort((left, right) => {
        const leftTime = left.lastVisitedAt ?? '';
        const rightTime = right.lastVisitedAt ?? '';
        if (leftTime === rightTime) {
          return 0;
        }
        if (leftTime === '') {
          return 1;
        }
        if (rightTime === '') {
          return -1;
        }
        return leftTime < rightTime ? 1 : -1;
      });
    },

    getSite(originKey: string): SiteEntry | null {
      return sites.find((site) => site.originKey === originKey) ?? null;
    },

    snapshot(): SiteEntry[] {
      return [...sites];
    },

    restore(rawSites: readonly unknown[]): void {
      const restoredSites: SiteEntry[] = [];
      for (const raw of rawSites) {
        const site = normalizeRestoredSite(raw);
        if (site !== null) {
          restoredSites.push(site);
        }
      }
      sites = restoredSites;
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
