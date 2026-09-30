// sidebarmobile — iframe 上报脚本（content）
// 2026-09-29 | Kimi(speckit-implement) | 初始骨架：仅上报 URL/标题，Tier 2 追踪待 T054 完整实现
// 2026-09-29 | Kimi(speckit-implement) | 改用 webextension-polyfill 统一双端 API（宪法 VII）
// 2026-09-29 | Kimi(speckit-implement) | T054：Tier 2 完整实现——URL/标题/popstate/history + _blank 意图上报
// 2026-09-29 | Kimi(speckit-fix) | 终审 C1/D1：消息发送统一走 adapters 出口；_blank 改为主路径转换

import { runtimeApi } from '../adapters/browser-api.ts';

/**
 * [DONE] 注入到已授权站点 iframe 内的上报脚本（research R3 的 Tier 2）。
 *
 * 为什么必须是它：`webNavigation` 以 tabId 为作用域，不覆盖扩展侧栏页内的 iframe，因此跨来源
 * iframe 的 URL/标题变化只能由注入脚本回传。无 host 权限时不注入，对应 Tier 1 的
 * 「地址可能未同步」不确定态（spec FR-021）。
 *
 * **安全边界（spec FR-033/FR-034，写在代码上方以便改动前先读到）**：
 * - 只读 `location.href` 与 `document.title`；**不读** Cookie、localStorage、表单值、页面正文；
 * - **不改写宿主页面**：不改 DOM、不改样式、不改原型、不拦截原有事件（只做只读旁听）；
 * - 只 `addEventListener` 且使用 passive/不 preventDefault，保证宿主行为不受影响；
 * - 上报内容只有 URL/标题/navKind，不含任何页面数据。
 *
 * 失败一律静默：上报失败只影响侧栏的状态精确度，绝不该打断宿主页面。
 */

type NavKind = 'load' | 'history' | 'hash';

/** 上一次上报的指纹，用于抑制重复上报（SPA 常连续触发多类事件） */
let lastFingerprint = '';

/** [DONE] 上报当前帧的 URL 与标题 */
async function reportFrameState(navKind: NavKind): Promise<void> {
  const url = window.location.href;
  const title = document.title;

  // 同一 (url, title, navKind) 连续上报没有新信息，抑制掉能显著减少消息量
  const fingerprint = `${url}\u0000${title}\u0000${navKind}`;
  if (fingerprint === lastFingerprint) {
    return;
  }
  lastFingerprint = fingerprint;

  try {
    await runtimeApi.sendMessage({
      type: 'frame.report',
      payload: { url, title, navKind },
    });
  } catch {
    // 侧栏未打开或后台正在重启属正常情况：静默返回，不打断宿主页面
  }
}

/**
 * [DONE] 判定一次 history 变化是 pushState/replaceState 还是纯 hash 变化。
 *
 * 为什么要区分：hash 变化不产生新文档，标题通常也不变；把两者混为一谈会让历史栈里
 * 出现大量同一页面的近重复项（spec FR-015 的 100 条上限会被快速挤满）。
 */
function classifyHistoryChange(previousUrl: string): NavKind {
  const current = window.location.href;
  const withoutHash = (value: string): string => value.split('#')[0] ?? value;
  return withoutHash(previousUrl) === withoutHash(current) ? 'hash' : 'history';
}

/**
 * [DONE] 挂钩 history API。
 *
 * 用**包装原方法**而不是监听事件：`pushState` / `replaceState` 不触发任何原生事件，
 * 包装是唯一能感知它们的手段。包装严格保留原语义（同样的 this、同样的返回值、同样的异常），
 * 且不改动其它任何行为。
 */
function hookHistoryApi(): void {
  let previousUrl = window.location.href;

  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method];
    history[method] = function patched(
      this: History,
      ...args: Parameters<History['pushState']>
    ): ReturnType<History['pushState']> {
      const result = original.apply(this, args);
      const navKind = classifyHistoryChange(previousUrl);
      previousUrl = window.location.href;
      // 微任务里上报：等页面自身的 pushState 后续同步代码执行完，标题多半已更新
      void Promise.resolve().then(() => reportFrameState(navKind));
      return result;
    } as History['pushState'];
  }

  window.addEventListener('popstate', () => {
    const navKind = classifyHistoryChange(previousUrl);
    previousUrl = window.location.href;
    void reportFrameState(navKind);
  });

  window.addEventListener('hashchange', () => {
    previousUrl = window.location.href;
    void reportFrameState('hash');
  });
}

/**
 * [DONE] 上报新窗口请求，并回报"是否已由侧栏接手"（终审 D1）。
 *
 * 返回值决定调用方是否还要走浏览器的普通新标签页降级。**必须由接收方给出这个答案**：
 * 发送方无从自行推断（侧栏可能没打开、可能没在追踪这个来源）。
 */
async function requestOpen(rawUrl: string): Promise<boolean> {
  try {
    const response = await runtimeApi.sendMessage({
      type: 'frame.open-request',
      payload: { url: rawUrl, sourceUrl: window.location.href },
    });
    // 只认显式的 handled：undefined / 形状不符都按"没人接手"处理，宁可走降级也不丢用户操作
    return typeof response === 'object' && response !== null && (response as { handled?: unknown }).handled === true;
  } catch {
    // 侧栏未打开或后台正在重启：按"没人接手"处理
    return false;
  }
}

/**
 * [DONE] 捕获新窗口意图（`target="_blank"` 与 `window.open`）—— 终审 D1，spec FR-023。
 *
 * 两条路径的可行性不同，必须分开处理，且都不能少开也不能多开：
 *
 * **点击路径可以精确转换**。点击是**可取消**事件，因此在监听器里**同步** `preventDefault()`
 * 就能可靠地阻止浏览器另开一个标签页；随后上报给侧栏建扩展内标签。
 * 若最终没人接手，再补一次 `window.open` 兑现 FR-040（不得静默阻止导航）。
 * 这是"恰好一个结果"的设计：要么侧栏开，要么浏览器开。
 *
 * 为什么 `preventDefault` 必须同步：异步（await 之后再）调用它已经太晚 —— 浏览器在事件派发
 * 结束后就启动导航了。因此这里先取消、后上报，用**上报结果**决定要不要补开，
 * 而不是"先上报再取消"。
 *
 * **`window.open` 路径只能尽力而为**。该 API 是同步的且返回值被站点立刻使用，没有任何
 * 可取消的钩子，因此无法既保证返回值可信又阻止浏览器开窗。这里的取舍是：
 * 让原调用照常执行并**信任它的结果** —— 真的开出了窗口就不再上报（否则一次请求两个标签），
 * 只在返回 null（被弹窗策略拦下等）时上报，让侧栏接手。
 */
function reportOpenRequests(): void {
  // 先捕获原生实现：降级路径要用它，而不是走下面被包装过的 window.open
  const originalOpen = window.open;

  document.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const anchor = target.closest('a');
      if (anchor === null) {
        return;
      }
      const href = anchor.getAttribute('href');
      if (href === null || href.length === 0) {
        return;
      }
      if (anchor.target !== '_blank' && anchor.target !== '_new') {
        return;
      }
      const absolute = toNavigableUrl(href);
      if (absolute === null) {
        return;
      }

      /**
       * 已经是默认行为被阻止的状态（其他监听器先动手了）就不要自作主张补开，
       * 否则会把"别人已经处理过"变成多开一个标签。
       */
      if (event.defaultPrevented) {
        return;
      }
      // 同步取消：这是唯一可靠的时机（见上方说明）
      event.preventDefault();

      void requestOpen(absolute).then((handled) => {
        if (handled) {
          return;
        }
        /**
         * 没人接手：补开普通标签页（FR-040 不得静默阻止）。
         *
         * 用**原生**实现而不是包装过的 `window.open`：包装版在返回 null 时会再上报一次，
         * 而侧栏刚说过不接手，那次上报只是噪声。
         *
         * 此处已离开用户手势，可能被弹窗策略拦下 —— 但这是"尽力保留用户操作"的唯一手段；
         * 替代方案（不阻止默认行为）会让每一次点击都多开一个标签，代价更大。
         * 契约已记录这条边界（contracts/runtime-messages.md）。
         */
        originalOpen.call(window, absolute, '_blank', 'noopener');
      });
    },
    true,
  );

  window.open = function patchedOpen(
    this: Window,
    url?: string | URL,
    target?: string,
    features?: string,
  ): Window | null {
    // 原调用照常执行：站点可能依赖返回值，绝不改变既有语义
    const result = originalOpen.call(this, url, target, features);

    /**
     * 只在该窗口**没能开出来**时上报：否则浏览器已经开了一个，侧栏再开一个就是双开
     * （这正是终审 D1 的现象）。返回值非 null 说明浏览器接受了这次打开，不需要侧栏补位。
     */
    if (result === null && typeof url === 'string' && url.length > 0) {
      const absolute = toNavigableUrl(url);
      if (absolute !== null) {
        void requestOpen(absolute);
      }
    }
    return result;
  } as typeof window.open;
}

/** [DONE] 把相对地址折成绝对 URL；非 http(s) 目标返回 null（不上报噪声） */
function toNavigableUrl(rawUrl: string): string | null {
  let absolute: string;
  try {
    absolute = new URL(rawUrl, window.location.href).href;
  } catch {
    return null;
  }
  // javascript: / mailto: 等目标不该在侧栏内打开；后台会再校验一次，这里先挡掉噪声
  return absolute.startsWith('http://') || absolute.startsWith('https://') ? absolute : null;
}

// 启动：首次上报（load 语义）+ 挂钩后续变化
void reportFrameState('load');

try {
  hookHistoryApi();
  reportOpenRequests();
} catch {
  // 某些严格 CSP 的页面可能不允许包装 history；此时只保留 load 上报，降级为近似 Tier 1
}
