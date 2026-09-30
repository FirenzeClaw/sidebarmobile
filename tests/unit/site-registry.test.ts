// sidebarmobile — 网站注册表单测（测试）
// 2026-09-29 | Kimi(speckit-implement) | T021：先写失败测试（RED，FR-004/FR-005/FR-019）

import { beforeEach, describe, expect, it } from 'vitest';
import { createSiteRegistry, type SiteRegistry } from '../../src/sidebar/state/site-registry.ts';

let registry: SiteRegistry;
let clockTick: number;

/** 可重复的时钟：每次读取前进 1 秒，让时间戳可断言且严格递增 */
function tickingClock(): string {
  clockTick += 1;
  return new Date(Date.UTC(2026, 8, 29, 11, 0, clockTick)).toISOString();
}

beforeEach(() => {
  clockTick = 0;
  registry = createSiteRegistry({ now: tickingClock });
});

describe('按精确来源去重（spec FR-005）', () => {
  it('用户添加网址后建立条目，标题默认取域名', () => {
    const result = registry.addFromUserInput('https://example.com/');

    expect(result).not.toBeNull();
    expect(result!.created).toBe(true);
    expect(result!.site.originKey).toBe('https://example.com');
    expect(result!.site.title).toBe('example.com');
    expect(result!.site.addedBy).toBe('user');
    expect(result!.site.entryPoints).toEqual([{ url: 'https://example.com/', label: null }]);
    expect(registry.getSites()).toHaveLength(1);
  });

  it('同一来源的根路径与子路径归并为一个条目', () => {
    registry.addFromUserInput('https://example.com/');
    const second = registry.addFromUserInput('https://example.com/docs/intro');

    expect(second!.created).toBe(false);
    expect(registry.getSites()).toHaveLength(1);
    expect(second!.site.entryPoints.map((entry) => entry.url)).toEqual([
      'https://example.com/',
      'https://example.com/docs/intro',
    ]);
  });

  it('不同端口视为不同来源', () => {
    registry.addFromUserInput('https://example.com/');
    registry.addFromUserInput('https://example.com:8443/');

    expect(registry.getSites()).toHaveLength(2);
    expect(registry.getSites().map((site) => site.originKey)).toEqual([
      'https://example.com',
      'https://example.com:8443',
    ]);
  });

  it('不同协议视为不同来源', () => {
    registry.addFromUserInput('http://example.com/');
    registry.addFromUserInput('https://example.com/');

    expect(registry.getSites()).toHaveLength(2);
  });

  it('子域名不与主域名合并', () => {
    registry.addFromUserInput('https://example.com/');
    registry.addFromUserInput('https://www.example.com/');

    expect(registry.getSites()).toHaveLength(2);
  });

  it('重复添加相同地址不产生重复入口', () => {
    registry.addFromUserInput('https://example.com/');
    const again = registry.addFromUserInput('https://example.com/');

    expect(again!.created).toBe(false);
    expect(again!.addedEntryPoint).toBe(false);
    expect(again!.site.entryPoints).toHaveLength(1);
    expect(registry.getSites()).toHaveLength(1);
  });

  it('非法地址不产生条目并返回 null', () => {
    expect(registry.addFromUserInput('javascript:alert(1)')).toBeNull();
    expect(registry.addFromUserInput('file:///etc/passwd')).toBeNull();
    expect(registry.addFromUserInput('not a url at all')).toBeNull();

    expect(registry.getSites()).toHaveLength(0);
  });

  it('片段差异不产生新入口（URL 规范化去哈希）', () => {
    registry.addFromUserInput('https://example.com/page');
    const result = registry.addFromUserInput('https://example.com/page#section-2');

    expect(result!.addedEntryPoint).toBe(false);
    expect(result!.site.entryPoints).toHaveLength(1);
  });

  it('查询接口按来源键取回条目', () => {
    registry.addFromUserInput('https://example.com/docs');

    expect(registry.getSite('https://example.com')?.entryPoints[0]?.url).toBe('https://example.com/docs');
    expect(registry.getSite('https://absent.example.org')).toBeNull();
  });
});

describe('入口路径共存（spec FR-005）', () => {
  it('同一来源的不同路径全部保留为入口', () => {
    registry.addFromUserInput('https://example.com/a');
    registry.addFromUserInput('https://example.com/b');
    registry.addFromUserInput('https://example.com/c');

    const site = registry.getSite('https://example.com')!;
    expect(site.entryPoints.map((entry) => entry.url)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
    ]);
  });

  it('显式添加入口在某来源尚不存在时创建导航来源条目', () => {
    const added = registry.addEntryPoint('https://example.com', 'https://example.com/late');

    expect(added).toBe(true);
    const site = registry.getSite('https://example.com')!;
    expect(site.addedBy).toBe('navigation');
    expect(site.entryPoints.map((entry) => entry.url)).toEqual(['https://example.com/late']);
  });

  it('入口地址不属于目标来源时拒绝添加', () => {
    registry.addFromUserInput('https://example.com/');

    expect(registry.addEntryPoint('https://example.com', 'https://other.example.org/x')).toBe(false);
    expect(registry.getSite('https://example.com')?.entryPoints).toHaveLength(1);
  });

  it('移除网站条目时其入口一并消失', () => {
    registry.addFromUserInput('https://example.com/a');
    registry.addFromUserInput('https://example.com/b');

    expect(registry.removeSite('https://example.com')).toBe(true);
    expect(registry.getSites()).toHaveLength(0);
    expect(registry.removeSite('https://example.com')).toBe(false);
  });
});

describe('导航自动入列不覆盖用户入口（spec FR-019）', () => {
  it('导航到未保存来源时自动加入并记为 navigation', () => {
    const result = registry.addFromNavigation('https://fresh.example.org/article/1');

    expect(result).not.toBeNull();
    expect(result!.created).toBe(true);
    expect(result!.site.addedBy).toBe('navigation');
    expect(result!.site.entryPoints[0]?.url).toBe('https://fresh.example.org/article/1');
  });

  it('导航到已保存来源时保留用户入口顺序与 addedBy=user', () => {
    registry.addFromUserInput('https://example.com/home');
    const navigated = registry.addFromNavigation('https://example.com/other/page');

    expect(navigated!.created).toBe(false);
    const site = registry.getSite('https://example.com')!;
    expect(site.addedBy).toBe('user');
    // 用户原始入口仍排在第一位（FR-019 不覆盖用户入口）
    expect(site.entryPoints[0]?.url).toBe('https://example.com/home');
    expect(site.entryPoints[1]?.url).toBe('https://example.com/other/page');
  });

  it('导航不改写用户自定义标题', () => {
    registry.addFromUserInput('https://example.com/');
    registry.renameSite('https://example.com', '我的工作台');

    registry.addFromNavigation('https://example.com/other');

    expect(registry.getSite('https://example.com')?.title).toBe('我的工作台');
  });

  it('用户后续添加已由导航加入的来源时升格为 user 且不覆盖导航入口', () => {
    registry.addFromNavigation('https://example.com/from-nav');
    const promoted = registry.addFromUserInput('https://example.com/from-user');

    expect(promoted!.site.addedBy).toBe('user');
    expect(promoted!.site.entryPoints.map((entry) => entry.url)).toEqual([
      'https://example.com/from-nav',
      'https://example.com/from-user',
    ]);
  });

  it('导航到非法地址不产生条目', () => {
    expect(registry.addFromNavigation('chrome://settings')).toBeNull();
    expect(registry.getSites()).toHaveLength(0);
  });
});

describe('条目编辑与访问时间（spec FR-005）', () => {
  it('重命名后标题持久保存在条目上', () => {
    registry.addFromUserInput('https://example.com/');

    expect(registry.renameSite('https://example.com', '  示例站  ')).toBe(true);
    expect(registry.getSite('https://example.com')?.title).toBe('示例站');
  });

  it('空标题被拒绝，原标题保持不变', () => {
    registry.addFromUserInput('https://example.com/');
    const originalTitle = registry.getSite('https://example.com')!.title;

    expect(registry.renameSite('https://example.com', '   ')).toBe(false);
    expect(registry.getSite('https://example.com')?.title).toBe(originalTitle);
  });

  it('记录最近访问时间，新建条目的 lastVisitedAt 为空', () => {
    registry.addFromUserInput('https://example.com/');
    expect(registry.getSite('https://example.com')?.lastVisitedAt).toBeNull();

    expect(registry.markVisited('https://example.com')).toBe(true);
    expect(registry.getSite('https://example.com')?.lastVisitedAt).toBe(
      new Date(Date.UTC(2026, 8, 29, 11, 0, 2)).toISOString(),
    );
  });

  it('最近访问的条目排在网格最前', () => {
    registry.addFromUserInput('https://a.example.com/');
    registry.addFromUserInput('https://b.example.com/');
    registry.markVisited('https://b.example.com');

    expect(registry.getSites()[0]?.originKey).toBe('https://b.example.com');
  });
});

describe('持久化外壳（spec FR-017）', () => {
  it('快照可完整恢复条目、入口与设置', () => {
    registry.addFromUserInput('https://example.com/a');
    registry.addFromUserInput('https://example.com/b');
    registry.renameSite('https://example.com', '示例');
    registry.markVisited('https://example.com');

    const snapshot = registry.snapshot();
    const restored = createSiteRegistry({ now: tickingClock });
    restored.restore(snapshot);

    const site = restored.getSite('https://example.com')!;
    expect(site.title).toBe('示例');
    expect(site.entryPoints.map((entry) => entry.url)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
    expect(site.settings.displayMode).toBe('mobile');
    expect(site.lastVisitedAt).not.toBeNull();
  });

  it('恢复时丢弃坏条目而保留合法条目（spec FR-031）', () => {
    registry.addFromUserInput('https://good.example.org/');
    const goodSite = registry.getSite('https://good.example.org')!;

    const restored = createSiteRegistry({ now: tickingClock });
    restored.restore([
      goodSite,
      { ...goodSite, originKey: 'ftp://bad.example.org' },
      { ...goodSite, originKey: 'https://empty.example.org', entryPoints: [] },
    ]);

    expect(restored.getSites().map((site) => site.originKey)).toEqual(['https://good.example.org']);
  });

  it('变更通知覆盖增删改，退订后停止通知', () => {
    let notifications = 0;
    const unsubscribe = registry.onChange(() => {
      notifications += 1;
    });

    registry.addFromUserInput('https://example.com/');
    registry.renameSite('https://example.com', '示例');
    registry.removeSite('https://example.com');
    expect(notifications).toBe(3);

    unsubscribe();
    registry.addFromUserInput('https://other.example.org/');
    expect(notifications).toBe(3);
  });

  it('被拒绝的操作不触发通知', () => {
    let notifications = 0;
    registry.onChange(() => {
      notifications += 1;
    });

    registry.addFromUserInput('javascript:alert(1)');
    registry.renameSite('https://absent.example.org', 'x');
    registry.removeSite('https://absent.example.org');
    registry.markVisited('https://absent.example.org');

    expect(notifications).toBe(0);
  });
});
