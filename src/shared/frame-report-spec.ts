// sidebarmobile — 上报内容校验（shared）
// 2026-09-29 | Kimi(speckit-fix) | 终审 B3：标题上限与归一化放到共享层，两侧共用同一实现

/**
 * [DONE] 跨进程上报（frame.report）的内容清洗规则。
 *
 * **为什么必须在 shared 而不是留在后台**：上报的接收方有两个 —— 后台的归属校验器与侧栏的
 * 状态更新路径。两侧各写一份清洗规则必然漂移，而漂移的后果是安全的：后台截断了标题、
 * 侧栏却把原始超长标题直接写进状态与存储（spec FR-031 的坏数据防护被绕开）。
 *
 * 标题来自第三方页面（`document.title`），是**不可信输入**：页面可以用它塞入任意长度的字符串。
 */

/**
 * 标题长度上限。
 *
 * 取值理由：真实页面标题极少超过 200 字符；512 足够容纳长标题又不至于让恶意站点用
 * 单个标题占满存储配额（spec FR-031 的"坏数据"防护之一）。
 */
export const MAX_TITLE_LENGTH = 512;

/**
 * [DONE] 归一化标题：强制字符串、去掉首尾空白、按上限截断。
 *
 * 非字符串一律返回空串而不是抛错：调用方据此判定"没有可用标题"并沿用原值。
 */
export function normalizeTitle(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  return trimmed.length > MAX_TITLE_LENGTH ? trimmed.slice(0, MAX_TITLE_LENGTH) : trimmed;
}
