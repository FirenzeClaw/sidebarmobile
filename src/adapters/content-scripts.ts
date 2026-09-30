// sidebarmobile — content script 动态注册适配（adapters）
// 2026-09-29 | Kimi(speckit-implement) | T056：按精确来源注册/注销 Tier 2 上报脚本（contracts/manifest-permissions.md）

import { originKeyFromUrl, originKeyTextFromUrl } from '../shared/origin-key.ts';

/**
 * [DONE] 按精确来源动态注册 / 注销 content script（contracts/manifest-permissions.md）。
 *
 * 为什么不用静态 `content_scripts`：静态声明要么写 `<all_urls>`（宽权限，违反宪法 III 权限最小化），
 * 要么在安装时就列出所有站点 —— 而本项目的授权是**按精确来源、按需授予**的。动态注册让脚本的
 * 存在范围恰好等于已授权范围，"没有权限就没有脚本"由此成为结构事实，而不是需要靠代码自觉维持的约定。
 *
 * 双端差异收敛在本文件（宪法 VII）：容器差异（Chrome 的 `persistent` 语义）在此处理，
 * 业务代码只调用 `syncForOrigin`，不感知浏览器。
 */

/** scripting API 的最小面：只声明本项目用到的三个方法 */
export interface ScriptingApiLike {
  registerContentScripts?(scripts: unknown[]): Promise<void>;
  unregisterContentScripts?(filter?: { ids?: string[] }): Promise<void>;
  getRegisteredContentScripts?(): Promise<Array<{ id: string }>>;
}

export interface ContentScriptRegistration {
  /** 注册 id：由来源键稳定推导，便于精确注销 */
  id: string;
  /** 匹配的 host pattern（精确来源） */
  matches: string[];
}

export interface ContentScriptPort {
  /** 该环境是否支持动态注册（不支持时 Tier 2 不可用，如实降级为 Tier 1） */
  isSupported(): boolean;
  /** 注册某来源的脚本；已存在则幂等返回 */
  register(originKey: string): Promise<boolean>;
  /** 注销某来源的脚本；不存在则幂等返回 */
  unregister(originKey: string): Promise<boolean>;
  /** 该来源当前是否已注册 */
  isRegistered(originKey: string): boolean;
  /** 由来源键推导注册描述；非法来源返回 null */
  registrationFor(originKey: string): ContentScriptRegistration | null;
}

/** 注册 id 前缀：与其它可能引入的脚本命名空间隔开 */
const SCRIPT_ID_PREFIX = 'sbmb-frame-reporter-';

/** content script 文件路径（构建产物名，与 scripts/build.ts 的入口名一致） */
export const FRAME_REPORTER_FILE = 'content.js';

/**
 * [DONE] 由来源键推导注册 id。
 *
 * 用来源本身而不是序号：注销时无需查表，SW 重启后也能由 sites:v1 直接重建出同一批 id。
 * 非法字符替换为 `-`，保证 id 满足 API 的字符要求。
 */
export function scriptIdFor(originKey: string): string | null {
  if (originKeyFromUrl(originKey) === null) {
    return null;
  }
  return `${SCRIPT_ID_PREFIX}${originKey.replace(/[^a-zA-Z0-9.-]/g, '-')}`;
}

/** [DONE] 由来源键生成 host pattern（与 UA 权限使用同一套来源语义） */
export function matchPatternFor(originKey: string): string | null {
  const parsed = originKeyFromUrl(originKey);
  if (parsed === null) {
    return null;
  }
  const portSuffix = parsed.port === null ? '' : `:${parsed.port}`;
  return `${parsed.scheme}://${parsed.host}${portSuffix}/*`;
}

export interface ContentScriptOptions {
  scripting: ScriptingApiLike | undefined;
}

/** [DONE] 创建 content script 注册端口 */
export function createContentScriptPort(options: ContentScriptOptions): ContentScriptPort {
  const { scripting } = options;
  /** 本地登记表：API 的查询能力在各版本不一致，用它做幂等判定更可靠 */
  const registered = new Set<string>();

  /** [DONE] 该环境是否具备动态注册能力 */
  function isSupported(): boolean {
    return (
      scripting !== undefined &&
      typeof scripting.registerContentScripts === 'function' &&
      typeof scripting.unregisterContentScripts === 'function'
    );
  }

  return {
    isSupported,

    registrationFor(originKey: string): ContentScriptRegistration | null {
      const id = scriptIdFor(originKey);
      const matches = matchPatternFor(originKey);
      if (id === null || matches === null) {
        return null;
      }
      return { id, matches: [matches] };
    },

    isRegistered(originKey: string): boolean {
      return registered.has(originKey);
    },

    async register(originKey: string): Promise<boolean> {
      const registration = this.registrationFor(originKey);
      if (registration === null || !isSupported()) {
        return false;
      }
      // 幂等：重复注册同一 id 会被浏览器拒绝，先自行挡下
      if (registered.has(originKey)) {
        return true;
      }

      try {
        await scripting!.registerContentScripts!([
          {
            id: registration.id,
            matches: registration.matches,
            js: [FRAME_REPORTER_FILE],
            /**
             * 必须注入到所有帧：侧栏的 iframe 本身就是子框架，只注入顶层文档的话，
             * 侧栏内容区（扩展页）之外的被测页面收不到脚本。
             */
            allFrames: true,
            runAt: 'document_idle',
          },
        ]);
        registered.add(originKey);
        return true;
      } catch {
        // 注册失败（如清单未声明 scripting、来源 pattern 非法）：如实返回失败，
        // 由能力状态显示为降级（Tier 1 不确定态），不谎报已启用追踪
        return false;
      }
    },

    async unregister(originKey: string): Promise<boolean> {
      const registration = this.registrationFor(originKey);
      if (registration === null || !isSupported()) {
        // 即便 API 不可用也要清掉本地登记，否则界面会继续声称已启用
        registered.delete(originKey);
        return false;
      }
      registered.delete(originKey);

      try {
        await scripting!.unregisterContentScripts!({ ids: [registration.id] });
        return true;
      } catch {
        // 注销失败不影响撤销授权的语义：权限已被移除后脚本本就无法运行
        return false;
      }
    },
  };
}

/** [DONE] 由 URL 反查它属于哪个已注册来源（frame 上报归属校验用） */
export function originKeyFromFrameUrl(url: string): string | null {
  // 复用 shared 的单一实现（终审 [建议修改] DRY）：这里曾自己拼 `scheme://host:port`，
  // 与 origin-key.ts 的序列化规则重复 —— 一旦端口归一化规则改动，两处就会给出不同的键
  return originKeyTextFromUrl(url);
}
