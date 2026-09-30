// sidebarmobile — 后台入口（background）
// 2026-09-29 | Kimi(speckit-implement) | 初始骨架：注册侧栏打开行为，消息路由待 T038/T057 接入
// 2026-09-29 | Kimi(speckit-implement) | 改用 webextension-polyfill 统一双端 API（宪法 VII）
// 2026-09-29 | Kimi(speckit-implement) | T038：接入授权与 UA 规则消息路由（contracts/runtime-messages.md）
// 2026-09-29 | Kimi(speckit-implement) | T045/T056/T057：Cookie 授权、content script 动态注册、frame 上报处理

import {
  createErrorResponse,
  createOkResponse,
  validateRuntimeMessage,
  type GrantKind,
  type RuntimeResponse,
} from '../shared/messages.ts';
import { STORAGE_KEYS, createDefaultSiteSettings, type SiteSettings } from '../shared/types.ts';
import { createPermissionsPort } from '../adapters/permissions.ts';
import {
  browserNamespace,
  createDnrSessionRuleApi,
  createStorageArea,
  permissionsApi,
  runtimeApi,
} from '../adapters/browser-api.ts';
import { createUaOverride } from '../adapters/ua-override.ts';
import {
  createContentScriptPort,
  originKeyFromFrameUrl,
  type ContentScriptPort,
  type ScriptingApiLike,
} from '../adapters/content-scripts.ts';
import { createCookieInsight, type CookiesApiLike } from '../adapters/cookie-insight.ts';
import { createFrameReportHandler, type FrameReportHandler } from './frame-report.ts';
import { createGrantCoordinator, type GrantCoordinator } from './grant-coordinator.ts';
import { watchPermissionRemovals, type PermissionsWatchApiLike } from './permission-watch.ts';

/**
 * [DONE] 后台（Chrome Service Worker / Firefox 事件页）入口。
 *
 * MV3 约束：此处不保存跨事件内存状态。授权标记由侧栏持有并通过消息传入，
 * 后台只做特权操作（权限申请/撤销、DNR 规则注册/注销），因此重启不丢状态（宪法 III）。
 *
 * 后续任务仍待接入：frame 上报处理（T057）。
 */

/**
 * [DONE] 让工具栏图标点击时打开侧栏。
 *
 * 平台差异：Chrome 侧栏由 sidePanel API 控制，需显式设置「点击图标即开面板」；
 * Firefox 由 sidebar_action 自行管理，无对应 API，此处静默跳过 —— 差异只在此函数内，
 * 业务代码不感知浏览器（宪法 VII）。
 */
async function registerSidePanelBehaviour(): Promise<void> {
  const sidePanelApi = browserNamespace<{
    setPanelBehavior?: (options: unknown) => Promise<void>;
  }>('sidePanel');
  if (sidePanelApi?.setPanelBehavior === undefined) {
    return;
  }
  try {
    await sidePanelApi.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error: unknown) {
    // 侧栏自动打开失败不影响后台其余职责，记录后继续
    console.warn('[background] 侧栏行为注册失败', error);
  }
}

/**
 * [DONE] 授权标记的读写（后台侧）。
 *
 * 存储访问经适配层的 `createStorageArea`（宪法 VII：浏览器 API 只从 `adapters/browser-api.ts` 出），
 * 而不是直接引用 `browser.storage`。侧栏是主要写入者；后台在消息里收到的是侧栏传来的当前设置，
 * 操作后再写回存储，保证两侧看到的是同一份副本。
 * 读取失败一律回落默认值 —— 授权标记读不到时保守视为未授权。
 */
async function readSettings(originKey: string): Promise<SiteSettings> {
  try {
    const storage = createStorageArea();
    const raw = await storage.get(STORAGE_KEYS.siteSettings);
    const storedAll = raw[STORAGE_KEYS.siteSettings];
    if (typeof storedAll !== 'object' || storedAll === null) {
      return createDefaultSiteSettings();
    }
    const entry = (storedAll as Record<string, unknown>)[originKey];
    if (typeof entry !== 'object' || entry === null) {
      return createDefaultSiteSettings();
    }
    const candidate = entry as Partial<SiteSettings>;
    return {
      displayMode: candidate.displayMode === 'desktop' ? 'desktop' : 'mobile',
      uaGrant: candidate.uaGrant === 'granted' || candidate.uaGrant === 'revoked' ? candidate.uaGrant : 'never',
      cookieGrant:
        candidate.cookieGrant === 'granted' || candidate.cookieGrant === 'revoked' ? candidate.cookieGrant : 'never',
    };
  } catch {
    return createDefaultSiteSettings();
  }
}

async function writeSettings(originKey: string, settings: SiteSettings): Promise<void> {
  const storage = createStorageArea();
  const raw = await storage.get(STORAGE_KEYS.siteSettings);
  const storedAll = raw[STORAGE_KEYS.siteSettings];
  const all = typeof storedAll === 'object' && storedAll !== null ? (storedAll as Record<string, unknown>) : {};
  await storage.set({ [STORAGE_KEYS.siteSettings]: { ...all, [originKey]: settings } });
}

/** 协调器实例：无状态，可在消息到达时按需构造（SW 重启后行为一致） */
function createCoordinator(): GrantCoordinator {
  return createGrantCoordinator({
    permissions: createPermissionsPort(permissionsApi),
    uaOverride: createUaOverride({ dnr: createDnrSessionRuleApi() }),
    /**
     * Cookie 存在性检测（US3）。cookies API 与 DNR 一样，权限未授予时命名空间不存在，
     * 因此这里如实传 undefined —— 探测会返回 unsupported，能力落到 limited/unauthorized。
     */
    cookieInsight: createCookieInsight(browserNamespace<CookiesApiLike>('cookies')),
  });
}

/**
 * [DONE] 读取消息里的 grant 字段。
 *
 * `validateRuntimeMessage` 已保证它只能是 'ua' | 'cookie'，这里做一次收窄以便 TS 识别。
 */
function readGrant(payload: Record<string, unknown>): GrantKind {
  return payload['grant'] === 'cookie' ? 'cookie' : 'ua';
}

/** 当前已注册 content script 的来源集合：frame 上报的归属校验依据（T056/T057） */
const registeredScriptOrigins = new Set<string>();

/**
 * content script 端口单例。
 *
 * 必须是单例：端口的内部登记表（`isRegistered`）是模块级状态，每次 new 一个都会得到空表，
 * 于是"是否已注册"永远返回 false，Tier 2 上报会被归属校验全部丢弃。
 * 这里在首次使用时构造一次，之后复用（scripting API 在权限授予后才出现，
 * 因此构造时机放在第一次调用时，而不是模块加载时）。
 */
let scriptPortSingleton: ContentScriptPort | null = null;

/** [DONE] 取（必要时构造）content script 端口 */
function scriptPort(): ContentScriptPort {
  if (scriptPortSingleton === null) {
    scriptPortSingleton = createContentScriptPort({
      scripting: browserNamespace<ScriptingApiLike>('scripting'),
    });
  }
  return scriptPortSingleton;
}

/**
 * [DONE] 按来源同步 content script 注册状态（T056）。
 *
 * 注册前提是该来源已授权（持有 host 权限）；撤销时注销。
 * 注册失败不抛错也不改授权标记 —— Tier 2 不可用只意味着追踪退回 Tier 1 的
 * 「地址可能未同步」，浏览本身不受影响（FR-021）。
 */
async function syncContentScript(originKey: string, enabled: boolean): Promise<void> {
  const port = scriptPort();
  if (!port.isSupported()) {
    // 环境不支持动态注册：清掉登记，让归属校验不误判"有脚本可上报"
    registeredScriptOrigins.delete(originKey);
    return;
  }

  if (!enabled) {
    await port.unregister(originKey);
    registeredScriptOrigins.delete(originKey);
    return;
  }

  const registered = await port.register(originKey);
  if (registered) {
    registeredScriptOrigins.add(originKey);
  } else {
    registeredScriptOrigins.delete(originKey);
  }
}

/** [DONE] 该来源是否注册了 content script（frame 上报归属校验用） */
function hasScriptForOrigin(originKey: string): boolean {
  // 本地登记表 + API 实况双重判断：SW 重启后登记表为空，此时以 API 为准
  if (registeredScriptOrigins.has(originKey)) {
    return true;
  }
  const port = scriptPort();
  if (!port.isSupported()) {
    return false;
  }
  const isRegistered = port.isRegistered(originKey);
  if (isRegistered) {
    registeredScriptOrigins.add(originKey);
  }
  return isRegistered;
}

/**
 * frame 上报处理器：无状态构造，依赖上面两个查询函数（T057）。
 *
 * **不做转发**：content script 的 `runtime.sendMessage` 会送达**所有**扩展上下文（含侧栏页），
 * 因此侧栏自己就能收到 `frame.report` 并处理。若后台再转发一次，同一份上报会被处理两遍
 * （且后台可能收到自己发出的消息形成回环）。后台在这里只负责它独有的职责：归属校验。
 *
 * **新窗口请求由侧栏落地**（终审 D1，spec FR-023）：只有侧栏持有标签表、能新建**扩展内**标签；
 * 后台能开的只是普通浏览器标签页，那正是要避免的降级。因此这里刻意**不作为**，
 * 也刻意**不回应** —— 响应必须留给侧栏，content script 靠它决定要不要退回落（见下）。
 */
function createReportHandler(): FrameReportHandler {
  return createFrameReportHandler({
    hasScriptForOrigin,
    /**
     * 归属校验：只接受来自"已注册脚本来源"的上报。
     *
     * 返回来源键而不是标签 id —— 后台不持有标签表（标签由侧栏持有，MV3 的 SW 也无法可靠
     * 保存这份状态）。侧栏收到上报后按来源自行匹配到具体标签。
     */
    findTabByFrameUrl: (url: string) => {
      const originKey = originKeyFromFrameUrl(url);
      if (originKey === null || !hasScriptForOrigin(originKey)) {
        return null;
      }
      return originKey;
    },
    onFrameNavigated: () => {
      // 无需动作：侧栏直接收听同一条 frame.report 消息（见上方说明）
    },
    onOpenRequest: () => {
      /**
       * 刻意不做任何事。
       *
       * 曾经的实现在这里调 `tabs.create`，而侧栏同时也建了一个扩展内标签 —— 一次点击
       * 两个标签页（终审 D1）。既然主路径必须由侧栏落地，后台就不能也去开：
       * 两边都做，用户就会看到两份结果。
       */
    },
  });
}

/** [DONE] 处理单个已校验的消息；返回 undefined 表示不接管（交给其他监听者） */
async function handleMessage(type: string, payload: Record<string, unknown>): Promise<RuntimeResponse<unknown> | undefined> {
  const originKey = typeof payload['originKey'] === 'string' ? payload['originKey'] : '';

  switch (type) {
    case 'permissions.request-grant': {
      const coordinator = createCoordinator();
      const current = await readSettings(originKey);
      const grant = readGrant(payload);
      const outcome = await coordinator.requestGrant(originKey, grant, current);

      await writeSettings(originKey, outcome.settings);

      /**
       * 授权成功后同步 Tier 2 追踪：拿到 host 权限就有注入前提了（T056）。
       * 任一授权都足以覆盖该来源的 host 权限，因此两项授权合并判定。
       */
      if (outcome.granted) {
        const anyGranted = outcome.settings.uaGrant === 'granted' || outcome.settings.cookieGrant === 'granted';
        await syncContentScript(originKey, anyGranted);
      }

      // granted=false 属正常降级（用户拒绝 / 浏览器不支持），不是错误信封（runtime-messages.md）
      return createOkResponse(
        outcome.granted
          ? { granted: true, state: outcome.state }
          : { granted: false, reason: outcome.reason, state: outcome.state },
      );
    }

    case 'permissions.revoke-grant': {
      const coordinator = createCoordinator();
      const current = await readSettings(originKey);
      const grant = readGrant(payload);
      const outcome = await coordinator.revokeGrant(originKey, grant, current);

      await writeSettings(originKey, outcome.settings);

      // 即时撤销语义（FR-013）：任一项仍在授权则保留脚本，全撤则注销
      const anyGranted = outcome.settings.uaGrant === 'granted' || outcome.settings.cookieGrant === 'granted';
      await syncContentScript(originKey, anyGranted);

      return createOkResponse({ granted: false, state: outcome.state });
    }

    case 'capabilities.query': {
      const coordinator = createCoordinator();
      const current = await readSettings(originKey);
      return createOkResponse(await coordinator.queryCapabilities(originKey, current));
    }

    default: {
      // frame.report / frame.open-request 由 content script 方向发起，不走本路由：
      // 它们经 registerFrameReportListener 单独处理，避免与侧栏的请求-响应通道混在一起
      return undefined;
    }
  }
}

/**
 * [DONE] 处理来自 content script 的上报（Tier 2）。
 *
 * 单独一个监听器：content script 的消息没有"响应"语义（发完即走），
 * 与侧栏的请求-响应消息混在一个监听器里会让返回值的语义变得含糊。
 */
function registerFrameReportListener(): void {
  const handler = createReportHandler();

  runtimeApi.onMessage((message: unknown) => {
    const validation = validateRuntimeMessage(message);
    if (!validation.ok) {
      return undefined;
    }
    const { type, payload } = validation.message;

    if (type === 'frame.report') {
      handler.handleReport({
        url: typeof payload['url'] === 'string' ? payload['url'] : '',
        title: typeof payload['title'] === 'string' ? payload['title'] : '',
        navKind: payload['navKind'] as 'load' | 'history' | 'hash',
      });
      // 上报不需要响应；返回 undefined 让侧栏侧的同类型监听器也能看到（如果它在同一上下文）
      return undefined;
    }

    if (type === 'frame.open-request') {
      /**
       * 校验归属但**不落地**，也**不回应**（终审 D1）。
       *
       * 落地由侧栏负责（它能建扩展内标签，符合 FR-023）；后台若也开一个就是双开。
       * 回应必须留给侧栏：content script 靠 `{ handled: true }` 决定要不要退回落，
       * 后台抢先回一个 `undefined` 等于告诉它"没人接手"，于是又会多开一个。
       */
      handler.handleOpenRequest({
        url: typeof payload['url'] === 'string' ? payload['url'] : '',
        sourceUrl: typeof payload['sourceUrl'] === 'string' ? payload['sourceUrl'] : '',
      });
      return undefined;
    }

    return undefined;
  });
}

/** [DONE] 消息路由（contracts/runtime-messages.md） */
function registerMessageRouter(): void {
  runtimeApi.onMessage((message: unknown) => {
    const validation = validateRuntimeMessage(message);
    if (!validation.ok) {
      // 未知类型不报错也不接管；形状非法的已声明类型回错误信封（不提示用户，仅记录）
      return undefined;
    }

    const { type, payload } = validation.message;
    return handleMessage(type, payload).then(
      (response) => response ?? undefined,
      (error: unknown) => {
        // 失败不向 UI 暴露内部细节（安全红线）：只回用户可读的一句话
        console.warn('[background] 消息处理失败', type, error);
        return createErrorResponse('capability-unsupported', '该能力当前不可用');
      },
    );
  });
}

/**
 * [DONE] 权限被外部撤销时推送能力状态（FR-030，终审 [建议修改]）。
 *
 * 用户在浏览器设置里撤销权限后，扩展的唯一通知渠道就是 `permissions.onRemoved`。
 * 没有这条推送，侧栏会一直显示旧状态 —— 徽章写着「真实移动 UA」而规则其实早已失效。
 *
 * 顺带注销该来源的 content script：host 权限没了，脚本已无法注入，
 * 登记表若不同步，后续 frame 上报的归属校验会基于过期的"已注册"记录放行。
 *
 * 推送失败不影响后台其余职责：侧栏下次主动查询时仍会现算出正确状态（FR-030 的兜底）。
 */
async function pushCapabilitiesChanged(originKeys: string[]): Promise<void> {
  for (const originKey of originKeys) {
    try {
      await syncContentScript(originKey, false);
      const state = await createCoordinator().queryCapabilities(originKey, await readSettings(originKey));
      await runtimeApi.sendMessage({
        type: 'capabilities.changed',
        payload: { originKey, state },
      });
    } catch (error: unknown) {
      console.warn('[background] 能力状态推送失败', error);
    }
  }
}

/**
 * [DONE] 订阅浏览器侧的权限撤销（FR-030）。
 *
 * 这是契约里 `capabilities.changed` 的生产者：此前全项目无人订阅该事件，
 * 于是"外部撤销后自动回归降级态"这条要求实际上不会发生。
 */
function registerPermissionWatch(): void {
  watchPermissionRemovals({
    permissions: browserNamespace<PermissionsWatchApiLike>('permissions'),
    onOriginsRevoked: (originKeys) => {
      void pushCapabilitiesChanged(originKeys);
    },
  });
}

registerSidePanelBehaviour().catch((error: unknown) => {
  console.warn('[background] 初始化失败', error);
});
registerMessageRouter();
registerFrameReportListener();
registerPermissionWatch();
