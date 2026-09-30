// sidebarmobile — 扩展端到端验证脚本（scripts）
// 2026-09-29 | Kimi(speckit-implement) | T029：真实 Chromium 加载 dist/chrome，验证 quickstart 场景 1-3

/**
 * [DONE] 手动检查点的自动化执行器。
 *
 * 与 tests/e2e（Playwright Test）的分工：本脚本是一次性驱动，用于开发期快速验证
 * 「侧栏页在真实浏览器中的行为」，并把截图与逐项结果写入 .playwright-mcp/t029/。
 *
 * 执行的 quickstart 场景：
 *   1. 添加网址 → 保存入列表并立即在新标签打开
 *   2. 非法地址 → 拒绝且列表无新增
 *   3. 多标签 → 切换、关闭；关闭的标签不随侧栏重载恢复
 *
 * 用法：node --experimental-strip-types scripts/verify-t029.ts
 */
import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startFixtureServer } from '../tests/helpers/fixture-lifecycle.ts';

/** 夹具服务端口：避开其它切片的端口，且由本脚本自管生命周期 */
const FIXTURE_PORT = 8921;

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const EXTENSION_PATH = path.join(PROJECT_ROOT, 'dist', 'chrome');
const OUT_DIR = path.join(PROJECT_ROOT, '.playwright-mcp', 't029');

/**
 * 夹具服务地址。
 *
 * 由脚本**自带的服务实例**在 main() 里赋值（端口 8921）——不依赖外部已启动的服务，
 * 也就不存在"服务由别人起、没人负责收"的进程残留风险。
 * 声明为 `let` 是因为要在服务就绪后才知道实际端口。
 */
let FIXTURE_ORIGIN = 'http://127.0.0.1:8921';

/**
 * Chromium 可执行路径。
 *
 * 默认让 Playwright 自行解析（标准安装位置）；如本机下载受限，可用环境变量
 * SIDEBARMOBILE_CHROMIUM 指向一个 Chrome for Testing 的 chrome.exe（例如临时解包目录）。
 */
const CHROMIUM_EXECUTABLE = process.env['SIDEBARMOBILE_CHROMIUM'];

/** 取回实际使用的可执行路径，便于在报告中记录验证环境 */
function resolveExecutable(): string | undefined {
  if (CHROMIUM_EXECUTABLE !== undefined && existsSync(CHROMIUM_EXECUTABLE)) {
    return CHROMIUM_EXECUTABLE;
  }
  return undefined;
}

/** 逐项检查结果 */
interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: CheckResult[] = [];
/** 浏览器控制台消息（error/warning 为验收门槛） */
const consoleMessages: Array<{ level: string; text: string; where: string }> = [];

function record(name: string, passed: boolean, detail: string): void {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  /**
   * 自带夹具服务生命周期（端口 8921）。
   *
   * 用 try/finally 包住整个流程：无论验证成功、失败还是抛异常，服务都会被终止，
   * 且 `stop()` 会等到端口真正释放才返回。
   */
  const fixture = await startFixtureServer({ port: FIXTURE_PORT });
  FIXTURE_ORIGIN = fixture.origin;

  let context: BrowserContext | null = null;
  try {
    // 扩展需要持久化上下文 + 有头模式；headless 下 Chrome 不加载未打包扩展
    const userDataDir = path.join(os.tmpdir(), `sidebarmobile-t029-${Date.now()}`);
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
    record('夹具服务', true, `自带实例已就绪：${fixture.origin}`);

    const extensionId = await waitForExtensionId(context);
    record('扩展加载', extensionId !== null, `扩展 ID = ${extensionId ?? '未获取到'}`);
    if (extensionId === null) {
      return;
    }

    const sidebarUrl = `chrome-extension://${extensionId}/sidebar.html`;
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
    await sidebar.goto(sidebarUrl);
    await sidebar.waitForSelector('#addUrlForm');

    await runScenario1(sidebar);
    await runScenario2(sidebar);
    await runScenario3(sidebar, context);

    await writeConsoleReport();
  } finally {
    // 顺序：先关浏览器（它持有对夹具服务的连接），再停服务
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

/** 场景 1：添加网址 → 列表新增 + 新标签打开 */
async function runScenario1(sidebar: Page): Promise<void> {
  await sidebar.fill('#addUrlInput', `${FIXTURE_ORIGIN}/embeddable`);
  await sidebar.click('#addUrlSubmit');
  await sidebar.waitForTimeout(1200);

  const tabCount = await sidebar.textContent('#navTabCountBox');
  const browserVisible = await sidebar.locator('#viewBrowser').isVisible();
  const homeHidden = await sidebar.locator('#viewSiteList').isHidden();
  const iframeSrc = await sidebar.locator('#browserContent iframe').first().getAttribute('src');

  record('场景 1：立即新标签打开', tabCount === '1' && browserVisible && homeHidden, `标签数 = ${tabCount}，浏览视图可见 = ${browserVisible}`);
  record('场景 2：单视图切换（主页隐去）', homeHidden, `主页视图隐藏 = ${homeHidden}`);
  record('场景 3：iframe 载入目标地址', iframeSrc === `${FIXTURE_ORIGIN}/embeddable`, `iframe src = ${iframeSrc ?? 'null'}`);

  // iframe 真实渲染内容（夹具页 h1 文本）
  const frame = sidebar.frameLocator('#browserContent iframe').first();
  const heading = await frame.locator('h1').textContent().catch(() => null);
  record('场景 4：iframe 内真实渲染夹具页', heading === '可嵌入示例页', `h1 = ${heading ?? '未读到'}`);

  // 底栏后退：已完成一次导航（历史仅一条）时后退应不可用
  const backDisabled = await sidebar.locator('#navBack').isDisabled();
  record('场景 5：无可回退历史时后退键禁用', backDisabled, `disabled = ${backDisabled}`);

  await sidebar.screenshot({ path: path.join(OUT_DIR, '01-first-open.png') });

  // 回到主页确认条目已入列表
  await sidebar.click('#navHome');
  await sidebar.waitForTimeout(300);

  // 静态骨架里的图标必须被真实填充（占位 span 空着会让按钮变成无意义的色块）
  const brandIconPaths = await sidebar.locator('#brandLogo svg').count();
  const submitIconPaths = await sidebar.locator('#addUrlSubmit svg').count();
  const themeIconPaths = await sidebar.locator('#themeFlipButton svg').count();
  record(
    '场景 5b：静态骨架图标已填充',
    brandIconPaths === 1 && submitIconPaths === 1 && themeIconPaths === 1,
    `品牌/添加/主题图标数 = ${brandIconPaths}/${submitIconPaths}/${themeIconPaths}`,
  );

  const gridCount = await sidebar.locator('#siteGrid .site-item').count();
  const firstName = await sidebar.locator('#siteGrid .site-name').first().textContent();
  record('场景 6：网址已保存入网站列表', gridCount === 1, `网格条目数 = ${gridCount}`);
  record('场景 7：条目名称取自主机', firstName === '127.0.0.1', `名称 = ${firstName ?? 'null'}`);

  const tabsAfterHome = await sidebar.textContent('#navTabCountBox');
  record('场景 8：回主页不关闭标签', tabsAfterHome === '1', `标签数 = ${tabsAfterHome}`);

  // 从网站列表点击条目：应打开新标签并进入浏览视图
  await sidebar.locator('#siteGrid .site-item').first().click();
  await sidebar.waitForTimeout(1400);
  const tabsAfterSiteClick = await sidebar.textContent('#navTabCountBox');
  record('场景 9：点击网站条目打开新标签', tabsAfterSiteClick === '2', `标签数 = ${tabsAfterSiteClick}`);

  /**
   * Tier 1 追踪边界（research R3）的如实验证。
   *
   * 侧栏页没有目标站点 host 权限，无法读取跨源 iframe 的实际 URL，因此 iframe 内部的链接
   * 导航**不进入扩展历史栈**——后退键保持禁用是正确的保守行为，而不是「假装可用」。
   * 使这一栈增长的 Tier 2 content script 上报属 US4（T052–T059）。
   */
  const navFrame = sidebar.frameLocator('#browserContent .tab-host:not([hidden]) iframe').first();
  await navFrame.locator('a[href="/embeddable?step=2"]').click();
  await sidebar.waitForTimeout(1400);

  const backAfterFrameNav = await sidebar.locator('#navBack').isDisabled();
  record('场景 10：不可观测的 iframe 导航不伪造历史（后退保持禁用）', backAfterFrameNav, `后退键禁用 = ${backAfterFrameNav}`);

  const addressKept = await sidebar.textContent('#urlBarText');
  record('场景 11：地址栏沿用扩展已知地址（不猜测）', addressKept === `${FIXTURE_ORIGIN}/embeddable`, `地址栏 = ${addressKept ?? 'null'}`);
  await sidebar.screenshot({ path: path.join(OUT_DIR, '02-history-back.png') });

  // 底栏在浏览视图常驻且五键齐全
  const navKeys = await sidebar.locator('.bottom-nav button').count();
  record('场景 12：底栏五键在浏览视图常驻', navKeys === 5, `底栏按钮数 = ${navKeys}`);
}

/** 场景 2：非法地址被拒绝且不产生条目 */
async function runScenario2(sidebar: Page): Promise<void> {
  // 场景 1 末态是浏览视图（iframe 内刚导航过）：先截图存档再回主页
  await sidebar.screenshot({ path: path.join(OUT_DIR, '03-browser-after-nav.png') });
  await sidebar.click('#navHome');
  await sidebar.waitForTimeout(300);
  await sidebar.screenshot({ path: path.join(OUT_DIR, '04-site-list-home.png') });

  const beforeCount = await sidebar.locator('#siteGrid .site-item').count();
  const beforeTabs = await sidebar.textContent('#navTabCountBox');

  let index = 0;
  for (const invalid of ['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings']) {
    index += 1;
    await sidebar.fill('#addUrlInput', invalid);
    await sidebar.click('#addUrlSubmit');
    await sidebar.waitForTimeout(150);
    const errorVisible = await sidebar.locator('#addUrlError').isVisible();
    const errorText = await sidebar.textContent('#addUrlError');
    record(
      `场景 ${12 + index}：拒绝地址 ${invalid}`,
      errorVisible && (errorText ?? '').length > 0,
      `错误提示 = ${errorText ?? '无'}`,
    );
  }

  const afterCount = await sidebar.locator('#siteGrid .site-item').count();
  const afterTabs = await sidebar.textContent('#navTabCountBox');
  record(
    '场景 16：非法地址不产生条目与标签',
    beforeCount === afterCount && beforeTabs === afterTabs,
    `条目 ${beforeCount}→${afterCount}，标签 ${beforeTabs}→${afterTabs}`,
  );
}

/** 场景 3：多标签切换/关闭，重载后恢复未关闭标签 */
async function runScenario3(sidebar: Page, context: BrowserContext): Promise<void> {
  /**
   * 场景 1 结束时已有 2 个标签（添加的 1 个 + 点击条目又开的 1 个），这里再加 2 个 → 共 4 个。
   * 数量在注释中固化，避免用「读回来的值」当期望值而写出永真断言。
   */
  for (const target of [`${FIXTURE_ORIGIN}/spa`, `${FIXTURE_ORIGIN}/login`]) {
    await sidebar.waitForSelector('#addUrlInput', { state: 'visible' });
    await sidebar.fill('#addUrlInput', target);
    await sidebar.click('#addUrlSubmit');
    await sidebar.waitForTimeout(1000);
    // 每轮添加后回主页，才能继续在主页输入下一个地址
    await sidebar.click('#navHome');
    await sidebar.waitForTimeout(300);
  }

  const tabCountAfterAdd = await sidebar.textContent('#navTabCountBox');
  record('场景 17：多标签共存', tabCountAfterAdd === '4', `标签数 = ${tabCountAfterAdd}`);

  // 打开标签列表弹层（等待升起动画结束再截图，否则会拍到半途状态）
  await sidebar.click('#navTabCount');
  await sidebar.waitForSelector('.tablist-row');
  await sidebar.waitForTimeout(400);
  await sidebar.screenshot({ path: path.join(OUT_DIR, '05-tab-list-sheet.png') });

  const rows = sidebar.locator('.tablist-row');
  const rowCount = await rows.count();
  record('场景 18：标签列表列出全部标签', rowCount === 4, `列表行数 = ${rowCount}`);

  // 切到第一条（可嵌入页）；切换后弹层自动关闭
  await rows.first().click();
  await sidebar.waitForTimeout(900);
  const sheetClosedAfterActivate = await sidebar.locator('#sheet').isHidden();
  record('场景 18b：切换标签后弹层自动关闭', sheetClosedAfterActivate, `弹层已隐藏 = ${sheetClosedAfterActivate}`);

  const visibleSrc = await sidebar.locator('#browserContent .tab-host:not([hidden]) iframe').first().getAttribute('src');
  record('场景 19：切换标签显示对应 iframe', visibleSrc === `${FIXTURE_ORIGIN}/embeddable`, `可见 iframe src = ${visibleSrc ?? 'null'}`);

  // 重新打开弹层，记录将被关闭标签的 tabId（会话中不应再出现该 ID）
  await sidebar.click('#navTabCount');
  await sidebar.waitForSelector('.tablist-row');
  const closingTabId = await sidebar.locator('.tablist-row').first().getAttribute('data-tab-id');

  // 关闭当前（第一条）
  await sidebar.locator('.tablist-row').first().locator('.tablist-close').click();
  await sidebar.waitForTimeout(900);

  const tabCountAfterClose = await sidebar.textContent('#navTabCountBox');
  record('场景 20：关闭标签后计数减少', tabCountAfterClose === '3', `标签数 = ${tabCountAfterClose}`);

  // 关闭操作后弹层保持打开且列表已同步（无失效行）
  const closedStillInList = await sidebar.locator('.tablist-row[data-tab-id]').count().catch(() => 0);
  record('场景 21：标签列表同步移除已关闭项', closedStillInList === 3, `列表行数 = ${closedStillInList}`);

  const sheetStayedOpen = await sidebar.locator('#sheet').isVisible();
  record('场景 21b：关闭后弹层保持打开（可连续操作）', sheetStayedOpen, `弹层可见 = ${sheetStayedOpen}`);
  await sidebar.keyboard.press('Escape');
  await sidebar.waitForTimeout(450);
  const sheetClosed = await sidebar.locator('#sheet').isHidden();
  record('场景 21c：Esc 关闭弹层', sheetClosed, `弹层已隐藏 = ${sheetClosed}`);

  // 取当前可见 iframe 的 src 作为「重载前状态」
  const beforeReloadSrc = await sidebar
    .locator('#browserContent .tab-host:not([hidden]) iframe')
    .first()
    .getAttribute('src');
  await sidebar.screenshot({ path: path.join(OUT_DIR, '06-after-close.png') });

  // 侧栏重载 = 模拟扩展重开（同一存储）
  await sidebar.reload();
  await sidebar.waitForSelector('#navTabCountBox');
  await sidebar.waitForTimeout(1400);

  const tabCountAfterReload = await sidebar.textContent('#navTabCountBox');
  const restoredSrc = await sidebar
    .locator('#browserContent .tab-host:not([hidden]) iframe')
    .first()
    .getAttribute('src')
    .catch(() => null);

  record('场景 22：重载后恢复未关闭标签', tabCountAfterReload === '3', `标签数 = ${tabCountAfterReload}`);
  record('场景 24：恢复的标签载回原地址', restoredSrc === beforeReloadSrc, `恢复后 src = ${restoredSrc ?? 'null'}`);

  /**
   * 网站列表按**精确来源**归并（spec FR-005）：场景 1–3 共添加过 3 个不同路径
   * （/embeddable、/spa、/login），四者同属 `http://127.0.0.1:8919`，
   * 因此条目数为 1、入口数为 3 —— 这正是「同来源不同路径共存」的验证点。
   */
  const sitesRaw = await sidebar.evaluate(async () => {
    const data = await chrome.storage.local.get('sites:v1');
    return JSON.stringify(data['sites:v1'] ?? null);
  });
  const storedSites = (JSON.parse(sitesRaw) as { sites?: Array<{ entryPoints?: Array<{ url?: string }> }> } | null)?.sites ?? [];
  const entryUrls = storedSites.flatMap((site) => (site.entryPoints ?? []).map((entry) => entry.url ?? ''));
  record('场景 23：重载后网站列表键仍保留', storedSites.length === 1, `存储条目数 = ${storedSites.length}`);
  record(
    '场景 23a：同来源不同路径共存为入口',
    entryUrls.length === 3 && entryUrls.includes(`${FIXTURE_ORIGIN}/spa`) && entryUrls.includes(`${FIXTURE_ORIGIN}/login`),
    `入口 = ${entryUrls.join(', ')}`,
  );

  await sidebar.click('#navHome');
  await sidebar.waitForTimeout(500);
  const gridAfterReload = await sidebar.locator('#siteGrid .site-item').count();
  record('场景 23b：重载后主页渲染条目', gridAfterReload === 1, `网格条目数 = ${gridAfterReload}`);
  await sidebar.screenshot({ path: path.join(OUT_DIR, '07b-home-after-reload.png') });

  // 已关闭的标签不得出现在恢复后的会话里（按 tabId 断言，避免同 URL 干扰）
  const sessionRaw = await sidebar.evaluate(async () => {
    const data = await chrome.storage.local.get('session:v1');
    return JSON.stringify(data['session:v1'] ?? null);
  });
  const closedIdAbsent = closingTabId !== null && !sessionRaw.includes(closingTabId);
  record('场景 25：已关闭标签不在持久化会话中', closedIdAbsent, `会话含 ${closingTabId ?? 'null'} = ${!closedIdAbsent}`);

  // 会话持久化内容不得含页面内容/表单/密码/Cookie 值（spec FR-018/FR-033）
  const sensitiveAbsent =
    !sessionRaw.includes('password') && !sessionRaw.includes('formData') && !sessionRaw.includes('cookieValue');
  record('场景 25b：会话不含敏感数据字段', sensitiveAbsent, `含 password/formData/cookieValue = ${!sensitiveAbsent}`);

  await sidebar.screenshot({ path: path.join(OUT_DIR, '07-after-reload.png') });

  // 重载后仍可切换标签（底栏常驻，主页视图下也可打开标签列表）
  await sidebar.click('#navTabCount');
  await sidebar.waitForSelector('.tablist-row');
  const restoredRows = await sidebar.locator('.tablist-row').count();
  await sidebar.locator('.tablist-row').nth(1).click();
  await sidebar.waitForTimeout(900);
  const switchedSrc = await sidebar.locator('#browserContent .tab-host:not([hidden]) iframe').first().getAttribute('src');
  record(
    '场景 26：重载后仍可切换标签',
    restoredRows === 3 && switchedSrc !== null,
    `列表行数 = ${restoredRows}，切换后可见 src = ${switchedSrc ?? 'null'}`,
  );

  // 全部关闭 → 回主页：一次打开弹层后连续关闭（弹层在关闭标签后原地刷新，最后关闭时自动收起）
  await sidebar.click('#navTabCount');
  await sidebar.waitForSelector('.tablist-row');
  for (let round = 0; round < 3; round += 1) {
    await sidebar.locator('.tablist-row').first().locator('.tablist-close').click();
    await sidebar.waitForTimeout(900);
  }
  await sidebar.waitForTimeout(900);
  const homeVisible = await sidebar.locator('#viewSiteList').isVisible();
  const finalTabCount = await sidebar.textContent('#navTabCountBox');
  record('场景 27：全部关闭回到网站列表主页', homeVisible && finalTabCount === '0', `主页可见 = ${homeVisible}，标签数 = ${finalTabCount}`);
  await sidebar.screenshot({ path: path.join(OUT_DIR, '08-all-closed-home.png') });

  // 主题翻转（深浅）冒烟：md 基线要求即时切换
  const themeBefore = await sidebar.getAttribute('html', 'data-theme');
  await sidebar.click('#themeFlipButton');
  await sidebar.waitForTimeout(200);
  const themeAfter = await sidebar.getAttribute('html', 'data-theme');
  record('场景 28：深浅主题翻转即时生效', themeBefore !== themeAfter, `${themeBefore} → ${themeAfter}`);
  await sidebar.screenshot({ path: path.join(OUT_DIR, '09-theme-flipped.png') });

  // 弹层内的主题入口（九宫格「夜间模式」）与顶栏翻转一致
  await sidebar.click('#navMenu');
  await sidebar.waitForSelector('.menu-cell');
  const menuCellCount = await sidebar.locator('.menu-cell').count();
  record('场景 28b：九宫格菜单保持 2×5 形状', menuCellCount === 10, `格子数 = ${menuCellCount}`);
  await sidebar.waitForTimeout(400);
  await sidebar.screenshot({ path: path.join(OUT_DIR, '10-grid-menu-sheet.png') });

  void context;
}

/** 写控制台报告 */
async function writeConsoleReport(): Promise<void> {
  const path_ = path.join(OUT_DIR, 'console.log');
  const lines = consoleMessages.map((entry) => `[${entry.level}] (${entry.where}) ${entry.text}`);
  await writeFile(path_, lines.length === 0 ? '(无 error/warning)\n' : `${lines.join('\n')}\n`, 'utf8');
  record('场景 29：控制台零 error / 零 warning', consoleMessages.length === 0, `共 ${consoleMessages.length} 条`);
}

/** 输出汇总并设置退出码 */
async function finish(): Promise<void> {
  const failed = results.filter((entry) => !entry.passed);
  const reportPath = path.join(OUT_DIR, 'report.json');
  await writeFile(reportPath, `${JSON.stringify({ results, consoleMessages }, null, 2)}\n`, 'utf8');

  console.log(`\n=== T029 结果：${results.length - failed.length}/${results.length} 通过 ===`);
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
  console.error('T029 验证脚本异常：', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
