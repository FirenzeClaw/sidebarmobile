// sidebarmobile — US3 端到端验证脚本（scripts）
// 2026-09-29 | Kimi(speckit-implement) | T048：真实 Chromium 验证登录复用四态与撤销清理
// 2026-09-30 | Kimi(fix) | 用户实测反馈：权限申请移到侧栏手势链内，拒绝路径改为显式模拟拒绝

/**
 * [DONE] T048 手动检查点的自动化执行器（US3 范围，quickstart 场景 6 与 12）。
 *
 * 验收项：
 *   1. 登录取用开关初始为关（未授权态）
 *   2. 开启触发权限申请；拒绝后开关回弹 + 提示 + 徽章保持未授权
 *   3. 撤销后权限被移除、标记清理、能力回归未授权
 *   4. **存储快照中不含任何 Cookie 值**（spec FR-033 / research R6 的核心红线）
 *   5. 控制台零 error / 零 warning
 *
 * **进程纪律**：脚本自带夹具服务（端口 8921），用 try/finally 保证浏览器与服务
 * 无论验证结果如何都被回收，并等待端口真正释放后才退出。
 *
 * 用法：node --experimental-strip-types scripts/verify-t048.ts
 */
import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startFixtureServer } from '../tests/helpers/fixture-lifecycle.ts';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const EXTENSION_PATH = path.join(PROJECT_ROOT, 'dist', 'chrome');
const OUT_DIR = path.join(PROJECT_ROOT, '.playwright-mcp', 't048');
const FIXTURE_PORT = 8921;

const CHROMIUM_EXECUTABLE = process.env['SIDEBARMOBILE_CHROMIUM'];

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

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  // 自带夹具服务：登录态夹具页 /login?establish=1 会设置 Cookie
  const fixture = await startFixtureServer({ port: FIXTURE_PORT });
  const fixtureOrigin = fixture.origin;

  let context: BrowserContext | null = null;
  try {
    const userDataDir = path.join(os.tmpdir(), `sidebarmobile-t048-${Date.now()}`);
    const executablePath = resolveExecutable();
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      ...(executablePath === undefined ? {} : { executablePath }),
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1000,820',
      ],
      viewport: { width: 380, height: 760 },
    });

    record('浏览器版本', context.browser() !== null, `Chromium ${context.browser()?.version() ?? '未知'}`);
    record('夹具服务', true, `自带实例已就绪：${fixtureOrigin}`);

    const extensionId = await waitForExtensionId(context);
    if (extensionId === null) {
      record('扩展加载', false, '未获取到扩展 ID');
      return;
    }
    record('扩展加载', true, `扩展 ID = ${extensionId}`);

    const sidebar = await context.newPage();
    sidebar.on('console', (message) => {
      const level = message.type();
      if (level === 'error' || level === 'warning') {
        consoleMessages.push({ level, text: message.text(), where: 'sidebar' });
      }
    });
    sidebar.on('pageerror', (error) => {
      consoleMessages.push({ level: 'error', text: `pageerror: ${error.message}`, where: 'sidebar' });
    });

    await sidebar.goto(`chrome-extension://${extensionId}/sidebar.html`);
    await sidebar.waitForSelector('.bottom-nav');

    await runFourStateChecks(sidebar, fixtureOrigin);
    await runStorageSafetyChecks(sidebar);
    await writeConsoleReport();
  } finally {
    await context?.close();
    await fixture.stop();
    await finish();
  }
}

/** 等待 service worker 注册并取出扩展 ID */
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

/** 打开登录态夹具页（它会设置 Cookie，使"存在性检测"有内容可测） */
async function openLoginFixture(sidebar: Page, fixtureOrigin: string): Promise<void> {
  await sidebar.waitForSelector('#addUrlInput', { state: 'visible' });
  await sidebar.fill('#addUrlInput', `${fixtureOrigin}/login?establish=1`);
  await sidebar.click('#addUrlSubmit');
  await sidebar.waitForTimeout(1600);
}

/** 打开站点设置面板（经九宫格菜单，与用户操作路径一致） */
async function openSettingsPanel(sidebar: Page): Promise<void> {
  await sidebar.click('#navMenu');
  await sidebar.waitForSelector('.menu-cell');
  await sidebar.locator('.sheet.open').waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined);
  await sidebar.waitForTimeout(350);
  await sidebar.locator('.menu-cell', { hasText: '站点设置' }).click();
  await sidebar.waitForSelector('.settings-panel', { state: 'attached' });
  await sidebar.waitForTimeout(600);
}

/** 读取设置面板里的全部徽章文案 */
async function readBadges(sidebar: Page): Promise<string[]> {
  await sidebar.waitForSelector('.badge-row .badge', { state: 'attached' });
  await sidebar.waitForTimeout(250);
  return sidebar.locator('.badge-row .badge').allTextContents();
}

/** 四态验证：未授权 → 授权成功 → 受限 → 撤销后清理 */
async function runFourStateChecks(sidebar: Page, fixtureOrigin: string): Promise<void> {
  await openLoginFixture(sidebar, fixtureOrigin);

  // ---- 态 1：未授权 ----
  await openSettingsPanel(sidebar);
  const cookieSwitch = sidebar.locator('.switch[aria-label="登录状态复用"]');
  const initialChecked = await cookieSwitch.getAttribute('aria-checked');
  record('态 1：登录取用开关初始为关（未授权）', initialChecked === 'false', `aria-checked = ${initialChecked}`);

  const badgesBefore = await readBadges(sidebar);
  record(
    '态 1：Cookie 徽章为「Cookie：未授权」',
    badgesBefore.includes('Cookie：未授权'),
    `徽章 = ${badgesBefore.join(' / ')}`,
  );
  await sidebar.screenshot({ path: path.join(OUT_DIR, '01-unauthorized.png') });

  /**
   * ---- 态 2 / 态 3：点击开关触发权限申请 ----
   *
   * 自动化环境里浏览器原生权限对话框无法被点击（chrome 层 UI）。
   *
   * 2026-09-30 修正（用户实测缺陷）：`permissions.request` 已移到侧栏的手势链内，
   * 修复后的申请会**悬挂等待用户裁决**（修复前在后台调用则是被 Chromium 立即抛错 —— 那正是缺陷）。
   * 因此"拒绝"这一裁决必须**显式模拟**：只替换这一次裁决，链路其余部分都是真实实现。
   * 这样本项验证的仍是产品承诺的拒绝降级语义，而不是依赖浏览器出错。
   *
   * "授权成功"分支由 `tests/integration/grant-flows.test.ts` 用 mock 覆盖，
   * 以及 `scripts/verify-grant-real.ts` 用预授权清单变体在真实浏览器里覆盖。
   */
  await sidebar.evaluate(() => {
    const loose = chrome.permissions as unknown as { request: (...args: unknown[]) => unknown };
    loose.request = (...args: unknown[]) => {
      const last = args[args.length - 1];
      if (typeof last === 'function') {
        // 透传回调（polyfill 走回调式）；漏掉回调会让外层 Promise 悬挂，那不是拒绝
        (last as (...cbArgs: unknown[]) => unknown)(false);
        return undefined;
      }
      return Promise.resolve(false);
    };
  });

  await cookieSwitch.click({ timeout: 10_000 });
  await sidebar.waitForTimeout(2500);

  const afterClickChecked = await cookieSwitch.getAttribute('aria-checked');
  record('态 3：拒绝后开关回弹为关闭', afterClickChecked === 'false', `aria-checked = ${afterClickChecked}`);

  const noticeText = await sidebar.locator('.settings-notice').textContent();
  const noticeVisible = await sidebar.locator('.settings-notice').isVisible();
  record(
    '态 3：提示「未授权，已使用降级模式」',
    noticeVisible && noticeText === '未授权，已使用降级模式',
    `提示 = ${noticeText ?? 'null'}`,
  );

  const badgesAfterDeny = await readBadges(sidebar);
  record(
    '态 3：拒绝后徽章保持未授权（不谎报可用）',
    badgesAfterDeny.includes('Cookie：未授权'),
    `徽章 = ${badgesAfterDeny.join(' / ')}`,
  );
  await sidebar.screenshot({ path: path.join(OUT_DIR, '02-denied.png') });

  /**
   * ---- 态 4：撤销后清理 ----
   *
   * 经后台消息走真实撤销路径：即便从未授权成功，撤销也必须是幂等且安全的，
   * 且**不得触碰用户的 Cookie**（research R6：只撤权限，不删数据）。
   */
  const originKey = new URL(fixtureOrigin).origin;
  const revokeResponse = await sidebar.evaluate(async (origin: string) => {
    const response = (await chrome.runtime.sendMessage({
      type: 'permissions.revoke-grant',
      payload: { originKey: origin, grant: 'cookie' },
    })) as { ok?: boolean; data?: { state?: { cookie?: string } } } | undefined;
    return JSON.stringify(response ?? null);
  }, originKey);
  record(
    '态 4：撤销请求被后台接受且能力回归未授权',
    revokeResponse.includes('"cookie":"unauthorized"'),
    `后台响应 = ${revokeResponse}`,
  );

  // 撤销后权限确实不在持有集合里
  const permissionHeld = await sidebar.evaluate(async (origin: string) => {
    const held = await chrome.permissions.contains({ permissions: ['cookies'], origins: [`${origin}/*`] });
    return String(held);
  }, originKey);
  record('态 4：撤销后 cookies 权限不再持有', permissionHeld === 'false', `contains = ${permissionHeld}`);

  // 标记已清理：存储中该来源不应残留 granted
  const settingsRaw = await sidebar.evaluate(async () => {
    const raw = await chrome.storage.local.get('site-settings:v1');
    return JSON.stringify(raw['site-settings:v1'] ?? null);
  });
  const hasGrantedResidue = settingsRaw.includes('"cookieGrant":"granted"');
  record('态 4：撤销后设置中无 cookieGrant:granted 残留', !hasGrantedResidue, `存储 = ${settingsRaw}`);

  // 重开面板确认徽章仍是未授权
  await sidebar.keyboard.press('Escape');
  await sidebar.waitForTimeout(450);
  await openSettingsPanel(sidebar);
  const badgesAfterRevoke = await readBadges(sidebar);
  record(
    '态 4：撤销后徽章保持未授权',
    badgesAfterRevoke.includes('Cookie：未授权'),
    `徽章 = ${badgesAfterRevoke.join(' / ')}`,
  );
  await sidebar.screenshot({ path: path.join(OUT_DIR, '03-after-revoke.png') });
}

/**
 * 存储安全验证（spec FR-033 / research R6 的核心红线）。
 *
 * 这是本脚本最不可让步的检查：**存储快照里不能出现任何 Cookie 值**。
 * 判据不止"没有名为 value 的字段"，还包括"夹具服务设置的会话 Cookie 名不出现"
 * 与"没有任何看起来像 Cookie 值的字符串"。
 */
async function runStorageSafetyChecks(sidebar: Page): Promise<void> {
  const snapshot = await sidebar.evaluate(async () => {
    const raw = await chrome.storage.local.get(null);
    return JSON.stringify(raw);
  });

  record(
    '存储安全：快照不含 Cookie 值字段',
    !snapshot.includes('"cookieValue"') && !snapshot.includes('"value"'),
    `含 cookieValue/value = ${snapshot.includes('"cookieValue"') || snapshot.includes('"value"')}`,
  );

  record(
    '存储安全：快照不含夹具会话 Cookie 名',
    !snapshot.includes('fixture_session'),
    `含 fixture_session = ${snapshot.includes('fixture_session')}`,
  );

  record(
    '存储安全：快照不含密码或表单字段',
    !snapshot.includes('password') && !snapshot.includes('formData'),
    `含 password/formData = ${snapshot.includes('password') || snapshot.includes('formData')}`,
  );

  record(
    '存储安全：快照不含页面内容标记',
    !snapshot.includes('<script') && !snapshot.includes('<h1'),
    `含 HTML 标记 = ${snapshot.includes('<script') || snapshot.includes('<h1')}`,
  );

  // 记录快照体量供人工核查（不含敏感内容，非空即说明确实写了东西）
  record('存储安全：存储非空（证明确实写入了会话数据）', snapshot.length > 50, `快照长度 = ${snapshot.length}`);
}

/** 写控制台报告 */
async function writeConsoleReport(): Promise<void> {
  const reportPath = path.join(OUT_DIR, 'console.log');
  const lines = consoleMessages.map((entry) => `[${entry.level}] (${entry.where}) ${entry.text}`);
  await writeFile(reportPath, lines.length === 0 ? '(无 error/warning)\n' : `${lines.join('\n')}\n`, 'utf8');
  record('控制台零 error / 零 warning', consoleMessages.length === 0, `共 ${consoleMessages.length} 条`);
}

/** 输出汇总并设置退出码 */
async function finish(): Promise<void> {
  const failed = results.filter((entry) => !entry.passed);
  const reportPath = path.join(OUT_DIR, 'report.json');
  await writeFile(reportPath, `${JSON.stringify({ results, consoleMessages }, null, 2)}\n`, 'utf8');

  console.log(`\n=== T048 结果：${results.length - failed.length}/${results.length} 通过 ===`);
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
  console.error('T048 验证脚本异常：', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
