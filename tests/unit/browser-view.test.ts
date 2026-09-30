// sidebarmobile — 网页浏览视图单测（测试）
// 2026-09-29 | Kimi(speckit-fix) | 终审 B1：resize 死循环回归 + 显示模式与宿主管理

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installDomEnvironment, StubElement, type DomEnvironment } from '../helpers/dom-stub.ts';
import { createBrowserView, DESKTOP_VIEWPORT_WIDTH } from '../../src/sidebar/views/browser-view.ts';
import type { BrowserTab } from '../../src/shared/types.ts';

let dom: DomEnvironment;
let container: StubElement;

/**
 * 布局读取预算。
 *
 * 这是本文件存在的直接原因：终审实测到"桌面模式下触发 resize 会无限循环"，
 * 而在无预算的替身里，那种缺陷表现为**测试永久挂起**（只能靠超时失败，看不出原因）。
 * 给定预算后，死循环立刻变成一条可读的断言失败。
 */
const MEASURE_BUDGET = 5000;

function makeTab(overrides: Partial<BrowserTab> = {}): BrowserTab {
  const now = new Date().toISOString();
  return {
    tabId: 'tab-1',
    originKey: 'https://example.com',
    currentUrl: 'https://example.com/',
    title: '示例',
    history: [{ url: 'https://example.com/', title: '示例', visitedAt: now }],
    historyIndex: 0,
    loadState: 'loaded',
    createdAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  dom = installDomEnvironment();
  container = dom.document.createElement('div');
  dom.registerElement('browserContent', container);
  dom.setMeasureBudget(MEASURE_BUDGET);
});

afterEach(() => {
  dom.restore();
});

/** 创建视图（每次重新读容器，避免跨用例共享元素） */
function createView(): ReturnType<typeof createBrowserView> {
  return createBrowserView({ onFrameLoad: () => undefined });
}

describe('标签宿主管理（spec FR-025）', () => {
  it('为每个标签创建宿主，并把 iframe 指向该标签的地址', () => {
    const view = createView();
    view.syncTabs([makeTab({ tabId: 'tab-a', currentUrl: 'https://a.example.com/' })], () => 'mobile');

    const hosts = container.querySelectorAll('.tab-host');
    expect(hosts).toHaveLength(1);
    const frame = hosts[0]?.querySelector('iframe');
    expect(frame?.src).toBe('https://a.example.com/');
  });

  it('移除已关闭标签的宿主', () => {
    const view = createView();
    view.syncTabs([makeTab({ tabId: 'tab-a' }), makeTab({ tabId: 'tab-b' })], () => 'mobile');
    expect(container.querySelectorAll('.tab-host')).toHaveLength(2);

    view.syncTabs([makeTab({ tabId: 'tab-a' })], () => 'mobile');

    expect(container.querySelectorAll('.tab-host')).toHaveLength(1);
  });

  it('同址重复同步不重新赋值 src（避免无意义重载）', () => {
    const view = createView();
    const tab = makeTab({ tabId: 'tab-a' });
    view.syncTabs([tab], () => 'mobile');
    const frame = container.querySelectorAll('.tab-host')[0]?.querySelector('iframe');
    // 用一个可识别的自定义属性标记 iframe，验证它没有被替换
    frame?.setAttribute('data-marked', 'yes');

    view.syncTabs([tab], () => 'mobile');

    const after = container.querySelectorAll('.tab-host')[0]?.querySelector('iframe');
    expect(after?.getAttribute('data-marked')).toBe('yes');
  });
});

/**
 * 终审 B1：桌面模式下触发 resize 曾导致 Map 迭代器无限循环。
 *
 * 根因：`for...of` 遍历 Map 时先 `delete(tabId)` 再 `applyDisplayMode` 内部 `set(tabId, ...)`
 * 重新插入同一键，迭代器把新插入的条目也算进来 → 永不终止。
 * 触发条件是最普通的交互：桌面模式下拖宽侧栏。
 */
describe('resize 重算缩放（终审 B1 回归）', () => {
  it('桌面模式下 resize 能正常返回（不死循环）', () => {
    const view = createView();
    container.clientWidth = 360;
    view.syncTabs([makeTab({ tabId: 'tab-a' })], () => 'desktop');

    // 修复前：这里会耗尽事件循环，测试挂起
    expect(() => {
      dom.window.dispatchResize();
    }).not.toThrow();
  });

  it('resize 后按新容器宽度重算缩放比例', () => {
    const view = createView();
    container.clientWidth = 320;
    view.syncTabs([makeTab({ tabId: 'tab-a' })], () => 'desktop');

    const frame = container.querySelectorAll('.tab-host')[0]?.querySelector('iframe');
    expect(frame?.style['transform']).toBe(`scale(${320 / DESKTOP_VIEWPORT_WIDTH})`);

    // 容器变宽后重新计算
    container.clientWidth = 640;
    dom.window.dispatchResize();

    const after = container.querySelectorAll('.tab-host')[0]?.querySelector('iframe');
    expect(after?.style['transform']).toBe(`scale(${640 / DESKTOP_VIEWPORT_WIDTH})`);
  });

  it('多个桌面标签同时 resize 都能返回', () => {
    const view = createView();
    container.clientWidth = 400;
    view.syncTabs(
      [
        makeTab({ tabId: 'tab-a', currentUrl: 'https://a.example.com/' }),
        makeTab({ tabId: 'tab-b', currentUrl: 'https://b.example.com/' }),
        makeTab({ tabId: 'tab-c', currentUrl: 'https://c.example.com/' }),
      ],
      () => 'desktop',
    );

    expect(() => {
      dom.window.dispatchResize();
    }).not.toThrow();
    expect(container.querySelectorAll('.tab-host')).toHaveLength(3);
  });

  it('移动标签的 resize 不参与缩放重算', () => {
    const view = createView();
    container.clientWidth = 360;
    view.syncTabs([makeTab({ tabId: 'tab-a' })], () => 'mobile');

    expect(() => {
      dom.window.dispatchResize();
    }).not.toThrow();

    const frame = container.querySelectorAll('.tab-host')[0]?.querySelector('iframe');
    // 移动模式始终铺满，不带缩放
    expect(frame?.style["transform"]).toBe('');
  });

  it('无标签时 resize 是安全的空操作', () => {
    createView();
    expect(() => {
      dom.window.dispatchResize();
    }).not.toThrow();
  });

  it('布局读取次数在预算内（不存在异常空转）', () => {
    const view = createView();
    container.clientWidth = 360;
    view.syncTabs([makeTab({ tabId: 'tab-a' })], () => 'desktop');
    dom.setMeasureBudget(MEASURE_BUDGET);

    dom.window.dispatchResize();
    dom.window.dispatchResize();

    // 两次 resize 各自只应读取常数次布局；给出宽松上界以防未来实现变化
    expect(dom.measureCount()).toBeLessThan(200);
  });
});

describe('显示模式应用（spec FR-007/FR-008）', () => {
  it('移动模式铺满容器且无缩放', () => {
    const view = createView();
    view.syncTabs([makeTab({ tabId: 'tab-a' })], () => 'mobile');

    const frame = container.querySelectorAll('.tab-host')[0]?.querySelector('iframe');
    expect(frame?.style["width"]).toBe('100%');
    expect(frame?.style["transform"]).toBe('');
  });

  it('桌面模式按桌面断点定宽并缩放', () => {
    const view = createView();
    container.clientWidth = 360;
    view.syncTabs([makeTab({ tabId: 'tab-a' })], () => 'desktop');

    const frame = container.querySelectorAll('.tab-host')[0]?.querySelector('iframe');
    expect(frame?.style['width']).toBe(`${DESKTOP_VIEWPORT_WIDTH}px`);
    expect((frame?.style['transform'] ?? '').startsWith('scale(')).toBe(true);
  });

  it('模式切换后样式随之改变', () => {
    const view = createView();
    container.clientWidth = 360;
    const tab = makeTab({ tabId: 'tab-a' });

    view.syncTabs([tab], () => 'desktop');
    const desktopWidth = container.querySelectorAll('.tab-host')[0]?.querySelector('iframe')?.style["width"];

    view.syncTabs([tab], () => 'mobile');
    const mobileWidth = container.querySelectorAll('.tab-host')[0]?.querySelector('iframe')?.style["width"];

    expect(desktopWidth).toBe(`${DESKTOP_VIEWPORT_WIDTH}px`);
    expect(mobileWidth).toBe('100%');
  });
});

describe('视图切换与导航（spec FR-025）', () => {
  it('showTab 只显示指定标签的宿主', () => {
    const view = createView();
    view.syncTabs([makeTab({ tabId: 'tab-a' }), makeTab({ tabId: 'tab-b' })], () => 'mobile');

    view.showTab('tab-b');

    const hosts = container.querySelectorAll('.tab-host');
    const visibility = hosts.map((host) => host.hidden);
    expect(visibility.filter((hidden) => hidden === false)).toHaveLength(1);
  });

  it('showTab(null) 隐藏全部宿主', () => {
    const view = createView();
    view.syncTabs([makeTab({ tabId: 'tab-a' })], () => 'mobile');

    view.showTab(null);

    expect(container.querySelectorAll('.tab-host').every((host) => host.hidden)).toBe(true);
  });

  it('loadTab 载入新地址', () => {
    const view = createView();
    view.syncTabs([makeTab({ tabId: 'tab-a' })], () => 'mobile');

    view.loadTab('tab-a', 'https://example.com/next');

    const frame = container.querySelectorAll('.tab-host')[0]?.querySelector('iframe');
    expect(frame?.src).toBe('https://example.com/next');
  });

  it('adoptTabUrl 不改变 iframe 的 src（SPA 已在目标地址上）', () => {
    const view = createView();
    view.syncTabs([makeTab({ tabId: 'tab-a' })], () => 'mobile');
    const frame = container.querySelectorAll('.tab-host')[0]?.querySelector('iframe');

    view.adoptTabUrl('tab-a', 'https://example.com/spa-detail');

    expect(frame?.src).toBe('https://example.com/');
  });

  it('adoptTabUrl 后同步不再重载该标签', () => {
    const view = createView();
    view.syncTabs([makeTab({ tabId: 'tab-a' })], () => 'mobile');
    const frame = container.querySelectorAll('.tab-host')[0]?.querySelector('iframe');
    frame?.setAttribute('data-marked', 'yes');

    view.adoptTabUrl('tab-a', 'https://example.com/spa-detail');
    view.syncTabs([makeTab({ tabId: 'tab-a', currentUrl: 'https://example.com/spa-detail' })], () => 'mobile');

    const after = container.querySelectorAll('.tab-host')[0]?.querySelector('iframe');
    expect(after?.getAttribute('data-marked')).toBe('yes');
  });
});
