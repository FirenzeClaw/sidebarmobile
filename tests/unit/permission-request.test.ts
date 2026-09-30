// sidebarmobile — 授权申请的权限集合单测（测试）
// 2026-09-29 | Kimi(speckit-fix) | 终审 A3：Tier 2 所需的 scripting 权限必须被申请

import { describe, expect, it } from 'vitest';
import { apiPermissionForGrant, OPTIONAL_PERMISSION_NAMES } from '../../src/shared/permission-names.ts';

/**
 * 终审 A3：`scripting` 在清单里是 optional，但**从不被任何授权申请**。
 *
 * 后果链条（实测确认）：权限没授予 → `browser.scripting` 命名空间不存在 →
 * `createContentScriptPort` 判定不支持 → 从不注册 content script →
 * `frame.report` / `frame.open-request` 永不产生 → 导航永为 uncertain、嵌入永不到 ok、
 * 心跳超时路径永不触发 —— 即 **Tier 2 全链路不可达**。
 *
 * 契约 `manifest-permissions.md:32` 明确要求："任一开关闭启后 → `scripting`（动态注入 content script，
 * Tier 2 追踪）"。因此本测试把"必须申请 scripting"固化为契约断言。
 */
describe('授权申请的权限集合（终审 A3 回归）', () => {
  it('scripting 声明在可选权限名单里（清单与代码一致）', () => {
    expect(OPTIONAL_PERMISSION_NAMES).toContain('scripting');
  });

  it('UA 授权申请时带上 scripting（Tier 2 的注入前提）', () => {
    expect(apiPermissionForGrant('ua')).toContain('scripting');
  });

  it('Cookie 授权申请时带上 scripting（任一开关都可开启 Tier 2）', () => {
    expect(apiPermissionForGrant('cookie')).toContain('scripting');
  });

  it('Cookie 授权仍申请 cookies（原有行为不变）', () => {
    expect(apiPermissionForGrant('cookie')).toContain('cookies');
  });

  it('申请集合里不含未声明的权限名（权限最小化，宪法 III）', () => {
    for (const grant of ['ua', 'cookie'] as const) {
      for (const name of apiPermissionForGrant(grant)) {
        expect(OPTIONAL_PERMISSION_NAMES).toContain(name);
      }
    }
  });
});
