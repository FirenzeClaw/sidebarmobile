// sidebarmobile — 浏览器 API 适配出口（adapters）
// 2026-09-29 | Kimi(speckit-implement) | T019：统一封装 webextension-polyfill，业务代码禁触 chrome/browser 全局
// 2026-09-29 | Kimi(speckit-implement) | T037：补 DNR 会话规则出口
// 2026-09-29 | Kimi(speckit-fix) | 终审 A1：createStorageArea 接 storage.onChanged，供侧栏镜像授权真相
// 2026-09-29 | Kimi(speckit-fix) | 终审 C1：补 browserNamespace 出口，修复 background/content 直用 browser.* 的宪法 VII 违规

import browser from 'webextension-polyfill';
import type { StorageArea, SessionStore, StorageChange } from '../shared/session-store.ts';
import { createSessionStore } from '../shared/session-store.ts';

/**
 * [DONE] 扩展 API 的唯一出口（宪法 VII）。
 *
 * 约定：src 下除本文件外，任何模块不得直接引用 `chrome.*` / `browser.*` 全局，
 * 也不得直接 import webextension-polyfill。这样做保证：
 *   1. 双端差异只在本层与构建期清单处理（宪法 VII）；
 *   2. 单测可用 tests/helpers/mock-browser.ts 替换（不启动真实浏览器）。
 */

/** [DONE] 把 polyfill 的 storage.local 适配成 SessionStore 期望的最小接口 */
export function createStorageArea(): StorageArea {
  return {
    async get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
      // polyfill 的 storage.get 返回类型宽松，这里收敛为项目使用的 Record 形状
      const result = await browser.storage.local.get(keys ?? null);
      return (result ?? {}) as Record<string, unknown>;
    },
    async set(items: Record<string, unknown>): Promise<void> {
      await browser.storage.local.set(items);
    },
    async remove(keys: string | string[]): Promise<void> {
      await browser.storage.local.remove(keys);
    },
    /**
     * [DONE] 跨上下文存储变更订阅（终审 A1）。
     *
     * 必须用 `storage.onChanged` 而不是自己造一条消息：授权标记的唯一写入者是后台，
     * 而 `onChanged` 是浏览器保证的、**任何写入者**（后台、另一个侧栏实例、甚至用户
     * 在设置页里清理数据）都会被通知的通道。自己造消息只能覆盖"我们记得通知"的那些路径。
     *
     * 只在 storage.local 区域订阅：本项目不写 sync/managed，订阅它们只是徒增回调。
     */
    onChanged(listener: (changes: Record<string, StorageChange>) => void): () => void {
      const wrapped = (
        changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
        areaName: string,
      ): void => {
        if (areaName !== 'local') {
          return;
        }
        listener(changes);
      };
      browser.storage.onChanged.addListener(wrapped as never);
      return () => {
        browser.storage.onChanged.removeListener(wrapped as never);
      };
    },
  };
}

/** [DONE] 基于真实 storage 的会话存储实例（侧栏与后台共用同一键空间） */
export function createAppSessionStore(): SessionStore {
  return createSessionStore(createStorageArea());
}

/**
 * [DONE] 本项目实际使用的可选权限（contracts/manifest-permissions.md）。
 *
 * 名单本体定义在 `shared/permission-names.ts`（纯数据，不拉起 polyfill），此处转出以保持
 * 既有的「浏览器 API 出口」公开契约不变。
 */
export { OPTIONAL_PERMISSION_NAMES, type OptionalPermissionName } from '../shared/permission-names.ts';

import type { OptionalPermissionName } from '../shared/permission-names.ts';

/** 权限请求描述：只允许项目声明过的可选权限名 + 精确来源 pattern */
export interface PermissionRequest {
  permissions?: readonly OptionalPermissionName[];
  origins?: readonly string[];
}

/** [DONE] 权限 API 薄封装：只在适配层暴露本项目实际使用的方法 */
export const permissionsApi = {
  async contains(permissions: PermissionRequest): Promise<boolean> {
    return callPermissionsApi('contains', permissions);
  },
  async request(permissions: PermissionRequest): Promise<boolean> {
    return callPermissionsApi('request', permissions);
  },
  async remove(permissions: PermissionRequest): Promise<boolean> {
    return callPermissionsApi('remove', permissions);
  },
};

/** [DONE] 把项目权限描述转换为 polyfill 期望的形状 */
function toPolyfillPermissions(permissions: PermissionRequest): {
  permissions: OptionalPermissionName[];
  origins: string[];
} {
  return {
    permissions: [...(permissions.permissions ?? [])],
    origins: [...(permissions.origins ?? [])],
  };
}

/**
 * [DONE] 调用 polyfill 权限 API。
 *
 * [WORKAROUND 2026-09-29] @types/chrome 的 OptionalPermission 联合尚未收录
 * `declarativeNetRequestWithHostAccess`（Chrome 96+ 实际支持，MDN 与 Chrome 文档均列明），
 * 属类型定义滞后。这里用一次结构性窄化绕过，并保持入参已由 PermissionRequest 限定的安全性。
 * 替换计划：待 DefinitelyTyped 补齐该字面量后删除此转换，直接传参。
 */
function callPermissionsApi(
  method: 'contains' | 'request' | 'remove',
  permissions: PermissionRequest,
): Promise<boolean> {
  const payload = toPolyfillPermissions(permissions) as never;
  return browser.permissions[method](payload);
}

/** [DONE] 运行时消息 API 薄封装 */
export const runtimeApi = {
  async sendMessage(message: unknown): Promise<unknown> {
    return browser.runtime.sendMessage(message);
  },
  onMessage(listener: (message: unknown, sender?: unknown) => unknown): void {
    browser.runtime.onMessage.addListener(listener as never);
  },
};

/** [DONE] 在浏览器标签页打开外部地址（降级路径，spec FR-006） */
export const tabsApi = {
  async openExternal(url: string, where: 'current' | 'new'): Promise<void> {
    if (where === 'current') {
      const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (activeTab?.id !== undefined) {
        await browser.tabs.update(activeTab.id, { url });
        return;
      }
    }
    await browser.tabs.create({ url, active: true });
  },
};

/**
 * [DONE] 浏览器 API 命名空间访问器（宪法 VII）。
 *
 * 用途：本项目只用到少数几个命名空间，且部分（`cookies` / `scripting` / DNR / `sidePanel`）
 * 在可选权限未授予时**整个命名空间都不存在**，必须以 `| undefined` 的形状探测。
 * 把这些探测集中在这里，业务代码（background / content）就不再需要 `import browser`。
 *
 * 泛型参数由调用方给出：适配层不该知道每个调用方需要哪些方法（那会把业务细节拖进适配层）。
 */
export function browserNamespace<T>(name: string): T | undefined {
  return (browser as unknown as Record<string, unknown>)[name] as T | undefined;
}

/**
 * [DONE] DNR 会话规则出口（T037 UA 改写用，spec FR-010）。
 *
 * 用途：为「真实移动 UA」注册/注销按来源限定的会话规则，改写发往该来源的 `User-Agent` 请求头。
 * 失败影响：拿不到该 API 时 UA 能力落到 `unsupported`，UI 显示移动视口降级 —— 浏览本身不受影响。
 *
 * 关于「API 不存在」：T036 spike 实测，可选权限未授予时 `browser.declarativeNetRequest`
 * 整个命名空间都为 undefined（不是"存在但调用报错"）。因此这里返回 undefined 而不是抛错，
 * 由 ua-override 把它映射为 unsupported，与「规则被拒绝」的 degraded 区分开（FR-029）。
 */
export function createDnrSessionRuleApi(): DnrSessionRuleApiLike | undefined {
  const dnr = (browser as unknown as { declarativeNetRequest?: DnrSessionRuleApiLike }).declarativeNetRequest;
  if (dnr === undefined || typeof dnr.updateSessionRules !== 'function') {
    return undefined;
  }
  return dnr;
}

/** DNR 会话规则面：只声明本项目实际调用的方法 */
export interface DnrSessionRuleApiLike {
  updateSessionRules(options: { removeRuleIds?: number[]; addRules?: unknown[] }): Promise<void>;
  getSessionRules?(): Promise<Array<{ id: number }>>;
}
