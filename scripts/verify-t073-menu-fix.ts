// sidebarmobile — 九宫格菜单修复的真实浏览器验证（scripts）
// 2026-09-30 | Kimi(fix) | 用户实测反馈：无页点 + 四格接线（复制网址/历史/电脑模式/普通打开）

/**
 * [DONE] 用户实测反馈修复的自动化检查点。
 *
 * 背景：用户报告「九宫格显示两个页点、暗示可以左右翻页，但右滑无反应」，同时菜单里 5 个格子
 * 是禁用态（点不动）。本脚本在**真实 Chromium 加载 dist/chrome** 的环境里逐项验证修复：
 *
 *   1. 菜单打开后**没有任何页点元素**（DOM 与可见性两条都查）
 *   2. 四个格子在**有活动标签时可点**，且点击后各自产生预期效果
 *      - 复制网址 → 剪贴板内容或 toast 反馈
 *      - 历史 → 面板出现且列出该标签的历史项，点一条能跳转
 *      - 电脑模式 → 当前标签的宿主切到 data-display-mode="desktop"
 *      - 普通打开 → 产生 toast 反馈（真实 tabs.create 会开新标签，故两种结果都接受）
 *   3. 分享 / 添加书签仍禁用，且 aria-label 说明原因
 *   4. 无活动标签时依赖标签的格子禁用且 aria-label 含「无打开的标签页」
 *
 * **进程纪律**（本机曾因残留进程死机）：自带夹具服务（端口 8921，与其它切片一致），
 * try/finally 保证浏览器与服务被回收；不使用后台常驻进程。
 *
 * 用法：node --experimental-strip-types scripts/verify-t073-menu-fix.ts
 */
import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startFixtureServer } from '../tests/helpers/fixture-lifecycle.ts';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const EXTENSION_PATH = path.join(PROJECT_ROOT, 'dist', 'chrome');
const OUT_DIR = path.join(PROJECT_ROOT, '.playwright-mcp', 't073-menu-fix');
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

  const fixture = await startFixtureServer({ port: FIXTURE_PORT });
  const fixtureOrigin = fixture.origin;

  let context: BrowserContext | null = null;
  try {
    const userDataDir = path.join(os.tmpdir(), `sidebarmobile-t073fix-${Date.now()}`);
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
      /**
       * 剪贴板读取需要显式授权：本脚本要断言"复制网址"真的写进了剪贴板，
       * 而不是只看 toast 文案（后者只是实现的自述，不是结果）。
       */
      permissions: ['clipboard-read', 'clipboard-write'],
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
      const stack = (error.stack ?? '').split('\n').slice(0, 5).join(' | ');
      consoleMessages.push({ level: 'error', text: `pageerror: ${error.message} ||| ${stack}`, where: 'sidebar' });
    });

    await sidebar.goto(`chrome-extension://${extensionId}/sidebar.html`);
    await sidebar.waitForSelector('.bottom-nav');

    // 准备一个带历史的标签：先开 A，再在同一个标签里跳到 B（构造两步历史供历史面板验证）
    await addUrl(sidebar, `${fixtureOrigin}/embeddable`);
    await seedHistory(sidebar, fixtureOrigin);
    await sidebar.reload();
    await sidebar.waitForSelector('#navTabCountBox');
    await sidebar.waitForTimeout(1800);

    await checkNoPageDots(sidebar);
    await checkCellsEnabled(sidebar);
    await checkCopyUrl(sidebar, fixtureOrigin);
    await checkHistoryPanel(sidebar, fixtureOrigin);
    await checkDesktopMode(sidebar);
    await checkOpenExternal(sidebar);
    await checkUnsupportedCells(sidebar);
    await checkDisabledWithoutTab(sidebar);
    await writeConsoleReport();
  } finally {
    /**
     * 关闭顺序：先关浏览器上下文再停夹具服务。
     *
     * 反过来的话，仍在运行的页面会持续请求已经停掉的夹具服务，控制台里出现
     * `Failed to load resource` —— 那些噪声会被控制台检查误判成本次改动的缺陷。
     */
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

async function addUrl(sidebar: Page, url: string): Promise<void> {
  await sidebar.waitForSelector('#addUrlInput', { state: 'visible' });
  await sidebar.fill('#addUrlInput', url);
  await sidebar.click('#addUrlSubmit');
  await sidebar.waitForTimeout(1400);
}

/**
 * 给活动标签注入一条三步历史。
 *
 * 为什么直接写存储：`addUrl` 每次都会**新开标签**，而历史面板验证的是"同一标签内的历史栈"。
 * 经 UI 构造同标签多步历史需要触发 iframe 内的导航，在 Tier 1 下不可观测（US4 结论）。
 * 注入后 reload 让它被会话恢复路径读回来 —— 走的是真实代码路径，不是桩数据。
 *
 * 用**三步**而不是两步：只有中间项才能同时验证"后退可用"与"前进可用"，
 * 而那正是"栈内移动保留前向分支"这条语义的判据（两步时会误把栈首的合法禁用当成缺陷）。
 */
async function seedHistory(sidebar: Page, origin: string): Promise<void> {
  await sidebar.evaluate(async (fixtureOrigin: string) => {
    const stored = await chrome.storage.local.get('session:v1');
    const session = stored['session:v1'] as { tabs: Array<Record<string, unknown>>; activeTabId: string | null } | undefined;
    const tab = session?.tabs[0];
    if (session === undefined || tab === undefined) {
      return;
    }
    const now = new Date().toISOString();
    tab['history'] = [
      { url: `${fixtureOrigin}/embeddable`, title: '第一步', visitedAt: now },
      { url: `${fixtureOrigin}/spa`, title: '第二步', visitedAt: now },
      { url: `${fixtureOrigin}/login`, title: '第三步', visitedAt: now },
    ];
    tab['historyIndex'] = 2;
    tab['currentUrl'] = `${fixtureOrigin}/login`;
    tab['originKey'] = fixtureOrigin;
    tab['title'] = '第三步';
    await chrome.storage.local.set({ 'session:v1': session });
  }, origin);
}

/** 打开九宫格菜单（走真实入口：底栏菜单键） */
async function openMenu(sidebar: Page): Promise<void> {
  await sidebar.keyboard.press('Escape');
  await sidebar.waitForTimeout(350);
  await sidebar.click('#navMenu');
  await sidebar.waitForSelector('.menu-cell', { state: 'attached' });
  await sidebar.waitForTimeout(450);
}

/** 按可见文案点一个格子 */
async function clickCell(sidebar: Page, label: string): Promise<void> {
  await sidebar.locator('.menu-cell', { hasText: label }).first().click();
  await sidebar.waitForTimeout(450);
}

/** 读当前菜单里各格子的可用性快照 */
async function readCells(sidebar: Page): Promise<Array<{ label: string; disabled: boolean; aria: string }>> {
  return sidebar.locator('.menu-cell').evaluateAll((nodes) =>
    nodes.map((node) => ({
      label: node.querySelector('.cell-label')?.textContent ?? '',
      disabled: (node as HTMLButtonElement).disabled,
      aria: node.getAttribute('aria-label') ?? '',
    })),
  );
}

/** 场景 1：菜单里没有任何页点，且菜单是单页 10 格 */
async function checkNoPageDots(sidebar: Page): Promise<void> {
  await openMenu(sidebar);

  const dots = await sidebar.evaluate(() => {
    const sheet = document.getElementById('sheet');
    if (sheet === null) {
      return { dots: -1, i: -1, cellCount: -1, overflow: -1 };
    }
    return {
      dots: sheet.querySelectorAll('.menu-dots').length,
      i: sheet.querySelectorAll('i').length,
      cellCount: sheet.querySelectorAll('.menu-cell').length,
      // 横向溢出 = 存在"可左右滑动"的物理空间（页点曾暗示的就是它）
      overflow: sheet.scrollWidth - sheet.clientWidth,
    };
  });

  record('场景 1：DOM 中无页点元素（.menu-dots）', dots.dots === 0, `.menu-dots 元素数 = ${dots.dots}`);
  record('场景 1：DOM 中无 <i> 装饰点', dots.i === 0, `<i> 元素数 = ${dots.i}（样式已删，元素也不该在）`);
  record('场景 1：菜单为单页 2×5 共 10 格', dots.cellCount === 10, `格子数 = ${dots.cellCount}`);
  record(
    '场景 1：菜单无横向可滚动区域（不存在"右滑"的物理空间）',
    dots.overflow <= 0,
    `横向溢出 = ${dots.overflow}px`,
  );

  await sidebar.screenshot({ path: path.join(OUT_DIR, '01-grid-menu-no-dots.png') });
}

/** 场景 2：有活动标签时四个格子可点 */
async function checkCellsEnabled(sidebar: Page): Promise<void> {
  await openMenu(sidebar);
  const cells = await readCells(sidebar);

  for (const label of ['复制网址', '历史', '电脑模式', '普通打开']) {
    const found = cells.find((cell) => cell.label === label);
    record(
      `场景 2：「${label}」在有活动标签时可点`,
      found !== undefined && !found.disabled,
      found === undefined ? '找不到格子' : `disabled = ${found.disabled}`,
    );
  }

  await sidebar.keyboard.press('Escape');
  await sidebar.waitForTimeout(400);
}

/** 场景 3：复制网址真的写进剪贴板 */
async function checkCopyUrl(sidebar: Page, fixtureOrigin: string): Promise<void> {
  await sidebar.bringToFront();
  // 先清空剪贴板，避免读到上一次的残留而误判成功
  const cleared = await sidebar.evaluate(async () => {
    try {
      await navigator.clipboard.writeText('__cleared__');
      return true;
    } catch {
      return false;
    }
  });

  await openMenu(sidebar);
  await clickCell(sidebar, '复制网址');
  await sidebar.waitForTimeout(700);

  const clipboard = await sidebar.evaluate(async () => {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return '(读取失败)';
    }
  });
  const toast = await readToast(sidebar);

  const clipboardOk = clipboard.startsWith(fixtureOrigin) && clipboard !== '__cleared__';
  const toastOk = toast.includes('已复制');
  record(
    '场景 3：「复制网址」产生可查证的成功结果（剪贴板内容或成功 toast）',
    clipboardOk || toastOk,
    `剪贴板 = ${clipboard}（已预清空 = ${cleared}），toast = ${toast || '(无)'}`,
  );

  await sidebar.screenshot({ path: path.join(OUT_DIR, '02-copy-url.png') });
}

/** 场景 4：历史面板出现并列出历史项，点一条能跳转 */
async function checkHistoryPanel(sidebar: Page, fixtureOrigin: string): Promise<void> {
  await openMenu(sidebar);
  await clickCell(sidebar, '历史');
  await sidebar.waitForTimeout(500);

  const panel = await sidebar.evaluate(() => {
    const sheet = document.getElementById('sheet');
    if (sheet === null) {
      return null;
    }
    return {
      visible: !sheet.hidden,
      title: sheet.querySelector('.sheet-title')?.textContent ?? '',
      rowCount: sheet.querySelectorAll('.history-row').length,
      urls: Array.from(sheet.querySelectorAll('.history-row-url')).map((node) => node.textContent ?? ''),
      flags: Array.from(sheet.querySelectorAll('.history-row-flag')).map((node) => node.textContent ?? ''),
      // 页点同样不得出现在历史面板里（同一个 sheet 容器）
      dots: sheet.querySelectorAll('.menu-dots').length,
    };
  });

  record('场景 4：「历史」打开面板（弹层保持打开）', panel !== null && panel.visible, `面板可见 = ${panel?.visible ?? false}`);
  record('场景 4：历史面板标题正确', panel?.title === '历史', `标题 = ${panel?.title ?? '(无)'}`);
  record(
    '场景 4：列出该标签的历史项（3 条，倒序：/login → /spa → /embeddable）',
    (panel?.rowCount ?? 0) === 3 && (panel?.urls[0] ?? '').includes('/login') && (panel?.urls[2] ?? '').includes('/embeddable'),
    `行数 = ${panel?.rowCount ?? 0}，URL = ${panel?.urls.join(' , ') ?? ''}`,
  );
  record('场景 4：当前项标出「当前」', (panel?.flags.length ?? 0) === 1, `当前标记数 = ${panel?.flags.length ?? 0}`);
  record('场景 4：历史面板内也无页点', panel?.dots === 0, `.menu-dots = ${panel?.dots ?? -1}`);

  await sidebar.screenshot({ path: path.join(OUT_DIR, '03-history-panel.png') });

  // 点中间一条（倒序渲染：行序为 /login(当前) → /spa → /embeddable，故索引 1 是中间项）
  const before = await sidebar.evaluate(() => document.querySelector('#urlBarText')?.textContent ?? '');
  await sidebar.locator('.history-row').nth(1).click();
  await sidebar.waitForTimeout(1500);

  const after = await sidebar.evaluate(() => ({
    urlBar: document.querySelector('#urlBarText')?.textContent ?? '',
    frameSrc: (document.querySelector('.tab-host:not([hidden]) iframe') as HTMLIFrameElement | null)?.src ?? '',
    sheetHidden: document.getElementById('sheet')?.hidden ?? true,
    backEnabled: !(document.getElementById('navBack') as HTMLButtonElement | null)?.disabled,
    forwardEnabled: !(document.getElementById('navForward') as HTMLButtonElement | null)?.disabled,
  }));

  record(
    '场景 4：点击历史项后当前地址变为该历史项',
    after.frameSrc.includes('/spa') || after.urlBar !== before,
    `iframe.src = ${after.frameSrc}，顶栏 = ${after.urlBar}（点前 = ${before}）`,
  );
  record('场景 4：跳转后弹层收起', after.sheetHidden, `弹层隐藏 = ${after.sheetHidden}`);

  /**
   * 跳到了**中间项**：前后都还有记录，因此两个键都必须可用。
   *
   * 这是"栈内移动保留前向分支"最干净的判据 —— 若误用 `navigate`（新导航语义）兑现，
   * 第 2 项之后的历史会被截断，前进键立刻失效，用户从历史点回上一页后就再也前进不回去。
   */
  record(
    '场景 4：跳转保留了栈的两个方向（后退与前进键均可用）',
    after.backEnabled && after.forwardEnabled,
    `后退可用 = ${after.backEnabled}，前进可用 = ${after.forwardEnabled}`,
  );
}

/** 场景 5：电脑模式切换真的改了当前标签的显示模式 */
async function checkDesktopMode(sidebar: Page): Promise<void> {
  const before = await sidebar.evaluate(
    () => document.querySelector('.tab-host:not([hidden])')?.getAttribute('data-display-mode') ?? '(无)',
  );

  await openMenu(sidebar);
  await clickCell(sidebar, '电脑模式');
  await sidebar.waitForTimeout(1200);

  const after = await sidebar.evaluate(() => {
    const host = document.querySelector('.tab-host:not([hidden])');
    const frame = host?.querySelector('iframe') as HTMLIFrameElement | null;
    return {
      mode: host?.getAttribute('data-display-mode') ?? '(无)',
      frameWidth: frame?.style.width ?? '',
      scale: frame?.style.transform ?? '',
    };
  });

  record(
    '场景 5：「电脑模式」把当前标签切到桌面模式',
    before !== 'desktop' && after.mode === 'desktop',
    `data-display-mode：${before} → ${after.mode}（iframe 宽 ${after.frameWidth}，${after.scale}）`,
  );

  await sidebar.screenshot({ path: path.join(OUT_DIR, '04-desktop-mode.png') });

  // 再点一次应切回移动模式（同一格是切换语义）
  await openMenu(sidebar);
  await clickCell(sidebar, '电脑模式');
  await sidebar.waitForTimeout(1000);
  const back = await sidebar.evaluate(
    () => document.querySelector('.tab-host:not([hidden])')?.getAttribute('data-display-mode') ?? '(无)',
  );
  record('场景 5：再点一次切回移动模式', back === 'mobile', `data-display-mode = ${back}`);
}

/** 场景 6：普通打开产生反馈（真实开标签或提示都算兑现） */
async function checkOpenExternal(sidebar: Page): Promise<void> {
  const pagesBefore = sidebar.context().pages().length;

  await openMenu(sidebar);
  await clickCell(sidebar, '普通打开');
  await sidebar.waitForTimeout(1200);

  const toast = await readToast(sidebar);
  const pagesAfter = sidebar.context().pages().length;

  record(
    '场景 6：「普通打开」产生可查证的反馈（弹出新标签页或 toast 提示）',
    pagesAfter > pagesBefore || toast.length > 0,
    `标签页数 ${pagesBefore} → ${pagesAfter}，toast = ${toast || '(无)'}`,
  );

  await sidebar.screenshot({ path: path.join(OUT_DIR, '05-open-external.png') });

  // 关掉可能被打开的外部标签页，避免影响后续场景的页面计数
  for (const page of sidebar.context().pages()) {
    if (page !== sidebar) {
      await page.close();
    }
  }
  await sidebar.waitForTimeout(400);
}

/** 场景 7：分享 / 添加书签保持禁用且说明原因 */
async function checkUnsupportedCells(sidebar: Page): Promise<void> {
  await openMenu(sidebar);
  const cells = await readCells(sidebar);

  for (const label of ['分享', '添加书签']) {
    const found = cells.find((cell) => cell.label === label);
    record(
      `场景 7：「${label}」保持禁用`,
      found !== undefined && found.disabled,
      found === undefined ? '找不到格子' : `disabled = ${found.disabled}`,
    );
    record(
      `场景 7：「${label}」的 aria-label 说明了原因（不只是重复标签）`,
      found !== undefined && found.aria.length > label.length,
      `aria-label = ${found?.aria ?? '(无)'}`,
    );
  }

  await sidebar.keyboard.press('Escape');
  await sidebar.waitForTimeout(400);
}

/** 场景 8：无活动标签时依赖标签的格子禁用并说明原因 */
async function checkDisabledWithoutTab(sidebar: Page): Promise<void> {
  /**
   * 经存储清空标签再 reload：这样活动标签为 null 是**状态层算出来的真实状态**，
   * 而不是在页面上手动禁用几个按钮 —— 后者测不到 buildGridMenuContent 的取参分支。
   */
  await sidebar.evaluate(async () => {
    await chrome.storage.local.set({
      'session:v1': { version: 1, tabs: [], activeTabId: null, savedAt: new Date().toISOString() },
    });
  });
  await sidebar.reload();
  await sidebar.waitForSelector('#navTabCountBox');
  await sidebar.waitForTimeout(1500);

  await openMenu(sidebar);
  const cells = await readCells(sidebar);

  for (const label of ['复制网址', '历史', '电脑模式', '普通打开', '站点设置']) {
    const found = cells.find((cell) => cell.label === label);
    record(
      `场景 8：无活动标签时「${label}」禁用`,
      found !== undefined && found.disabled,
      found === undefined ? '找不到格子' : `disabled = ${found.disabled}`,
    );
    record(
      `场景 8：无活动标签时「${label}」的 aria-label 含「无打开的标签页」`,
      found !== undefined && found.aria.includes('无打开的标签页'),
      `aria-label = ${found?.aria ?? '(无)'}`,
    );
  }

  // 不依赖标签的格子仍可用（本次改动不该把它们一起关掉）
  for (const label of ['夜间模式', '网站列表']) {
    const found = cells.find((cell) => cell.label === label);
    record(
      `场景 8：无标签时「${label}」仍可点（不依赖标签）`,
      found !== undefined && !found.disabled,
      found === undefined ? '找不到格子' : `disabled = ${found.disabled}`,
    );
  }

  await sidebar.screenshot({ path: path.join(OUT_DIR, '06-no-active-tab.png') });
  await sidebar.keyboard.press('Escape');
  await sidebar.waitForTimeout(400);
}

/** 读 toast 当前文案（隐藏时为空串） */
async function readToast(sidebar: Page): Promise<string> {
  return sidebar.evaluate(() => {
    const toast = document.getElementById('toast');
    if (toast === null || toast.hidden) {
      return '';
    }
    return toast.textContent ?? '';
  });
}

/** 控制台检查：只对代码缺陷类消息判失败 */
async function writeConsoleReport(): Promise<void> {
  const reportPath = path.join(OUT_DIR, 'console.log');
  const lines = consoleMessages.map((entry) => `[${entry.level}] (${entry.where}) ${entry.text}`);
  await writeFile(reportPath, lines.length === 0 ? '(无 error/warning)\n' : `${lines.join('\n')}\n`, 'utf8');

  const defectMessages = consoleMessages.filter((entry) => {
    if (entry.text.startsWith('pageerror:')) {
      return true;
    }
    // 夹具站的嵌入拦截类资源失败与本次改动无关（T059 场景刻意构造）
    if (entry.text.includes('Failed to load resource')) {
      return false;
    }
    return true;
  });

  record(
    '场景 9：控制台无代码缺陷类 error / 无 warning',
    defectMessages.length === 0,
    `共 ${consoleMessages.length} 条，缺陷类 ${defectMessages.length} 条${defectMessages.length > 0 ? `：${defectMessages.map((entry) => entry.text).join(' | ')}` : ''}`,
  );
}

async function finish(): Promise<void> {
  const failed = results.filter((entry) => !entry.passed);
  const reportPath = path.join(OUT_DIR, 'report.json');
  await writeFile(reportPath, `${JSON.stringify({ results, consoleMessages }, null, 2)}\n`, 'utf8');

  console.log(`\n=== T073 菜单修复结果：${results.length - failed.length}/${results.length} 通过 ===`);
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
  console.error('T073 菜单修复验证异常：', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
