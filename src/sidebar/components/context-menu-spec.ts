// sidebarmobile — 上下文菜单契约（sidebar）
// 2026-09-29 | Kimi(speckit-implement) | T071/T072：四类菜单的文案与图标单一来源（ui-states.md）

import type { IconName } from './icons.ts';

/**
 * [DONE] 四类上下文菜单的**文案与图标清单**（contracts/ui-states.md §悬停图标子菜单）。
 *
 * 为什么把"文案"抽成数据而把"动作"留在 app.ts：
 * 菜单项文案是对用户的承诺，改了就是功能变化，必须能被测试逐字断言；
 * 而每个动作要调用哪个状态层函数属于装配细节，放在 app.ts 才看得清全貌。
 * 若两者写在一起（匿名数组里混着回调），文案就无法被单独验证，只能靠肉眼比对契约。
 *
 * 界面接线在 `app.ts`：那里按这些 label 建项并绑定对应的回调。
 */

export interface ContextMenuItemSpec {
  icon: IconName;
  /** 用户可见文案：必须与 ui-states.md 表格逐字一致 */
  label: string;
  /** 危险操作（关闭/删除）用错误色，降低误点代价 */
  danger?: boolean;
}

export interface ContextMenuSpec {
  /** 说明这一类菜单挂在哪里、由什么触发（供文档与测试核对） */
  description: string;
  items: readonly ContextMenuItemSpec[];
}

/** 标签页项：刷新、复制网址、在普通标签页打开、关闭 */
export const TAB_ENTRY_MENU_ITEMS: readonly ContextMenuItemSpec[] = [
  { icon: 'refresh', label: '刷新' },
  { icon: 'copy', label: '复制网址' },
  { icon: 'external', label: '在普通标签页打开' },
  { icon: 'close', label: '关闭', danger: true },
];

/** 导航区：前进、后退、刷新、复制当前网址 */
export const NAVIGATION_MENU_ITEMS: readonly ContextMenuItemSpec[] = [
  { icon: 'forward', label: '前进' },
  { icon: 'back', label: '后退' },
  { icon: 'refresh', label: '刷新' },
  { icon: 'copy', label: '复制当前网址' },
];

/** 网站条目：打开、编辑名称、删除、切换移动/桌面、授权设置 */
export const SITE_ENTRY_MENU_ITEMS: readonly ContextMenuItemSpec[] = [
  { icon: 'external', label: '打开' },
  { icon: 'edit', label: '编辑名称' },
  { icon: 'trash', label: '删除', danger: true },
  { icon: 'devices', label: '切换移动/桌面' },
  { icon: 'shield', label: '授权设置' },
];

/** 站点设置钮：移动/桌面切换、真实移动 UA 开关、登录复用开关、能力状态说明 */
export const SITE_SETTINGS_MENU_ITEMS: readonly ContextMenuItemSpec[] = [
  { icon: 'devices', label: '移动/桌面切换' },
  { icon: 'globe', label: '真实移动 UA 开关' },
  { icon: 'shield', label: '登录复用开关' },
  { icon: 'warning', label: '能力状态说明' },
];

/** 便于遍历与断言的四类集合 */
export const CONTEXT_MENU_SPECS = {
  tabEntry: { description: '标签列表每行的 ⋮ 触发钮', items: TAB_ENTRY_MENU_ITEMS },
  navigation: { description: '底栏前进/后退键（悬停或键盘聚焦）', items: NAVIGATION_MENU_ITEMS },
  siteEntry: { description: '网站列表条目的 ⋮ 触发钮', items: SITE_ENTRY_MENU_ITEMS },
  siteSettings: { description: '顶栏网址栏（站点设置入口）', items: SITE_SETTINGS_MENU_ITEMS },
} as const satisfies Record<string, ContextMenuSpec>;

/** 仅取文案的便捷出口：测试拿它逐字比契约 */
export const TAB_ENTRY_MENU_LABELS: readonly string[] = TAB_ENTRY_MENU_ITEMS.map((item) => item.label);
export const NAVIGATION_MENU_LABELS: readonly string[] = NAVIGATION_MENU_ITEMS.map((item) => item.label);
export const SITE_ENTRY_MENU_LABELS: readonly string[] = SITE_ENTRY_MENU_ITEMS.map((item) => item.label);
export const SITE_SETTINGS_MENU_LABELS: readonly string[] = SITE_SETTINGS_MENU_ITEMS.map((item) => item.label);
