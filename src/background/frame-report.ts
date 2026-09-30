// sidebarmobile — frame 上报处理（background）
// 2026-09-29 | Kimi(speckit-implement) | T057：实现以通过 T050（FR-020/FR-021/FR-023）
// 2026-09-29 | Kimi(speckit-fix) | 终审 B3：标题上限与归一化移交 shared/frame-report-spec，两侧共用
// 2026-09-29 | Kimi(speckit-fix) | 终审 D1：新窗口请求改由侧栏决策，后台仅在 handled=false 时补开（避免双开）
// 2026-09-29 | Kimi(speckit-fix) | 终审 [建议修改]：来源归一改用 originKeyTextFromUrl（DRY）

import { isNavigableUrl, normalizeUrl } from '../shared/url-policy.ts';
import { originKeyTextFromUrl } from '../shared/origin-key.ts';
import { MAX_TITLE_LENGTH, normalizeTitle } from '../shared/frame-report-spec.ts';

/**
 * [DONE] Tier 2 content script 上报的校验与转译（contracts/runtime-messages.md）。
 *
 * 这是**不可信输入的边界**：content script 运行在第三方页面里，页面可以伪造或篡改它发出的
 * 一切内容。因此这里对每条上报做三重校验后才转成标签更新：
 *
 * 1. **来源归属**：URL 必须属于某个已注册 content script 的来源（即已授权来源）。
 *    否则丢弃 —— 未授权站点的脚本本来就不该存在，收到其上报说明有异常。
 * 2. **标签归属**：必须能由 URL 反查到一个已打开的标签。反查不到就不猜，直接丢弃，
 *    否则会把导航串到别的标签上。
 * 3. **形状与大小**：URL 过 URL 策略；标题强制为字符串并截断（防超长标题撑爆存储与界面；
 *    清洗规则在 `shared/frame-report-spec.ts`，与侧栏共用同一实现，见终审 B3）；
 *    额外字段一律忽略，绝不透传（防夹带 Cookie / HTML 之类）。
 *
 * 只做校验与转发，不持有状态：标签的实际推进由侧栏的状态层负责，后台保持无状态（宪法 III）。
 */

/** 处理结果分类：供日志与测试断言，不面向用户 */
export type FrameReportOutcome =
  | 'accepted'
  | 'suppressed-duplicate'
  | 'dropped-origin'
  | 'dropped-no-tab'
  | 'dropped-invalid';

/** 转译后的标签更新 */
export interface FrameNavigationUpdate {
  tabId: string;
  url: string;
  title: string;
  navKind: 'load' | 'history' | 'hash';
}

export interface FrameOpenRequest {
  url: string;
  sourceUrl: string;
}

export interface FrameReporterDeps {
  /** 该来源当前是否注册了 content script（即是否已授权） */
  hasScriptForOrigin(originKey: string): boolean;
  /** 由 iframe 上报的 URL 反查所属标签；找不到返回 null */
  findTabByFrameUrl(url: string): string | null;
  onFrameNavigated(update: FrameNavigationUpdate): void;
  onOpenRequest(request: FrameOpenRequest): void;
}

export interface FrameReportInput {
  url: string;
  title: string;
  navKind: 'load' | 'history' | 'hash';
}

export interface FrameOpenRequestInput {
  url: string;
  sourceUrl: string;
}

export interface FrameReportHandler {
  handleReport(input: FrameReportInput): FrameReportOutcome;
  handleOpenRequest(input: FrameOpenRequestInput): FrameReportOutcome;
  /**
   * 清理某标签的去重记录（关闭标签时调用）。
   *
   * 不做这一步的话，长时间使用后 Map 会按"曾经打开过的标签数"无界增长；
   * 因为去重键含 tabId，关闭的标签不可能再上报，其记录永远无用。
   */
  forgetTab(tabId: string): void;
}

/**
 * 标题长度上限与归一化（终审 B3）：定义在 `shared/frame-report-spec.ts` 并被两侧共用。
 *
 * 历史：这两个原本是后台的私有实现，侧栏另有一条不经清洗的路径，于是一个超长标题能被
 * 后台挡下却从侧栏写进状态与存储。现在只有一份实现。
 */
export { MAX_TITLE_LENGTH };

const VALID_NAV_KINDS: readonly string[] = ['load', 'history', 'hash'];

/** [DONE] 判断 URL 的来源是否属于已注册来源（复用 shared 的单一实现） */
const originKeyOf = originKeyTextFromUrl;

/** [DONE] 创建 frame 上报处理器 */
export function createFrameReportHandler(deps: FrameReporterDeps): FrameReportHandler {
  /**
   * 上一次转译的更新，用于抑制重复上报。
   *
   * 为什么要抑制：SPA 常在 pushState 后再触发一次 load 或重复的 popstate，页面标题也可能
   * 被脚本反复写同名值。不去重会让每次噪声都写一遍存储（spec FR-015 的历史栈会被近重复项挤满）。
   * 键含 tabId，因此不同标签的相同 URL 不会互相抑制。
   */
  const lastUpdates = new Map<string, string>();

  return {
    handleReport(input: FrameReportInput): FrameReportOutcome {
      // 校验 1：navKind 必须在允许集合内
      if (!VALID_NAV_KINDS.includes(input.navKind)) {
        return 'dropped-invalid';
      }

      // 校验 2：URL 策略
      if (!isNavigableUrl(input.url)) {
        return 'dropped-invalid';
      }
      const url = normalizeUrl(input.url);

      // 校验 3：来源归属（未授权来源不该有脚本回报）
      const originKey = originKeyOf(url);
      if (originKey === null || !deps.hasScriptForOrigin(originKey)) {
        return 'dropped-origin';
      }

      // 校验 4：标签归属
      const tabId = deps.findTabByFrameUrl(url);
      if (tabId === null) {
        return 'dropped-no-tab';
      }

      const title = normalizeTitle(input.title);

      // 去重：同一标签的同一 (url, title, navKind) 只转译一次
      const fingerprint = `${url}\u0000${title}\u0000${input.navKind}`;
      if (lastUpdates.get(tabId) === fingerprint) {
        return 'suppressed-duplicate';
      }
      lastUpdates.set(tabId, fingerprint);

      deps.onFrameNavigated({ tabId, url, title, navKind: input.navKind });
      return 'accepted';
    },

    handleOpenRequest(input: FrameOpenRequestInput): FrameReportOutcome {
      if (!isNavigableUrl(input.url) || !isNavigableUrl(input.sourceUrl)) {
        return 'dropped-invalid';
      }

      // 来源归属按 sourceUrl 判定：只有已授权站点的脚本才可能发出这个请求
      const sourceOriginKey = originKeyOf(normalizeUrl(input.sourceUrl));
      if (sourceOriginKey === null || !deps.hasScriptForOrigin(sourceOriginKey)) {
        return 'dropped-origin';
      }

      deps.onOpenRequest({ url: normalizeUrl(input.url), sourceUrl: normalizeUrl(input.sourceUrl) });
      return 'accepted';
    },

    forgetTab(tabId: string): void {
      lastUpdates.delete(tabId);
    },
  };
}
