// sidebarmobile — 上下文菜单契约单测（测试）
// 2026-09-29 | Kimi(speckit-implement) | T071/T072：四类菜单项与 ui-states.md 逐字对齐

import { describe, expect, it } from 'vitest';
import {
  SITE_ENTRY_MENU_LABELS,
  SITE_SETTINGS_MENU_LABELS,
  TAB_ENTRY_MENU_LABELS,
  NAVIGATION_MENU_LABELS,
  CONTEXT_MENU_SPECS,
} from '../../src/sidebar/components/context-menu-spec.ts';

/**
 * 这些断言把 contracts/ui-states.md 的四张菜单表格变成可执行的契约。
 *
 * 为什么值得单独测：菜单项文案是**用户可见的对外承诺**，改了就是功能变化。
 * 散落在 app.ts 里的匿名数组无法被这样断言，因此菜单项清单被抽成
 * `context-menu-spec.ts` 的可见常量（文案是数据，接线才是代码）。
 */
describe('标签页项菜单（ui-states.md §悬停图标子菜单）', () => {
  it('四项且顺序与契约一致', () => {
    expect(TAB_ENTRY_MENU_LABELS).toEqual(['刷新', '复制网址', '在普通标签页打开', '关闭']);
  });
});

describe('导航区菜单', () => {
  it('四项且顺序与契约一致', () => {
    expect(NAVIGATION_MENU_LABELS).toEqual(['前进', '后退', '刷新', '复制当前网址']);
  });
});

describe('网站条目菜单', () => {
  it('五项且顺序与契约一致', () => {
    expect(SITE_ENTRY_MENU_LABELS).toEqual(['打开', '编辑名称', '删除', '切换移动/桌面', '授权设置']);
  });
});

describe('站点设置钮菜单', () => {
  it('四项且顺序与契约一致', () => {
    expect(SITE_SETTINGS_MENU_LABELS).toEqual([
      '移动/桌面切换',
      '真实移动 UA 开关',
      '登录复用开关',
      '能力状态说明',
    ]);
  });
});

describe('四类菜单齐备（spec FR-026）', () => {
  it('恰好覆盖四类上下文', () => {
    expect(Object.keys(CONTEXT_MENU_SPECS).sort()).toEqual([
      'navigation',
      'siteEntry',
      'siteSettings',
      'tabEntry',
    ]);
  });

  it('每类都给出图标与文案（图标缺失会让菜单项只剩文字，可辨识度下降）', () => {
    for (const spec of Object.values(CONTEXT_MENU_SPECS)) {
      expect(spec.items.length).toBeGreaterThan(0);
      for (const item of spec.items) {
        expect(item.icon.length).toBeGreaterThan(0);
        expect(item.label.length).toBeGreaterThan(0);
      }
    }
  });

  it('每类菜单都声明了触发方式（提示文档与实现的期望一致）', () => {
    for (const spec of Object.values(CONTEXT_MENU_SPECS)) {
      expect(spec.description.length).toBeGreaterThan(0);
    }
  });

  it('危险操作被显式标记（用于着色，避免误点删除/关闭）', () => {
    const dangerousLabels = Object.values(CONTEXT_MENU_SPECS)
      .flatMap((spec) => spec.items)
      .filter((item) => item.danger === true)
      .map((item) => item.label);

    expect(dangerousLabels).toContain('删除');
    expect(dangerousLabels).toContain('关闭');
  });
});
