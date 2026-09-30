// sidebarmobile — 底部弹层与九宫格菜单单测（测试）
// 2026-09-30 | Kimi(fix) | 用户实测反馈：先写失败测试（RED）—— 去掉误导性页点、接线四格

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installDomEnvironment, type DomEnvironment, type StubElement } from '../helpers/dom-stub.ts';
import { createSheets, type SheetHandlers, type SheetController } from '../../src/sidebar/components/sheets.ts';
import type { BrowserTab } from '../../src/shared/types.ts';

/**
 * 本文件锁定的是一次**用户实测反馈**的两个缺陷：
 *
 * 1. **页点在撒谎**：九宫格底部画了两个页点（首点高亮），视觉上承诺"可以左右翻页"，
 *    而实现里根本没有翻页逻辑 —— 用户右滑无反应。这是**误导性 UI**：控件暗示了一个
 *    不存在的能力，比"没有这个控件"更糟（用户会反复尝试，并开始怀疑其它控件也不可信）。
 * 2. **五个格子点不动**：剪辑边界留下的 `unsupported` / `needs-tab` 标记在能力落地后
 *    没有被接上 handler，用户看到的是"有格子但按了没反应"。
 *
 * 断言写给"用户看到什么"：页点元素必须不存在、可用的格子必须 `disabled === false`
 * 且点击真的触达 handler、不可用的格子必须把**原因**写进 aria-label。
 */

let dom: DomEnvironment;
let sheetElement: StubElement;
let calls: string[];

/** 创建被测弹层控制器；所有 handler 只做记录，断言"点击确实到达了装配层" */
function buildSheets(): SheetController {
  const overlay = dom.document.createElement('div');
  dom.registerElement('sheetOverlay', overlay);
  dom.document.body.append(overlay);
  sheetElement = dom.document.createElement('div');
  dom.registerElement('sheet', sheetElement);
  dom.document.body.append(sheetElement);

  const handlers: SheetHandlers = {
    onActivateTab: (tabId) => calls.push(`activate:${tabId}`),
    onCloseTab: (tabId) => calls.push(`close-tab:${tabId}`),
    onCloseAllTabs: () => calls.push('close-all'),
    onNewTab: () => calls.push('new-tab'),
    onShowSiteList: () => calls.push('site-list'),
    onToggleTheme: () => calls.push('toggle-theme'),
    onOpenSiteSettings: () => calls.push('site-settings'),
    onCopyUrl: () => calls.push('copy-url'),
    onOpenHistory: () => calls.push('history'),
    onActivateHistoryEntry: (url, index) => calls.push(`history:${String(index)}:${url}`),
    onToggleDesktopMode: () => calls.push('desktop-mode'),
    onOpenExternal: () => calls.push('open-external'),
    onClosed: () => calls.push('closed'),
  };
  return createSheets(handlers);
}

/** 按可见文案取出一个格子（找不到直接失败：格子清单本身是被测契约的一部分） */
function cell(label: string): StubElement {
  const found = sheetElement
    .querySelectorAll('.menu-cell')
    .find((node) => node.querySelector('.cell-label')?.textContent === label);
  if (found === undefined) {
    throw new Error(`九宫格中没有「${label}」格子`);
  }
  return found;
}

/** 该格子的可访问名称（读屏器与纯图标按钮的唯一说明通道） */
function cellLabelText(label: string): string {
  return cell(label).getAttribute('aria-label') ?? '';
}

beforeEach(() => {
  dom = installDomEnvironment();
  calls = [];
});

afterEach(() => {
  dom.restore();
});

describe('九宫格菜单的形状（design-system/MASTER.md §2）', () => {
  it('保持单页 2×5 共 10 格', () => {
    const sheets = buildSheets();
    sheets.openGridMenu(2, true);

    expect(sheetElement.querySelectorAll('.menu-cell')).toHaveLength(10);
  });

  /**
   * 防回归的核心断言：页点必须彻底消失。
   *
   * 只删样式是不够的（元素还在、语义承诺还在），只删元素也不够（CSS 规则会成为
   * 后来者重新加回页点的现成模板），因此这里断言 DOM 里既没有 `.menu-dots`
   * 也没有任何 `<i>` 装饰点。
   */
  it('不含页点元素（不再暗示可以左右翻页）', () => {
    const sheets = buildSheets();
    sheets.openGridMenu(2, true);

    expect(sheetElement.querySelectorAll('.menu-dots')).toHaveLength(0);
    expect(sheetElement.querySelectorAll('i')).toHaveLength(0);
  });
});

describe('可用格子：有活动标签时可点且真的触发 handler', () => {
  const wired: ReadonlyArray<readonly [string, string]> = [
    ['复制网址', 'copy-url'],
    ['历史', 'history'],
    ['电脑模式', 'desktop-mode'],
    ['普通打开', 'open-external'],
  ];

  for (const [label, expectedCall] of wired) {
    it(`「${label}」可点并触发对应 handler`, () => {
      const sheets = buildSheets();
      sheets.openGridMenu(1, true);

      const target = cell(label);
      expect(target.disabled).toBe(false);

      target.dispatch('click');

      expect(calls).toContain(expectedCall);
    });
  }

  it('「夜间模式」「网站列表」「关闭全部」仍可用（本次改动未伤及既有接线）', () => {
    const sheets = buildSheets();
    sheets.openGridMenu(1, true);

    cell('夜间模式').dispatch('click');
    cell('网站列表').dispatch('click');
    cell('关闭全部').dispatch('click');

    expect(calls).toContain('toggle-theme');
    expect(calls).toContain('site-list');
    expect(calls).toContain('close-all');
  });

  /**
   * 站点设置**不关闭**弹层：它替换当前面板内容。
   *
   * 若误加了 `close()`，关闭动画的 220ms 定时器会把刚挂上来的设置面板一起隐藏，
   * 用户看到面板一闪而过（sheets.ts 里对此有专门的说明）。
   */
  it('「站点设置」替换面板内容而不关闭弹层', () => {
    const sheets = buildSheets();
    sheets.openGridMenu(1, true);

    cell('站点设置').dispatch('click');

    expect(calls).toContain('site-settings');
    expect(sheetElement.hidden).toBe(false);
  });
});

describe('依赖标签的格子：无活动标签时禁用并说明原因', () => {
  const tabDependent = ['复制网址', '历史', '电脑模式', '普通打开', '站点设置', '关闭全部'] as const;

  for (const label of tabDependent) {
    it(`「${label}」在无活动标签时禁用且 aria-label 说明原因`, () => {
      const sheets = buildSheets();
      sheets.openGridMenu(0, false);

      const target = cell(label);
      expect(target.disabled).toBe(true);
      // 禁用只是"点不动"，读屏器与键盘用户还需要知道**为什么**点不动
      expect(cellLabelText(label)).toContain('无打开的标签页');
    });
  }

  it('点击禁用格不触发任何 handler（禁用态必须是真的禁用）', () => {
    const sheets = buildSheets();
    sheets.openGridMenu(0, false);

    // 程序化派发事件绕过浏览器的禁用语义，因此这里验证的是"没挂监听器"这层保障
    for (const label of tabDependent) {
      cell(label).dispatch('click');
    }

    expect(calls.filter((name) => name !== 'closed')).toEqual([]);
  });

  /**
   * 边界：标签表非空但**没有活动标签**（会话恢复时活动标签 id 失配就会被置空）。
   *
   * 此时「关闭全部」仍应可用（它只依赖"有标签"），而四个依赖**当前**标签的格子必须禁用 ——
   * 用 `tabCount > 0` 一刀切会让它们可点然后在 handler 里静默失败，用户以为按了没反应。
   */
  it('有标签但无活动标签时：关闭全部可用，依赖当前标签的格子禁用', () => {
    const sheets = buildSheets();
    sheets.openGridMenu(3, false);

    expect(cell('关闭全部').disabled).toBe(false);
    for (const label of ['复制网址', '历史', '电脑模式', '普通打开', '站点设置'] as const) {
      expect(cell(label).disabled).toBe(true);
      expect(cellLabelText(label)).toContain('无打开的标签页');
    }
  });
});

describe('仍不可用的格子：保持禁用并说明原因', () => {
  for (const label of ['分享', '添加书签'] as const) {
    it(`「${label}」始终禁用且在 aria-label 说明原因`, () => {
      const sheets = buildSheets();
      sheets.openGridMenu(1, true);

      const target = cell(label);
      expect(target.disabled).toBe(true);
      /**
       * 断言**具体原因文案**而不只是"比标签长"：读屏器只会念出 aria-label，
       * 若它只重复标签（或写成"暂未开放"以外的含糊话），用户就无从知道为什么点不动。
       * 这两格的原因与"依赖标签"的禁用不同类（那是暂时性的），因此文案也必须不同。
       */
      expect(cellLabelText(label)).toBe(`${label}（暂未开放）`);
    });
  }

  it('两格的禁用原因写成"暂未开放"，与"无打开的标签页"区分开', () => {
    const sheets = buildSheets();
    sheets.openGridMenu(0, false);

    // 无标签场景下所有依赖标签的格子也禁用了，此时两类原因必须能被区分
    expect(cellLabelText('分享')).toContain('暂未开放');
    expect(cellLabelText('分享')).not.toContain('无打开的标签页');
  });
});

describe('历史面板（九宫格「历史」格）', () => {
  function makeTab(overrides: Partial<BrowserTab> = {}): BrowserTab {
    const now = new Date().toISOString();
    return {
      tabId: 'tab-1',
      originKey: 'https://example.com',
      currentUrl: 'https://example.com/b',
      title: '第二页',
      history: [
        { url: 'https://example.com/', title: '首页', visitedAt: now },
        { url: 'https://example.com/b', title: '第二页', visitedAt: now },
      ],
      historyIndex: 1,
      loadState: 'loaded',
      createdAt: now,
      ...overrides,
    };
  }

  it('列出该标签的每一条历史记录', () => {
    const sheets = buildSheets();
    sheets.openHistory(makeTab());

    expect(sheetElement.querySelectorAll('.history-row')).toHaveLength(2);
  });

  it('倒序列出（最近访问的在最上）', () => {
    const sheets = buildSheets();
    sheets.openHistory(makeTab());

    const titles = sheetElement.querySelectorAll('.history-row-title').map((node) => node.textContent);
    expect(titles).toEqual(['第二页', '首页']);
  });

  it('当前所在项标出「当前」，其它项不标', () => {
    const sheets = buildSheets();
    sheets.openHistory(makeTab());

    const flags = sheetElement.querySelectorAll('.history-row-flag').map((node) => node.textContent);
    expect(flags).toEqual(['当前']);
  });

  it('点击一条记录按索引跳转（URL 一并给出作兜底）', () => {
    const sheets = buildSheets();
    sheets.openHistory(makeTab());

    // 倒序渲染：第 0 行是索引 1（当前页），第 1 行是索引 0（首页）
    sheetElement.querySelectorAll('.history-row')[1]?.dispatch('click');

    expect(calls).toContain('history:0:https://example.com/');
  });

  it('标题缺失时回落到 URL（空白行用户认不出是哪一页）', () => {
    const now = new Date().toISOString();
    const sheets = buildSheets();
    sheets.openHistory(
      makeTab({ history: [{ url: 'https://example.com/only', title: null, visitedAt: now }], historyIndex: 0 }),
    );

    expect(sheetElement.querySelector('.history-row-title')?.textContent).toBe('https://example.com/only');
  });

  it('历史为空时给出说明而不是空白面板', () => {
    const sheets = buildSheets();
    sheets.openHistory(makeTab({ history: [], historyIndex: 0 }));

    const empty = sheetElement.querySelector('.history-list-empty');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain('历史');
  });

  it('保留弹层打开态（不重新播放升起动画，也不改动画类名）', () => {
    const sheets = buildSheets();
    sheets.openGridMenu(1, true);

    sheets.openHistory(makeTab());

    expect(sheetElement.hidden).toBe(false);
    expect(sheetElement.querySelectorAll('.menu-cell')).toHaveLength(0);
    expect(sheetElement.querySelectorAll('.history-row')).toHaveLength(2);
  });
});

describe('弹层打开/关闭的焦点与回焦（FR-028）', () => {
  it('关闭时回焦到打开弹层的元素', () => {
    const sheets = buildSheets();
    // 模拟用户聚焦底栏菜单键后打开弹层
    const opener = dom.document.createElement('button');
    dom.document.body.append(opener);
    dom.document.activeElement = opener;

    sheets.openGridMenu(1, true);
    sheets.close();

    expect(dom.document.activeElement).toBe(opener);
  });

  /**
   * 从九宫格点进「历史」时，**打开者必须是原来那个底栏按钮**，不能变成被点掉的菜单格。
   *
   * 这是 `openOrReplace` 存在的理由：走完整 `openWith` 会把 openerElement 改写成
   * "当前聚焦的菜单格"，而那个格子随即被 clearElement 删除，关闭时便无焦可回 ——
   * 键盘用户的焦点落回 body，Tab 要从页首重新开始。
   */
  it('九宫格 → 历史：关闭后回焦到真正的打开者，而不是被删除的菜单格', () => {
    const sheets = buildSheets();
    const opener = dom.document.createElement('button');
    dom.document.body.append(opener);
    dom.document.activeElement = opener;

    sheets.openGridMenu(1, true);

    // 模拟浏览器：点击格子后焦点落到那个格子上（真实行为），随后历史面板替换掉它
    const cellButton = cell('历史');
    dom.document.activeElement = cellButton;
    sheets.openHistory(makeHistoryTab());

    // 被点的格子已从 DOM 里移除
    expect(cellButton.isConnected).toBe(false);

    sheets.close();

    expect(dom.document.activeElement).toBe(opener);
  });

  /**
   * 幂等性：**动画收尾之后**再次 close 不再通知。
   *
   * 为什么限定"之后"：`close()` 的提前返回条件读的是 `sheet.hidden`，而它要等 220ms 的
   * 收起动画结束才置位。在这 220ms 窗口内重复调用会重复通知 —— 本项目里无害
   * （`onClosed` 只是清空一个引用，幂等），但它**不是**"任意时刻都幂等"，
   * 因此断言如实写在动画之后，不去主张实现并未提供的保证。
   */
  it('收起动画结束后再次 close 不重复通知', () => {
    const sheets = buildSheets();
    sheets.openGridMenu(1, true);

    sheets.close();
    dom.advanceTimers(300);
    const afterFirst = calls.filter((name) => name === 'closed').length;

    sheets.close();

    expect(calls.filter((name) => name === 'closed')).toHaveLength(afterFirst);
    expect(afterFirst).toBe(1);
  });
});

/** 历史面板用例与回焦用例共用的标签构造 */
function makeHistoryTab(): BrowserTab {
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
  };
}

describe('弹层关闭通知（app.ts 依赖它清理来源绑定）', () => {
  it('Esc 关闭弹层并通知 onClosed', () => {
    const sheets = buildSheets();
    sheets.openGridMenu(1, true);

    dom.document.dispatchKeydown('Escape');

    expect(calls).toContain('closed');
    // 升起/关闭动画的定时器必须能收尾，否则"关闭"只停留在类名上
    dom.advanceTimers(300);
    expect(sheetElement.hidden).toBe(true);
  });
});
