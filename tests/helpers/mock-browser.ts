// sidebarmobile — 测试用浏览器 API mock（测试辅助）
// 2026-09-29 | Kimi(speckit-implement) | 初始版本：内存版 storage/permissions/cookies/runtime

/**
 * [DONE] 浏览器扩展 API 的内存替身。
 *
 * 目的：让 shared/adapters 层的单测与集成测试不依赖真实浏览器。
 * 约束：mock 只实现本项目实际用到的 API 面（contracts/runtime-messages.md、
 * contracts/storage-schema.md、contracts/manifest-permissions.md），不追求完整仿真。
 */

/** 内存存储：模拟 browser.storage.local 的 get/set/remove/clear */
export interface StorageAreaMock {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  clear(): Promise<void>;
  /**
   * 模拟 `browser.storage.onChanged`：把**所有**写入者的改动派发给订阅者。
   *
   * 必要性（终审 A1）：授权标记由后台写入、侧栏读取，两侧不在同一上下文。
   * 若 mock 不派发变更事件，"后台写入 → 侧栏感知"这条唯一可用的跨上下文通道就无法被测试覆盖。
   */
  onChanged(listener: (changes: Record<string, { newValue?: unknown; oldValue?: unknown }>) => void): () => void;
  /** 测试观测：当前已写入的键值快照 */
  snapshot(): Record<string, unknown>;
  /** 测试控制：让后续写入抛出指定错误（模拟配额不足）；可连续注入多次 */
  failNextWriteWith(error: unknown): void;
}

/** 内存权限：模拟 browser.permissions 的 request/contains/remove/getAll */
export interface PermissionsMock {
  request(permissions: { permissions?: readonly string[]; origins?: readonly string[] }): Promise<boolean>;
  contains(permissions: { permissions?: readonly string[]; origins?: readonly string[] }): Promise<boolean>;
  remove(permissions: { permissions?: readonly string[]; origins?: readonly string[] }): Promise<boolean>;
  getAll(): Promise<{ permissions: string[]; origins: string[] }>;
  /** 测试控制：预设 request 的返回值（默认 true） */
  setNextRequestResult(result: boolean): void;
  /**
   * 测试控制：模拟「浏览器外部撤销」——浏览器设置里被移除权限，或按来源清理站点数据。
   *
   * 用途：spec FR-030 要求扩展在权限被外部撤销后自动回归降级态，这条路径无法通过
   * 扩展自身的 remove 触发，必须在测试中直接改写浏览器侧的权限状态。
   */
  revokeExternally(permissions: { permissions?: readonly string[]; origins?: readonly string[] }): void;
  /** 测试控制：让下一次 request/contains/remove 抛出错误（模拟浏览器内部失败） */
  failNextCallWith(error: unknown): void;
}

/** 内存 Cookie：模拟 browser.cookies.getAll（仅用于存在性检测，永不返回敏感用途） */
export interface CookiesMock {
  getAll(details: { url: string }): Promise<Array<Record<string, unknown>>>;
  /** 测试控制：为某个 URL 设置可见 Cookie 数量 */
  setCookieCountForUrl(url: string, count: number): void;
}

/** 运行时消息：模拟 browser.runtime.sendMessage 与 onMessage */
export interface RuntimeMock {
  sendMessage(message: unknown): Promise<unknown>;
  onMessage: {
    addListener(listener: (message: unknown, sender?: unknown) => unknown): void;
  };
  /** 测试观测：已发送的消息记录 */
  sentMessages: unknown[];
  /** 测试控制：让 sendMessage 抛出错误（模拟无接收端） */
  failNextSendWith(error: unknown): void;
}

export interface BrowserMock {
  storage: { local: StorageAreaMock };
  permissions: PermissionsMock;
  cookies: CookiesMock;
  runtime: RuntimeMock;
  /** 测试辅助：整体重置为初始状态 */
  reset(): void;
}

export function createBrowserMock(): BrowserMock {
  let storageData: Record<string, unknown> = {};
  const pendingWriteErrors: unknown[] = [];
  let pendingRequestResult = true;
  let pendingPermissionError: unknown = null;
  let pendingSendError: unknown = null;
  const cookieCounts = new Map<string, number>();
  const sentMessages: unknown[] = [];
  const storageChangeListeners: Array<
    (changes: Record<string, { newValue?: unknown; oldValue?: unknown }>) => void
  > = [];

  /** 派发存储变更：在写入/删除**完成之后**调用，与真实 onChanged 的时序一致 */
  function emitStorageChanges(changes: Record<string, { newValue?: unknown; oldValue?: unknown }>): void {
    for (const listener of storageChangeListeners) {
      listener(changes);
    }
  }

  const storageLocal: StorageAreaMock = {
    async get(keys) {
      if (keys === undefined || keys === null) {
        return { ...storageData };
      }
      const requestedKeys = Array.isArray(keys) ? keys : [keys];
      const result: Record<string, unknown> = {};
      for (const key of requestedKeys) {
        if (Object.prototype.hasOwnProperty.call(storageData, key)) {
          result[key] = storageData[key];
        }
      }
      return result;
    },
    async set(items) {
      if (pendingWriteErrors.length > 0) {
        const error = pendingWriteErrors.shift();
        throw error;
      }
      const changes: Record<string, { newValue?: unknown; oldValue?: unknown }> = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { newValue: value, oldValue: storageData[key] };
      }
      storageData = { ...storageData, ...items };
      emitStorageChanges(changes);
    },
    async remove(keys) {
      const requestedKeys = Array.isArray(keys) ? keys : [keys];
      const nextData = { ...storageData };
      const changes: Record<string, { newValue?: unknown; oldValue?: unknown }> = {};
      for (const key of requestedKeys) {
        changes[key] = { oldValue: storageData[key] };
        delete nextData[key];
      }
      storageData = nextData;
      emitStorageChanges(changes);
    },
    async clear() {
      const changes: Record<string, { newValue?: unknown; oldValue?: unknown }> = {};
      for (const [key, value] of Object.entries(storageData)) {
        changes[key] = { oldValue: value };
      }
      storageData = {};
      emitStorageChanges(changes);
    },
    onChanged(listener) {
      storageChangeListeners.push(listener);
      return () => {
        const index = storageChangeListeners.indexOf(listener);
        if (index >= 0) {
          storageChangeListeners.splice(index, 1);
        }
      };
    },
    snapshot() {
      return { ...storageData };
    },
    failNextWriteWith(error) {
      pendingWriteErrors.push(error);
    },
  };

  const permissionsMock: PermissionsMock = {
    async request(permissions) {
      if (pendingPermissionError !== null) {
        const error = pendingPermissionError;
        pendingPermissionError = null;
        throw error;
      }
      if (!pendingRequestResult) {
        return false;
      }
      // 忠实模拟浏览器：只有用户批准后才会把**本次请求的**权限记为已授予
      const requestedOrigins = permissions.origins ?? [];
      const requestedNames = permissions.permissions ?? [];
      const grantedOrigins = (storageData['__mockGrantedOrigins'] as string[] | undefined) ?? [];
      const grantedNames = (storageData['__mockGrantedPermissions'] as string[] | undefined) ?? [];
      storageData['__mockGrantedOrigins'] = [...new Set([...grantedOrigins, ...requestedOrigins])];
      storageData['__mockGrantedPermissions'] = [...new Set([...grantedNames, ...requestedNames])];
      return true;
    },

    async contains(permissions) {
      if (pendingPermissionError !== null) {
        const error = pendingPermissionError;
        pendingPermissionError = null;
        throw error;
      }
      const origins = permissions.origins ?? [];
      const names = permissions.permissions ?? [];
      const grantedOrigins = (storageData['__mockGrantedOrigins'] as string[] | undefined) ?? [];
      const grantedNames = (storageData['__mockGrantedPermissions'] as string[] | undefined) ?? [];
      return (
        origins.every((origin) => grantedOrigins.includes(origin)) &&
        names.every((name) => grantedNames.includes(name))
      );
    },

    async remove(permissions) {
      if (pendingPermissionError !== null) {
        const error = pendingPermissionError;
        pendingPermissionError = null;
        throw error;
      }
      const origins = permissions.origins ?? [];
      const names = permissions.permissions ?? [];
      const remainingOrigins = ((storageData['__mockGrantedOrigins'] as string[] | undefined) ?? []).filter(
        (origin) => !origins.includes(origin),
      );
      const remainingNames = ((storageData['__mockGrantedPermissions'] as string[] | undefined) ?? []).filter(
        (name) => !names.includes(name),
      );
      storageData['__mockGrantedOrigins'] = remainingOrigins;
      storageData['__mockGrantedPermissions'] = remainingNames;
      return true;
    },

    async getAll() {
      return {
        permissions: (storageData['__mockGrantedPermissions'] as string[] | undefined) ?? [],
        origins: (storageData['__mockGrantedOrigins'] as string[] | undefined) ?? [],
      };
    },

    setNextRequestResult(result) {
      pendingRequestResult = result;
    },

    revokeExternally(permissions) {
      // 直接改写浏览器侧状态，不经过扩展的 remove 路径：模型化「用户去浏览器设置里撤销」
      const origins = permissions.origins ?? [];
      const names = permissions.permissions ?? [];
      storageData['__mockGrantedOrigins'] = (
        (storageData['__mockGrantedOrigins'] as string[] | undefined) ?? []
      ).filter((origin) => !origins.includes(origin));
      storageData['__mockGrantedPermissions'] = (
        (storageData['__mockGrantedPermissions'] as string[] | undefined) ?? []
      ).filter((name) => !names.includes(name));
    },

    failNextCallWith(error) {
      pendingPermissionError = error;
    },
  };

  const cookiesMock: CookiesMock = {
    async getAll(details) {
      const count = cookieCounts.get(details.url) ?? 0;
      return Array.from({ length: count }, (_unused, index) => ({
        name: `cookie-${index}`,
        domain: new URL(details.url).hostname,
      }));
    },
    setCookieCountForUrl(url, count) {
      cookieCounts.set(url, count);
    },
  };

  const messageListeners: Array<(message: unknown, sender?: unknown) => unknown> = [];

  const runtimeMock: RuntimeMock = {
    async sendMessage(message) {
      if (pendingSendError !== null) {
        const error = pendingSendError;
        pendingSendError = null;
        throw error;
      }
      sentMessages.push(message);
      for (const listener of messageListeners) {
        const response = listener(message);
        if (response !== undefined) {
          return response;
        }
      }
      return undefined;
    },
    onMessage: {
      addListener(listener) {
        messageListeners.push(listener);
      },
    },
    sentMessages,
    failNextSendWith(error) {
      pendingSendError = error;
    },
  };

  return {
    storage: { local: storageLocal },
    permissions: permissionsMock,
    cookies: cookiesMock,
    runtime: runtimeMock,
    reset() {
      storageData = {};
      pendingWriteErrors.length = 0;
      pendingRequestResult = true;
      pendingPermissionError = null;
      pendingSendError = null;
      cookieCounts.clear();
      sentMessages.length = 0;
      messageListeners.length = 0;
      storageChangeListeners.length = 0;
    },
  };
}
