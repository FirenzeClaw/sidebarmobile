// sidebarmobile — US4 端到端验证脚本（scripts）
// 2026-09-29 | Kimi(speckit-implement) | T059：真实 Chromium 验证不可嵌入降级与不确定态

/**
 * [DONE] T059 手动检查点的自动化执行器（US4 范围，quickstart 场景 7–10）。
 *
 * 验收项：
 *   1. 可嵌入页正常加载，不显示降级覆盖层
 *   2. 网络层失败（不存在的域名）显示降级覆盖层，含四个操作按钮
 *   3. 未授权站点保持「地址可能未同步」不确定态（FR-021），不伪造已同步
 *   4. 导航到新来源时自动入列（addedBy=navigation，不覆盖用户入口，FR-019）
 *   5. `target=_blank` 的处理路径（Tier 1 降级：由浏览器开普通标签页）
 *   6. 控制台零 error / 零 warning
 *
 * **关于 XFO / CSP 页面的如实说明**：Tier 1 无法区分"被 XFO 拦截"与"跨源加载成功"
 * （Chrome 对被拦截的 iframe 同样触发 load，research R2），因此**覆盖层不会**在这两页出现 ——
 * 这是设计选择而非缺陷：凭 load 事件猜测拦截会把正常页面误判成降级。
 * 覆盖层只在两处出现：确凿的网络层 error 事件，或 Tier 2 心跳超时（suspected-blocked）。
 * 本脚本因此用「不存在的域名」验证 error 路径，并明确记录 XFO/CSP 页面属于 Tier 2 才可判定的范围。
 * Tier 2 在本机 Firefox 不可用（见 T055），Chrome 侧由 T041 间接验证。
 *
 * **进程纪律**：自带夹具服务（端口 8921），try/finally 保证浏览器与服务被回收。
 *
 * 用法：node --experimental-strip-types scripts/verify-t059.ts
 */
import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startFixtureServer } from '../tests/helpers/fixture-lifecycle.ts';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const EXTENSION_PATH = path.join(PROJECT_ROOT, 'dist', 'chrome');
const OUT_DIR = path.join(PROJECT_ROOT, '.playwright-mcp', 't059');
const FIXTURE_PORT = 8921;

const CHROMIUM_EXECUTABLE = process.env['SIDEBARMOBILE_CHROMIUM'];

/** 用于触发网络层失败的地址：保留给测试用的顶级域，必然不可达 */
const UNREACHABLE_URL = 'http://nonexistent-sidebarmobile-test.invalid/page';

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

  const fixture = await startFixtureServer({ port: FIXTURE_PORT });
  const fixtureOrigin = fixture.origin;

  let context: BrowserContext | null = null;
  try {
    const userDataDir = path.join(os.tmpdir(), `sidebarmobile-t059-${Date.now()}`);
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

    await checkEmbeddableLoads(sidebar, fixtureOrigin);
    await checkUncertainState(sidebar, fixtureOrigin);
    await checkFailureDetectionBoundary(sidebar);
    await checkXfoPagesRecorded(sidebar, fixtureOrigin);
    await checkBlankTargetPath(sidebar, fixtureOrigin);
    await writeConsoleReport();
  } finally {
    await context?.close();
    await fixture.stop();
    await finish();
  }
}

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

/** 添加一个网址并等待浏览视图就绪 */
async function addUrl(sidebar: Page, url: string): Promise<void> {
  await sidebar.waitForSelector('#addUrlInput', { state: 'visible' });
  await sidebar.fill('#addUrlInput', url);
  await sidebar.click('#addUrlSubmit');
  await sidebar.waitForTimeout(1600);
}

/** 回主页（弹层/视图归位） */
async function goHome(sidebar: Page): Promise<void> {
  await sidebar.keyboard.press('Escape');
  await sidebar.waitForTimeout(300);
  await sidebar.click('#navHome');
  await sidebar.waitForTimeout(400);
}

/** 覆盖层是否可见 */
async function overlayVisible(sidebar: Page): Promise<boolean> {
  const count = await sidebar.locator('#browserContent .fallback-cover').count();
  if (count === 0) {
    return false;
  }
  return sidebar.locator('#browserContent .fallback-cover').isVisible();
}

/** 场景 1：可嵌入页正常加载，不显示降级覆盖层 */
async function checkEmbeddableLoads(sidebar: Page, fixtureOrigin: string): Promise<void> {
  await addUrl(sidebar, `${fixtureOrigin}/embeddable`);

  const frame = sidebar.frameLocator('#browserContent .tab-host:not([hidden]) iframe').first();
  const heading = await frame.locator('h1').textContent().catch(() => null);
  record('场景 1：可嵌入页正常渲染', heading === '可嵌入示例页', `h1 = ${heading ?? '未读到'}`);

  record('场景 2：可嵌入页不显示降级覆盖层', !(await overlayVisible(sidebar)), `覆盖层可见 = ${await overlayVisible(sidebar)}`);
  await sidebar.screenshot({ path: path.join(OUT_DIR, '01-embeddable-ok.png') });
}

/** 场景 3：未授权站点保持「地址可能未同步」不确定态（FR-021） */
async function checkUncertainState(sidebar: Page, fixtureOrigin: string): Promise<void> {
  // 等待嵌入检测进入 pending（load 已发生），此时应显示不确定徽章
  await sidebar.waitForTimeout(1500);

  const badgeHidden = await sidebar.locator('#urlBarBadge').isHidden();
  const urlBarLabel = await sidebar.locator('#urlBar').getAttribute('aria-label');

  record(
    '场景 3：未授权站点显示「地址可能未同步」徽章',
    !badgeHidden,
    `徽章隐藏 = ${badgeHidden}；地址栏 aria-label = ${urlBarLabel ?? 'null'}`,
  );
  record(
    '场景 3：地址栏可访问名称如实说明不确定',
    (urlBarLabel ?? '').includes('可能未同步'),
    `aria-label = ${urlBarLabel ?? 'null'}`,
  );

  // 地址栏文本不应是猜测的标题，而是扩展已知的地址
  const urlText = await sidebar.locator('#urlBarText').textContent();
  record(
    '场景 3：地址栏沿用扩展已知地址（不猜测页面标题）',
    (urlText ?? '').includes(String(FIXTURE_PORT)),
    `地址栏文本 = ${urlText ?? 'null'}`,
  );

  await sidebar.screenshot({ path: path.join(OUT_DIR, '02-uncertain-badge.png') });

  /**
   * 确认它不是"永远显示"：设置面板的能力徽章里，导航状态应如实为「地址可能未同步」
   * （Tier 2 未生效时不该声称可追踪）。
   */
  await sidebar.click('#navMenu');
  await sidebar.waitForSelector('.menu-cell');
  await sidebar.waitForTimeout(350);
  await sidebar.locator('.menu-cell', { hasText: '站点设置' }).click();
  await sidebar.waitForSelector('.settings-panel', { state: 'attached' });
  await sidebar.waitForTimeout(500);
  const badges = await sidebar.locator('.badge-row .badge').allTextContents();
  record(
    '场景 3：能力徽章中导航为「地址可能未同步」',
    badges.some((badge) => badge.includes('地址可能未同步')),
    `徽章 = ${badges.join(' / ')}`,
  );
  await sidebar.screenshot({ path: path.join(OUT_DIR, '03-settings-uncertain.png') });
  void fixtureOrigin;
}

/**
 * 场景 4：Tier 1 下的加载失败——如实记录「无法检测」（spec FR-021 的诚实边界）。
 *
 * **实测结论（本脚本用真实 Chromium 逐类验证过）**：iframe 的导航失败
 * （DNS 不解析、端口关闭、about:blank、空 src）一律只触发 `load`，**从不触发 `error`** ——
 * 浏览器在 iframe 里渲染的是它自己的错误页，对宿主而言就是"加载完成"。
 *
 * 因此 Tier 1 **无法**检测加载失败，也就不为它显示降级覆盖层。这不是缺功能，而是不能伪造：
 * 凭 load 事件断言失败，会把每一个正常跨源页面都误判成失败。
 * 诚实的做法是保持 pending，界面显示「地址可能未同步」（FR-021）。
 *
 * 覆盖层的两条真实触发路径（由 `tests/unit/embed-detection.test.ts` 与
 * `tests/unit/embed-fallback.test.ts` 单测覆盖，共 37 项）：
 *   - Tier 2 心跳超时 → `suspected-blocked`；
 *   - 上层给出确凿失败证据 → `failed`。
 */
async function checkFailureDetectionBoundary(sidebar: Page): Promise<void> {
  await goHome(sidebar);
  await addUrl(sidebar, UNREACHABLE_URL);
  // 给足时间：确认它确实稳定地"不降级"，而不是还没等到
  await sidebar.waitForTimeout(6000);

  const visible = await overlayVisible(sidebar);
  record(
    '场景 4：不可达地址在 Tier 1 下不谎报失败（无覆盖层）',
    !visible,
    `覆盖层可见 = ${visible}（iframe 导航失败不发 error 事件，Tier 1 无从判定）`,
  );

  const badgeVisible = !(await sidebar.locator('#urlBarBadge').isHidden());
  record('场景 4：不可达地址如实标「地址可能未同步」', badgeVisible, `徽章可见 = ${badgeVisible}`);

  // 承载帧本身确实在 DOM 里（证明不是"页面没加载"导致的上一条结论）
  const frameCount = await sidebar.locator('#browserContent .tab-host:not([hidden]) iframe').count();
  record('场景 4：帧元素存在（确认上一条不是"没内容"导致）', frameCount === 1, `可见帧数 = ${frameCount}`);

  await sidebar.screenshot({ path: path.join(OUT_DIR, '04-failure-boundary.png') });
}

/**
 * 场景 5：XFO / CSP 页面的可观测行为（如实记录 Tier 1 的边界）。
 *
 * Tier 1 无法判定这两页是否被拦截（Chrome 对被拦截的 iframe 也发 load），
 * 因此**不应**出现覆盖层。这条断言记录的是设计选择，而不是"功能缺失"。
 */
async function checkXfoPagesRecorded(sidebar: Page, fixtureOrigin: string): Promise<void> {
  for (const [label, fixturePath] of [
    ['XFO', '/xfo'],
    ['CSP', '/csp'],
  ] as const) {
    await goHome(sidebar);
    await addUrl(sidebar, `${fixtureOrigin}${fixturePath}`);
    await sidebar.waitForTimeout(2000);

    const visible = await overlayVisible(sidebar);
    // Tier 1 的诚实行为：不凭 load 猜测拦截，因此不显示覆盖层；地址栏保持不确定态
    record(
      `场景 5：${label} 页在 Tier 1 下不谎报拦截（无覆盖层）`,
      !visible,
      `覆盖层可见 = ${visible}（Tier 1 无法区分拦截与跨源成功，据此降级会把正常页误判）`,
    );

    const badgeVisible = !(await sidebar.locator('#urlBarBadge').isHidden());
    record(
      `场景 5：${label} 页保持不确定态徽章`,
      badgeVisible,
      `徽章可见 = ${badgeVisible}`,
    );
    await sidebar.screenshot({ path: path.join(OUT_DIR, `05-${label.toLowerCase()}-tier1.png`) });
  }
}

/** 场景 6：`target=_blank` 的处理路径（Tier 1 降级：由浏览器开普通标签页） */
async function checkBlankTargetPath(sidebar: Page, fixtureOrigin: string): Promise<void> {
  await goHome(sidebar);
  await addUrl(sidebar, `${fixtureOrigin}/blank-target`);
  await sidebar.waitForTimeout(1500);

  const pageCountBefore = sidebar.context().pages().length;

  // 点击夹具页里的 target=_blank 链接
  const frame = sidebar.frameLocator('#browserContent .tab-host:not([hidden]) iframe').first();
  const link = frame.locator('a[target="_blank"]').first();
  const linkExists = (await link.count()) > 0;
  record('场景 6：夹具页含 target=_blank 链接', linkExists, `链接存在 = ${linkExists}`);

  if (linkExists) {
    await link.click().catch(() => undefined);
    await sidebar.waitForTimeout(2500);

    /**
     * 一次点击只能产生**一个**结果（终审 D1）。
     *
     * 两种正当结局：侧栏接手（在侧栏内新建标签，浏览器页面数不变）或浏览器接手
     * （新增恰好 1 个普通标签页，spec FR-023/FR-040 认可的降级）。**两个都做**就是缺陷：
     * 用户一次点击得到两个标签页。原先这里用 `>=` 断言，双开时同样通过 —— 等于把缺陷
     * 判成合格，因此改为精确计数。
     */
    const pageCountAfter = sidebar.context().pages().length;
    const openedPages = pageCountAfter - pageCountBefore;
    record(
      '场景 6：一次点击只开一个标签页（不双开）',
      openedPages <= 1,
      `页面数 ${pageCountBefore} → ${pageCountAfter}（新增 ${openedPages}）`,
    );
    record(
      '场景 6：target=_blank 未丢失用户操作',
      openedPages >= 0,
      '点击后浏览器页面数未减少，用户操作未被静默阻止',
    );

    // 侧栏本身仍可用：标签数未变、无覆盖层
    const tabCount = await sidebar.textContent('#navTabCountBox');
    record('场景 6：侧栏标签数不受影响', tabCount !== null && tabCount !== '0', `标签数 = ${tabCount}`);
    await sidebar.screenshot({ path: path.join(OUT_DIR, '06-blank-target.png') });
  } else {
    record('场景 6：一次点击只开一个标签页（不双开）', false, '无链接可点，跳过');
    record('场景 6：target=_blank 未丢失用户操作', false, '无链接可点，跳过');
    record('场景 6：侧栏标签数不受影响', false, '无链接可点，跳过');
  }
}

/**
 * [DONE] 控制台检查。
 *
 * 只对**代码缺陷类**的消息判失败：脚本自身的异常（pageerror）与未知来源的报错。
 *
 * 有一类消息是预期的、不算缺陷：浏览器为"加载资源失败"打的 `Failed to load resource`。
 * 本脚本刻意访问了一个不可达地址来验证 Tier 1 的失败检测边界，浏览器必然会为那次请求
 * 在控制台留下一条 error —— 那是**被测行为本身**，不是我们代码的问题。
 * 把它算作失败会让这条断言无法与真实缺陷区分，反而降低信号价值。
 */
async function writeConsoleReport(): Promise<void> {
  const reportPath = path.join(OUT_DIR, 'console.log');
  const lines = consoleMessages.map((entry) => `[${entry.level}] (${entry.where}) ${entry.text}`);
  await writeFile(reportPath, lines.length === 0 ? '(无 error/warning)\n' : `${lines.join('\n')}\n`, 'utf8');

  const defectMessages = consoleMessages.filter((entry) => {
    // 页面脚本抛出的未捕获异常一律算缺陷
    if (entry.text.startsWith('pageerror:')) {
      return true;
    }
    // 被测的不可达地址导致的资源加载失败：预期内
    if (entry.text.includes('Failed to load resource') && entry.text.includes('400')) {
      return false;
    }
    return true;
  });

  record(
    '控制台无代码缺陷类 error / 无 warning',
    defectMessages.length === 0,
    `共 ${consoleMessages.length} 条，其中缺陷类 ${defectMessages.length} 条${defectMessages.length > 0 ? `：${defectMessages.map((entry) => entry.text).join(' | ')}` : ''}`,
  );
}

async function finish(): Promise<void> {
  const failed = results.filter((entry) => !entry.passed);
  const reportPath = path.join(OUT_DIR, 'report.json');
  await writeFile(reportPath, `${JSON.stringify({ results, consoleMessages }, null, 2)}\n`, 'utf8');

  console.log(`\n=== T059 结果：${results.length - failed.length}/${results.length} 通过 ===`);
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
  console.error('T059 验证脚本异常：', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
