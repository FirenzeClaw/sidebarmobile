// sidebarmobile — 授权手势缺陷的真实浏览器验证（scripts）
// 2026-09-30 | Kimi(fix) | 用户实测反馈：验证"开关点不动"缺陷已修，并对比修复前产物

/**
 * [DONE] 「真实移动 UA / 登录状态复用」开关点不动缺陷的端到端验证。
 *
 * **为什么必须用真实浏览器**：本缺陷的判定因素只有真实 Chromium 才有 ——
 * `permissions.request()` 是否处在用户手势的直接调用链内，是浏览器内部的裁决，
 * 任何 API 替身都无法模拟（替身里它永远"成功"）。自动化环境与真人用户的差别恰在这里：
 * 检查点脚本此前只覆盖"拒绝路径"，因此 568 项单测与全部检查点都没发现这个缺陷。
 *
 * 检查项：
 *
 *   A. **修复前**（留档产物）：侧栏点击后，申请由**后台**上下文发出，
 *      Chromium **同步抛错**「This function must be called during a user gesture」，
 *      开关原地回弹且仍可交互 —— 这就是用户看到的"点不动"。
 *   B. **修复后**：同一次点击下，申请由**侧栏**上下文发出（调用位置断言），
 *      后台上下文不再发出申请。
 *   C. **修复后的可观测差异**：申请**不报错也不被瞬时否决**，而是被浏览器受理并进入裁决流程
 *      （开关进入 pending 禁用态）。修复前同一位置是 Chromium **立即抛错**，两者截然不同。
 *   D. **授权成功后的完整证据链**：用预授权清单变体模拟"用户点了允许"，验证
 *      侧栏申请 → 后台复核 → 写标记 → 落 DNR 规则 → **夹具服务实收移动 UA**。
 *   E. **拒绝路径语义不变**：开关回弹 + 「未授权，已使用降级模式」+ 徽章保持未授权。
 *
 * **如实说明本脚本的边界（重要）**：浏览器原生权限对话框是 chrome 层 UI，
 * Playwright 既点不到也截不到图。实测（多次运行）还发现自动化环境下浏览器对该对话框的处理
 * **不确定**：有时无人点击而一直挂起，有时数秒后自动裁决为 true。因此：
 *
 *   - 检查 C 的判据刻意**不用"是否悬挂"**（那种时序判据会在两次运行间翻转，属脆弱断言），
 *     而用"无错误 + 未在极短时间内返回 false"＝浏览器确实受理了这次申请。
 *     至于"对话框是否画在屏幕上"，本脚本**不做断言**（无法观测 chrome 层 UI）。
 *   - 检查 E 无法用真实对话框完成（没人能点"拒绝"），因此**用 `permissions` 的测试替身**
 *     明确模拟"用户拒绝"这一次裁决。替身只替换那一次裁决，链路其余部分都是真实实现。
 *   - 若某次运行里浏览器自动批准了申请，开关会停在开 —— 这不会让任何断言失败（各检查只看
 *     自己的可观测项），但截图内容会随之不同，解读截图时需注意这一点。
 *
 * **进程纪律**：脚本自带夹具服务（端口 8921），`try/finally` 保证浏览器、服务与临时目录
 * 全部被回收，并等待端口真正释放后才退出。不以后台常驻方式启动任何服务。
 *
 * 用法：node --experimental-strip-types scripts/verify-grant-real.ts
 */
import { chromium, type BrowserContext, type Page } from 'playwright';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startFixtureServer } from '../tests/helpers/fixture-lifecycle.ts';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const EXTENSION_PATH = path.join(PROJECT_ROOT, 'dist', 'chrome');
/**
 * 修复前的产物留档（**可选**，用于成对对比）。
 *
 * 生产来源：用 git 取修复前的提交重新构建一次，例如
 *   `git stash && git checkout <修复前提交> && npm run build && cp -r dist/chrome <此路径> && git checkout -`
 * 该目录在 `.gitignore` 内（`.playwright-mcp/`），因此新克隆上不存在属正常情况 ——
 * 缺失时脚本跳过对比检查并如实记为失败，不会假装验证过。
 */
const BASELINE_PATH = path.join(PROJECT_ROOT, '.playwright-mcp', 'grant-fix', 'baseline-prefix-chrome');
const OUT_DIR = path.join(PROJECT_ROOT, '.playwright-mcp', 'grant-fix');
const FIXTURE_PORT = 8921;

const CHROMIUM_EXECUTABLE = process.env['SIDEBARMOBILE_CHROMIUM'];

/** 探针记录：一次 `permissions.request` 的发起与落定 */
interface GrantProbeEntry {
  /** 调用时刻（相对探针安装的毫秒数）—— 调用**立即**记录，不等待落定 */
  calledAt: number;
  /** 落定时刻；null = 观察窗口内未落定（最可能是权限对话框仍开着） */
  settledAt: number | null;
  /** 落定值 */
  value: boolean | null;
  /** 调用是否抛错 */
  error: string | null;
}

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: CheckResult[] = [];
const consoleMessages: Array<{ level: string; text: string; where: string }> = [];

function record(name: string, passed: boolean, detail: string): void {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}

function resolveExecutable(): string | undefined {
  if (CHROMIUM_EXECUTABLE !== undefined && existsSync(CHROMIUM_EXECUTABLE)) {
    return CHROMIUM_EXECUTABLE;
  }
  return undefined;
}

/**
 * [DONE] 给 `permissions.request` 装**透明**探针（只观察，不改写行为）。
 *
 * 两条必须遵守的约束：
 *
 * 1. **透传全部实参**。webextension-polyfill 用回调方式调用底层 API
 *    （`target[name](...args, callback)`），探针若只接收第一个参数就会把回调吞掉 ——
 *    底层把回调当"未提供"而改走 Promise 风格，polyfill 的外层 Promise 于是永远不落定，
 *    产品代码卡在 await 上。这会让探针自己造出一个假缺陷（实测踩到过）。
 * 2. **调用即刻入账**（不等落定）。缺陷版本里 Chromium 会**同步抛错**，
 *    只在 settle 回调里记录的话，"发起了但被立即拒绝"与"从未发起"在探针里长得一样 ——
 *    而这两者正是本缺陷要区分的核心事实。
 *
 * 可行性的依据（读 polyfill 源码确认）：其包装函数在**调用时**才做 `target[name](...)`
 * 属性查找，因此替换 `chrome.permissions.request` 会被看到，且原函数照常执行。
 */
const PROBE_SOURCE = (): void => {
  const probe: unknown[] = [];
  const scope = globalThis as unknown as { __grantProbe: unknown[] };
  scope.__grantProbe = probe;
  const startedAt = Date.now();
  const loose = chrome.permissions as unknown as { request: (...args: unknown[]) => unknown };
  const original = loose.request.bind(chrome.permissions);

  loose.request = (...args: unknown[]) => {
    const entry: { calledAt: number; settledAt: number | null; value: boolean | null; error: string | null } = {
      calledAt: Date.now() - startedAt,
      settledAt: null,
      value: null,
      error: null,
    };
    probe.push(entry);

    /** 落定记账：回调式与 Promise 式共用（底层未必两者都支持） */
    const settle = (value: unknown, error: unknown): void => {
      entry.settledAt = Date.now() - startedAt;
      entry.value = value === true;
      entry.error = error === undefined || error === null ? null : String(error);
    };

    const last = args[args.length - 1];
    if (typeof last === 'function') {
      // 回调式调用（polyfill 走这条）：包一层以观察落定，随后原样转发
      const originalCallback = last as (...cbArgs: unknown[]) => unknown;
      args[args.length - 1] = (...cbArgs: unknown[]) => {
        const runtimeError = (globalThis as unknown as { chrome?: { runtime?: { lastError?: unknown } } }).chrome
          ?.runtime?.lastError;
        settle(cbArgs[0], runtimeError);
        return originalCallback(...cbArgs);
      };
    }

    try {
      const result = original(...args);
      if (typeof last !== 'function' && result !== null && typeof (result as Promise<unknown>)?.then === 'function') {
        (result as Promise<boolean>).then(
          (value) => {
            settle(value, null);
          },
          (error: unknown) => {
            settle(null, error instanceof Error ? error.message : error);
          },
        );
      }
      return result;
    } catch (error: unknown) {
      // 同步抛错（缺陷版本的典型表现）：错误信息是铁证
      entry.settledAt = Date.now() - startedAt;
      entry.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };
};

/** [DONE] 在侧栏页安装探针 */
async function installProbe(page: Page): Promise<void> {
  await page.evaluate(PROBE_SOURCE);
}

/** [DONE] 读取侧栏探针记录 */
async function readProbe(page: Page): Promise<GrantProbeEntry[]> {
  return page.evaluate(() => (globalThis as unknown as { __grantProbe?: GrantProbeEntry[] }).__grantProbe ?? []);
}

/**
 * [DONE] 在后台（Service Worker）里给 `permissions.request` 装探针。
 *
 * 必要性：只有同时观察两个上下文，"申请从后台发出"与"申请从侧栏发出"才可区分。
 * 单看侧栏探针为空，无法分辨"没人申请过"和"后台申请了但被拒"。
 * 记录逻辑与侧栏探针完全一致（同一份 `PROBE_SOURCE`）。
 */
async function installBackgroundProbe(context: BrowserContext): Promise<boolean> {
  const worker = context.serviceWorkers()[0];
  if (worker === undefined) {
    return false;
  }
  await worker.evaluate(PROBE_SOURCE);
  return true;
}

/** [DONE] 读取后台探针记录 */
async function readBackgroundProbe(context: BrowserContext): Promise<GrantProbeEntry[]> {
  const worker = context.serviceWorkers()[0];
  if (worker === undefined) {
    return [];
  }
  return worker.evaluate(
    () => (globalThis as unknown as { __grantProbe?: GrantProbeEntry[] }).__grantProbe ?? [],
  );
}

/** [DONE] 等待扩展 Service Worker 注册并取出扩展 ID */
async function waitForExtensionId(context: BrowserContext): Promise<string | null> {
  let [worker] = context.serviceWorkers();
  if (worker === undefined) {
    worker = await context.waitForEvent('serviceworker', { timeout: 15_000 }).catch(() => undefined);
  }
  if (worker === undefined) {
    return null;
  }
  const match = /^chrome-extension:\/\/([a-z]+)\//.exec(worker.url());
  return match?.[1] ?? null;
}

/** [DONE] 添加一个网址并等待浏览视图就绪 */
async function addUrl(sidebar: Page, url: string): Promise<void> {
  await sidebar.waitForSelector('#addUrlInput', { state: 'visible' });
  await sidebar.fill('#addUrlInput', url);
  await sidebar.click('#addUrlSubmit');
  await sidebar.waitForTimeout(1500);
}

/** [DONE] 打开站点设置面板（经九宫格菜单，路径与用户操作一致） */
async function openSettingsPanel(sidebar: Page): Promise<void> {
  await sidebar.click('#navMenu');
  await sidebar.waitForSelector('.menu-cell');
  await sidebar.locator('.sheet.open').waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined);
  await sidebar.waitForTimeout(350);
  await sidebar.locator('.menu-cell', { hasText: '站点设置' }).click();
  await sidebar.waitForSelector('.settings-panel', { state: 'attached' });
  await sidebar.waitForTimeout(600);
}

/** [DONE] 读取设置面板里的全部徽章文案 */
async function readBadges(sidebar: Page): Promise<string[]> {
  await sidebar.waitForSelector('.badge-row .badge', { state: 'attached' });
  await sidebar.waitForTimeout(300);
  return sidebar.locator('.badge-row .badge').allTextContents();
}

/** [DONE] 读取某来源的持久化授权标记 */
async function readStoredGrants(
  sidebar: Page,
  originKey: string,
): Promise<{ uaGrant: string; cookieGrant: string } | null> {
  return sidebar.evaluate(async (key: string) => {
    const raw = await chrome.storage.local.get('site-settings:v1');
    const all = (raw['site-settings:v1'] ?? {}) as Record<string, { uaGrant?: string; cookieGrant?: string }>;
    const entry = all[key];
    return entry === undefined ? null : { uaGrant: entry.uaGrant ?? '', cookieGrant: entry.cookieGrant ?? '' };
  }, originKey);
}

/** 开关的观察结果 */
interface SwitchObservation {
  before: string | null;
  after: string | null;
  /** 点击后开关是否被禁用（= 界面在等权限对话框） */
  disabledAfter: boolean | null;
}

/**
 * [DONE] 用一次真实鼠标点击开关，并观察开关自身的状态。
 *
 * 用 `locator.click()`（而非 `evaluate` 里直接派发 click 事件）：Playwright 的点击经
 * CDP `Input.dispatchMouseEvent` 发出，是**受信任的手势**，这是本缺陷能被验证的前提 ——
 * 用 `element.click()` 脚本触发的手势浏览器不承认，测不出真实行为。
 */
async function clickSwitchAndObserve(sidebar: Page, label: string, waitMs: number): Promise<SwitchObservation> {
  const toggle = sidebar.locator(`.switch[aria-label="${label}"]`);
  const before = await toggle.getAttribute('aria-checked');
  await toggle.click({ timeout: 10_000 });
  await sidebar.waitForTimeout(waitMs);
  return {
    before,
    after: await toggle.getAttribute('aria-checked'),
    disabledAfter: await toggle.isDisabled().catch(() => null),
  };
}

/** [DONE] 以给定扩展目录启动一次 Chromium 并跑一段检查；结束后必定关闭浏览器与临时目录 */
async function withExtension(
  extensionPath: string,
  tag: string,
  run: (context: BrowserContext, sidebar: Page) => Promise<void>,
): Promise<void> {
  const userDataDir = path.join(os.tmpdir(), `sidebarmobile-grant-${tag}-${Date.now()}`);
  const executablePath = resolveExecutable();
  let context: BrowserContext | null = null;

  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      ...(executablePath === undefined ? {} : { executablePath }),
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1000,820',
      ],
      viewport: { width: 380, height: 760 },
    });

    const extensionId = await waitForExtensionId(context);
    if (extensionId === null) {
      record(`${tag}：扩展加载`, false, '未获取到扩展 ID');
      return;
    }

    const sidebar = await context.newPage();
    sidebar.on('console', (message) => {
      const level = message.type();
      if (level === 'error' || level === 'warning') {
        consoleMessages.push({ level, text: message.text(), where: tag });
      }
    });
    sidebar.on('pageerror', (error) => {
      consoleMessages.push({ level: 'error', text: `pageerror: ${error.message}`, where: tag });
    });

    await sidebar.goto(`chrome-extension://${extensionId}/sidebar.html`);
    await sidebar.waitForSelector('.bottom-nav');

    await run(context, sidebar);
  } finally {
    await context?.close();
    // 用户数据目录属可再生成产物：回收它，避免多次运行累积
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * [DONE] 生成预授权清单变体：把可选权限移入安装期权限。
 *
 * 用途：模拟"用户在权限对话框上点了允许"。自动化环境无法点击浏览器原生对话框
 * （chrome 层 UI，Playwright 够不到），因此把"已授权"这一**前置条件**直接建立好。
 * 这不是伪造结果：检查 D 验证的仍是"侧栏申请 → 后台复核 → 落规则 → 真实 UA"的完整链路，
 * 只是把浏览器对话框那一步换成等价的既定事实。变体是临时产物，脚本结束前删除，不进 dist。
 */
async function createPreGrantedVariant(): Promise<string> {
  const variantPath = path.join(os.tmpdir(), `sidebarmobile-pregranted-${Date.now()}`);
  await cp(EXTENSION_PATH, variantPath, { recursive: true });

  const manifestPath = path.join(variantPath, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    optional_permissions?: string[];
    optional_host_permissions?: string[];
    permissions?: string[];
    host_permissions?: string[];
  };

  manifest.permissions = [...(manifest.permissions ?? []), ...(manifest.optional_permissions ?? [])];
  manifest.host_permissions = [...(manifest.host_permissions ?? []), ...(manifest.optional_host_permissions ?? [])];
  delete manifest.optional_permissions;
  delete manifest.optional_host_permissions;

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return variantPath;
}

/** [DONE] 查询夹具服务回显的最后一次 User-Agent */
async function readEchoUserAgent(origin: string): Promise<string> {
  const response = await fetch(`${origin}/echo-ua/last`, { cache: 'no-store' });
  return (await response.text()).trim();
}

/** [DONE] 重置夹具服务的 UA 回显 */
async function resetEchoUserAgent(origin: string): Promise<void> {
  await fetch(`${origin}/echo-ua/reset`, { cache: 'no-store' });
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  /**
   * 夹具服务生命周期（端口 8921）。try/finally 保证无论验证结果如何都被回收 ——
   * 依赖"外部已起好的服务"会带来服务无人回收的进程残留风险，本项目已因此出过问题。
   */
  const fixture = await startFixtureServer({ port: FIXTURE_PORT });
  const fixtureOrigin = fixture.origin;
  let preGrantedVariant: string | null = null;

  try {
    // ---------- 修复前：留档产物 ----------
    if (existsSync(path.join(BASELINE_PATH, 'manifest.json'))) {
      console.log('\n=== 修复前产物（留档副本，缺陷复现）===');
      await withExtension(BASELINE_PATH, 'baseline', async (context, sidebar) => {
        await addUrl(sidebar, `${fixtureOrigin}/embeddable`);
        await installProbe(sidebar);
        const backgroundProbed = await installBackgroundProbe(context);
        record('修复前：两个上下文的探针均可用', backgroundProbed, `后台探针安装 = ${backgroundProbed}`);

        await openSettingsPanel(sidebar);
        const observed = await clickSwitchAndObserve(sidebar, '真实移动 UA', 3000);
        await sidebar.screenshot({ path: path.join(OUT_DIR, '01-baseline-after-click.png') });

        const sidebarProbe = await readProbe(sidebar);
        const backgroundProbe = await readBackgroundProbe(context);
        const firstBackground = backgroundProbe[0];

        record(
          '修复前：申请由后台上下文发出（手势已丢失）',
          backgroundProbe.length > 0,
          `后台探针 = ${JSON.stringify(backgroundProbe)}`,
        );
        record(
          '修复前：侧栏上下文从未发起申请',
          sidebarProbe.length === 0,
          `侧栏探针 = ${sidebarProbe.length} 条`,
        );
        record(
          '修复前：Chromium 当场抛错「必须在用户手势中调用」',
          firstBackground?.error !== null &&
            firstBackground?.error !== undefined &&
            firstBackground.error.includes('user gesture'),
          firstBackground === undefined ? '后台探针无记录' : `错误 = ${String(firstBackground.error)}`,
        );
        record(
          '修复前：开关原地回弹且仍可交互（无"等待对话框"迹象）',
          observed.after === 'false' && observed.disabledAfter === false,
          `aria-checked ${observed.before} → ${observed.after}，禁用 = ${String(observed.disabledAfter)}`,
        );
      });
    } else {
      record('修复前产物留档存在', false, `未找到 ${BASELINE_PATH}，跳过对比检查`);
    }

    // ---------- 修复后：调用位置与可观测差异 ----------
    console.log('\n=== 修复后产物（dist/chrome）===');
    await withExtension(EXTENSION_PATH, 'fixed', async (context, sidebar) => {
      await addUrl(sidebar, `${fixtureOrigin}/embeddable`);
      await installProbe(sidebar);
      const backgroundProbed = await installBackgroundProbe(context);
      record('修复后：两个上下文的探针均可用', backgroundProbed, `后台探针安装 = ${backgroundProbed}`);

      await openSettingsPanel(sidebar);
      const before = await sidebar.locator('.switch[aria-label="真实移动 UA"]').getAttribute('aria-checked');
      record('修复后：开关初始为关', before === 'false', `aria-checked = ${before}`);

      const observed = await clickSwitchAndObserve(sidebar, '真实移动 UA', 3000);
      await sidebar.screenshot({ path: path.join(OUT_DIR, '02-fixed-after-click.png') });

      const sidebarProbe = await readProbe(sidebar);
      const backgroundProbe = await readBackgroundProbe(context);
      const first = sidebarProbe[0];

      record(
        '修复后：申请由侧栏上下文发出（手势链内，调用位置已修正）',
        sidebarProbe.length > 0,
        `侧栏探针 = ${JSON.stringify(sidebarProbe)}`,
      );
      record(
        '修复后：后台上下文不再发出申请（只保留复核）',
        backgroundProbe.length === 0,
        `后台探针 = ${backgroundProbe.length} 条`,
      );
      record(
        '修复后：Chromium 未报"必须在用户手势中调用"（对比修复前的立即抛错）',
        first !== undefined && (first.error === null),
        first === undefined
          ? '侧栏探针无记录'
          : `错误 = ${String(first.error)}`,
      );
      /**
       * 申请被受理的判据（不依赖对话框是否被自动裁决）。
       *
       * 实测发现自动化环境下浏览器对原生对话框的处理**不确定**：有时无人点击而一直挂起，
       * 有时数秒后自动裁决为 true。因此这条断言不使用"是否悬挂"这种时序判据 ——
       * 那种判据会在两次运行间翻转，属脆弱断言。可靠的判据是**是否被瞬时静默否决**：
       * 无错误 + 不是"极短时间内返回 false"，即说明浏览器真的受理了这次申请并走了裁决流程。
       * 修复前的同一位置是同步抛错（见上一项），两者区分明确。
       */
      const instantlyDenied =
        first?.error !== null && first?.error !== undefined
          ? true
          : first?.value === false && first.settledAt !== null && first.settledAt < 1000;
      record(
        '修复后：申请被浏览器受理，未被瞬时静默否决',
        first !== undefined && !instantlyDenied,
        first === undefined
          ? '侧栏探针无记录'
          : `结果 = ${first.settledAt === null ? '仍在等待裁决' : `${String(first.settledAt)}ms 后裁决为 ${String(first.value)}`}`,
      );
      record(
        '修复后：开关进入 pending（禁用，界面在等用户处理权限对话框）',
        observed.disabledAfter === true,
        `aria-checked ${observed.before} → ${observed.after}，禁用 = ${String(observed.disabledAfter)}`,
      );
    });

    // ---------- 授权成功后的完整证据链 ----------
    console.log('\n=== 授权成功链路（预授权清单变体）===');
    preGrantedVariant = await createPreGrantedVariant();
    await withExtension(preGrantedVariant, 'pre-granted', async (_context, sidebar) => {
      await addUrl(sidebar, `${fixtureOrigin}/echo-ua`);
      const uaBefore = await readEchoUserAgent(fixtureOrigin);
      record('授权链路：开启前夹具实收桌面 UA（基线）', !uaBefore.includes('Android'), `实收 = ${uaBefore.slice(0, 70)}`);

      await openSettingsPanel(sidebar);
      // 清零回显，让"开启后是否真的改了请求头"有唯一可归因的证据
      await resetEchoUserAgent(fixtureOrigin);

      const observed = await clickSwitchAndObserve(sidebar, '真实移动 UA', 3000);
      record(
        '授权链路：点击后开关显示为开（aria-checked=true）',
        observed.after === 'true',
        `aria-checked ${observed.before} → ${observed.after}`,
      );

      const stored = await readStoredGrants(sidebar, fixtureOrigin);
      record(
        '授权链路：后台复核通过后写入 uaGrant=granted',
        stored?.uaGrant === 'granted',
        `存储 = ${JSON.stringify(stored)}`,
      );

      const badges = await readBadges(sidebar);
      record(
        '授权链路：能力徽章为「UA：真实移动 UA」（规则确实落地）',
        badges.includes('UA：真实移动 UA'),
        `徽章 = ${badges.join(' / ')}`,
      );

      /**
       * 决定性证据：授权后应用按 FR-013 重载当前标签，iframe 会重新请求夹具页；
       * 检查**服务端实收**的 UA —— DNR 改写的是请求头，只有服务端看到的才算数
       * （界面徽章可能来自状态推断，请求头不能）。
       */
      await sidebar.waitForTimeout(2500);
      const uaAfter = await readEchoUserAgent(fixtureOrigin);
      record(
        '授权链路：夹具服务实收移动 UA（DNR 规则真实生效）',
        uaAfter.includes('Android') && uaAfter.includes('Mobile'),
        `开启后实收 = ${uaAfter.slice(0, 90)}`,
      );

      await sidebar.screenshot({ path: path.join(OUT_DIR, '03-granted-ua-applied.png') });
    });

    // ---------- 拒绝路径语义不变 ----------
    // ---------- 拒绝路径语义不变 ----------
    console.log('\n=== 拒绝路径语义（修复后，用测试替身模拟"用户点了拒绝"）===');
    await withExtension(EXTENSION_PATH, 'denied', async (_context, sidebar) => {
      await addUrl(sidebar, `${fixtureOrigin}/embeddable`);
      await openSettingsPanel(sidebar);

      /**
       * 自动化环境无法点击浏览器原生权限对话框，因此**只替换这一次裁决**：
       * 让 `permissions.request` 立刻回调 false（= 用户点了拒绝），其余链路原样保留。
       *
       * 替身必须透传回调（polyfill 走回调式），否则外层 Promise 不落定 —— 那不是拒绝，
       * 是悬挂，两者界面表现完全不同。
       */
      await sidebar.evaluate(() => {
        const loose = chrome.permissions as unknown as { request: (...args: unknown[]) => unknown };
        loose.request = (...args: unknown[]) => {
          const last = args[args.length - 1];
          if (typeof last === 'function') {
            (last as (...cbArgs: unknown[]) => unknown)(false);
            return undefined;
          }
          return Promise.resolve(false);
        };
      });

      const observed = await clickSwitchAndObserve(sidebar, '真实移动 UA', 3000);
      await sidebar.screenshot({ path: path.join(OUT_DIR, '04-denied-unchanged.png') });

      record(
        '拒绝路径：开关回弹为关（不允许留下"看起来开着"的开关）',
        observed.after === 'false',
        `aria-checked ${observed.before} → ${observed.after}`,
      );

      const noticeVisible = await sidebar.locator('.settings-notice').isVisible();
      const noticeText = await sidebar.locator('.settings-notice').textContent();
      record(
        '拒绝路径：提示文案逐字为「未授权，已使用降级模式」',
        noticeVisible && noticeText === '未授权，已使用降级模式',
        `提示 = ${noticeText ?? 'null'}（可见=${noticeVisible}）`,
      );

      const badges = await readBadges(sidebar);
      record(
        '拒绝路径：徽章保持「UA：未授权」（不谎报成功）',
        badges.includes('UA：未授权'),
        `徽章 = ${badges.join(' / ')}`,
      );

      const stored = await readStoredGrants(sidebar, fixtureOrigin);
      record(
        '拒绝路径：存储中无 granted 残留',
        stored?.uaGrant !== 'granted',
        `存储 = ${JSON.stringify(stored)}`,
      );
    });

    await writeConsoleReport();
  } finally {
    // 清理临时清单变体：属可再生成产物，不留痕
    if (preGrantedVariant !== null) {
      await rm(preGrantedVariant, { recursive: true, force: true }).catch(() => undefined);
    }
    /**
     * 停夹具服务。`stop()` 幂等：脚本任何异常早退都不会留下监听端口的孤儿进程。
     * 顺序上这里已在所有浏览器上下文关闭之后（每个 withExtension 内部各自关了浏览器）。
     */
    await fixture.stop();
    await finish();
  }
}

/** [DONE] 写控制台报告 */
async function writeConsoleReport(): Promise<void> {
  const reportPath = path.join(OUT_DIR, 'console.log');
  const lines = consoleMessages.map((entry) => `[${entry.level}] (${entry.where}) ${entry.text}`);
  await writeFile(reportPath, lines.length === 0 ? '(无 error/warning)\n' : `${lines.join('\n')}\n`, 'utf8');
  record('控制台零 error / 零 warning', consoleMessages.length === 0, `共 ${consoleMessages.length} 条`);
}

/** [DONE] 输出汇总并设置退出码 */
async function finish(): Promise<void> {
  const failed = results.filter((entry) => !entry.passed);
  const reportPath = path.join(OUT_DIR, 'report.json');
  await writeFile(reportPath, `${JSON.stringify({ results, consoleMessages }, null, 2)}\n`, 'utf8');

  console.log(`\n=== 授权手势缺陷验证结果：${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length > 0) {
    console.log('失败项：');
    for (const entry of failed) {
      console.log(`  - ${entry.name}：${entry.detail}`);
    }
    process.exitCode = 1;
  }
  console.log(`报告：${reportPath}`);
}

main().catch((error: unknown) => {
  console.error('授权手势验证脚本异常：', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
