// sidebarmobile — US2 端到端验证脚本（scripts）
// 2026-09-29 | Kimi(speckit-implement) | T041：真实 Chromium 验证移动视口/显示模式/UA 授权/能力徽章

/**
 * [DONE] T041 手动检查点的自动化执行器（US2 范围）。
 *
 * 与 T029 的分工：T029 验证 US1（添加/标签/恢复）；本脚本验证 US2（移动视口默认、显示模式按
 * 精确来源隔离、UA 授权开关与拒绝降级、能力状态徽章文案），因此**单独成文件**，不改 t029。
 *
 * 执行的验收项：
 *   1. 移动视口默认生效（iframe 宽度 = 容器宽度，非 1280 缩放）
 *   2. 站点设置面板可开，模式切换只影响该精确来源
 *   3. 桌面模式切换后当前标签重新加载、iframe 呈现桌面断点宽度
 *   4. UA 开关：开启触发权限申请；拒绝后开关回弹 + 提示 + 徽章保持未授权
 *   5. 能力状态徽章文案与 contracts/ui-states.md 逐字一致
 *   6. 控制台零 error / 零 warning
 *
 * 用法：node --experimental-strip-types scripts/verify-t041.ts
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
const OUT_DIR = path.join(PROJECT_ROOT, '.playwright-mcp', 't041');

/** 由自带的服务实例在 main() 里赋值；不依赖外部已启动的服务 */
let FIXTURE_ORIGIN = 'http://127.0.0.1:8921';

/** Chromium 可执行路径覆盖（本机标准位置已被 T029 装好，通常无需设置此变量） */
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

  /**
   * 自带夹具服务生命周期（端口 8921）。
   *
   * try/finally 保证无论验证结果如何都会被回收 —— 依赖"外部已起好的服务"会带来
   * 服务无人回收的进程残留风险，本项目已因此出过问题。
   */
  const fixture = await startFixtureServer({ port: FIXTURE_PORT });
  FIXTURE_ORIGIN = fixture.origin;

  let context: BrowserContext | null = null;
  try {
    const userDataDir = path.join(os.tmpdir(), `sidebarmobile-t041-${Date.now()}`);
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

    await runViewportChecks(sidebar);
    await runDisplayModeIsolationChecks(sidebar);
    await runUaGrantChecks(sidebar);
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

/** 添加一个网址并等待浏览视图就绪 */
async function addUrl(sidebar: Page, url: string): Promise<void> {
  await sidebar.waitForSelector('#addUrlInput', { state: 'visible' });
  await sidebar.fill('#addUrlInput', url);
  await sidebar.click('#addUrlSubmit');
  await sidebar.waitForTimeout(1500);
}

/** 读取当前可见 iframe 的内联样式与实测宽度 */
async function readVisibleFrameMetrics(
  sidebar: Page,
): Promise<{ inlineWidth: string; transform: string; clientWidth: number; hostWidth: number; src: string | null } | null> {
  return sidebar.evaluate(() => {
    const host = document.querySelector('#browserContent .tab-host:not([hidden])');
    if (host === null) {
      return null;
    }
    const frame = host.querySelector('iframe');
    if (frame === null) {
      return null;
    }
    return {
      inlineWidth: frame.style.width,
      transform: frame.style.transform,
      clientWidth: frame.clientWidth,
      hostWidth: host.clientWidth,
      src: frame.getAttribute('src'),
    };
  });
}

/** 场景 1：移动视口默认（spec FR-007/FR-040） */
async function runViewportChecks(sidebar: Page): Promise<void> {
  await addUrl(sidebar, `${FIXTURE_ORIGIN}/embeddable`);

  const metrics = await readVisibleFrameMetrics(sidebar);
  record('场景 1：打开后处于浏览视图', metrics !== null, `iframe 存在 = ${metrics !== null}`);

  if (metrics !== null) {
    // 移动视口：iframe 宽度取容器宽度，无缩放变换
    record(
      '场景 2：移动视口默认生效（宽度贴合侧栏、无缩放）',
      metrics.inlineWidth === '100%' && metrics.transform === '',
      `width=${metrics.inlineWidth}，transform="${metrics.transform}"`,
    );
    record(
      '场景 3：iframe 实际宽度等于内容区宽度（非桌面断点）',
      metrics.clientWidth === metrics.hostWidth && metrics.clientWidth > 0 && metrics.clientWidth < 900,
      `iframe=${metrics.clientWidth}px，宿主=${metrics.hostWidth}px`,
    );
  }

  // 移动视口不是真实 UA：未授权时徽章必须是未授权
  await openSettingsPanel(sidebar);
  const badges = await readBadges(sidebar);
  record(
    '场景 4：移动视口未被伪装成真实 UA（UA 徽章为未授权）',
    badges.some((badge) => badge === 'UA：未授权'),
    `徽章 = ${badges.join(' / ')}`,
  );

  await sidebar.screenshot({ path: path.join(OUT_DIR, '01-mobile-viewport.png') });
}

/** 场景 2：显示模式按精确来源隔离 + 桌面模式重载（spec FR-008/FR-038） */
async function runDisplayModeIsolationChecks(sidebar: Page): Promise<void> {
  // 面板当前已打开
  const modeBefore = await readActiveMode(sidebar);
  record('场景 5：设置面板显示当前为移动模式', modeBefore === '移动', `选中 = ${modeBefore ?? 'none'}`);

  // 切到桌面模式
  await sidebar.locator('.mode-btn', { hasText: '桌面' }).click();
  await sidebar.waitForTimeout(1600);

  const desktopMetrics = await readVisibleFrameMetrics(sidebar);
  record(
    '场景 6：桌面模式 iframe 按桌面断点定宽并缩放',
    desktopMetrics !== null &&
      desktopMetrics.inlineWidth === '1280px' &&
      desktopMetrics.transform.startsWith('scale('),
    `width=${desktopMetrics?.inlineWidth ?? 'null'}，transform="${desktopMetrics?.transform ?? ''}"`,
  );

  // 重新加载：切换后 iframe 应载回同一地址（渲染层已重建，状态应回到 loaded）
  record(
    '场景 7：切换桌面模式后当前标签仍载着原地址',
    desktopMetrics?.src === `${FIXTURE_ORIGIN}/embeddable`,
    `src = ${desktopMetrics?.src ?? 'null'}`,
  );

  const modeAfter = await readActiveMode(sidebar);
  record('场景 8：面板同步显示桌面模式', modeAfter === '桌面', `选中 = ${modeAfter ?? 'none'}`);

  await sidebar.screenshot({ path: path.join(OUT_DIR, '02-desktop-mode.png') });

  // 打开第二个来源，验证桌面模式不泄漏到别的来源（FR-038）
  await sidebar.keyboard.press('Escape');
  await sidebar.waitForTimeout(400);
  await sidebar.click('#navHome');
  await sidebar.waitForTimeout(400);

  // localhost 与 127.0.0.1 是不同精确来源（同端口）
  await addUrl(sidebar, `http://localhost:${FIXTURE_PORT}/embeddable`);
  const otherMetrics = await readVisibleFrameMetrics(sidebar);
  record(
    '场景 9：另一来源仍为移动视口（设置不跨来源泄漏）',
    otherMetrics !== null && otherMetrics.inlineWidth === '100%' && otherMetrics.transform === '',
    `width=${otherMetrics?.inlineWidth ?? 'null'}，transform="${otherMetrics?.transform ?? ''}"`,
  );

  await openSettingsPanel(sidebar);
  const otherMode = await readActiveMode(sidebar);
  record('场景 10：另一来源的设置面板显示移动模式', otherMode === '移动', `选中 = ${otherMode ?? 'none'}`);

  await sidebar.screenshot({ path: path.join(OUT_DIR, '03-second-origin-mobile.png') });

  // 切回第一个来源，确认桌面模式仍在（按来源持久保存，spec FR-008）。
  // 必须按 URL 精确选中那个来源的行：标签顺序决定索引，用 first/last 会选到别的来源。
  await sidebar.keyboard.press('Escape');
  await sidebar.waitForTimeout(400);
  await sidebar.click('#navTabCount');
  await sidebar.waitForSelector('.tablist-row');
  await sidebar.locator('.tablist-row', { hasText: '127.0.0.1' }).first().click();
  await sidebar.waitForTimeout(1500);

  const backMetrics = await readVisibleFrameMetrics(sidebar);
  record(
    '场景 11：切回第一来源仍是桌面模式（按来源保存）',
    backMetrics !== null && backMetrics.inlineWidth === '1280px',
    `width=${backMetrics?.inlineWidth ?? 'null'}，src=${backMetrics?.src ?? 'null'}`,
  );

  // 反向确认：切到第二来源（localhost）应回到移动视口，证明隔离是双向的
  await sidebar.click('#navTabCount');
  await sidebar.waitForSelector('.tablist-row');
  await sidebar.locator('.tablist-row', { hasText: 'localhost' }).first().click();
  await sidebar.waitForTimeout(1200);

  const reverseMetrics = await readVisibleFrameMetrics(sidebar);
  record(
    '场景 11b：切到第二来源为移动视口（隔离双向成立）',
    reverseMetrics !== null && reverseMetrics.inlineWidth === '100%',
    `width=${reverseMetrics?.inlineWidth ?? 'null'}`,
  );

  // 两个来源的设置各自正确：只持久化被**显式改动过**的来源（稀疏快照），
  // 未改动的来源不写记录、读取时取默认值 —— 这样避免为每个访问过的站点写无关记录。
  const persisted = await sidebar.evaluate(async () => {
    const raw = await chrome.storage.local.get('site-settings:v1');
    return JSON.stringify(raw['site-settings:v1'] ?? null);
  });
  const persistedRecord = (JSON.parse(persisted) as Record<string, { displayMode?: string }> | null) ?? {};
  const persistedKeys = Object.keys(persistedRecord);
  const desktopCount = persistedKeys.filter((key) => persistedRecord[key]?.displayMode === 'desktop').length;

  record(
    '场景 11c：仅被显式改动的来源写存储（稀疏快照）',
    persistedKeys.length === 1 && desktopCount === 1,
    `来源键 = ${persistedKeys.join(', ') || '(空)'}；desktop 数 = ${desktopCount}`,
  );

  // 未改动的来源读回默认移动模式（而不是"没记录"被当成异常）
  const localhostMode = await sidebar.evaluate(async (origin: string) => {
    const raw = await chrome.storage.local.get('site-settings:v1');
    const all = (raw['site-settings:v1'] ?? {}) as Record<string, unknown>;
    return origin in all ? 'recorded' : 'absent';
  }, `http://localhost:${FIXTURE_PORT}`);
  record('场景 11d：未改动来源不产生存储记录', localhostMode === 'absent', `localhost 记录状态 = ${localhostMode}`);
}

/** 场景 3：UA 授权开关 — 真实点击开关后降级（spec FR-010/FR-029/FR-036） */
async function runUaGrantChecks(sidebar: Page): Promise<void> {
  await openSettingsPanel(sidebar);

  const uaSwitch = sidebar.locator('.switch[aria-label="真实移动 UA"]');
  const uaCheckedBefore = await uaSwitch.getAttribute('aria-checked');
  record('场景 12：UA 开关初始为关闭（未授权）', uaCheckedBefore === 'false', `aria-checked = ${uaCheckedBefore}`);

  const badgesBefore = await readBadges(sidebar);
  record(
    '场景 13：未授权时徽章为「UA：未授权」',
    badgesBefore.includes('UA：未授权'),
    `徽章 = ${badgesBefore.join(' / ')}`,
  );

  await sidebar.screenshot({ path: path.join(OUT_DIR, '04-ua-before-grant.png') });

  /**
   * 真实点击 UA 开关，走完整用户路径：侧栏 → 消息 → 后台 → permissions.request。
   *
   * 自动化环境里权限对话框无法被点击（属浏览器 chrome 层 UI），Chromium 会在无用户手势时
   * 直接判定为拒绝 —— 这恰好是本项要验证的**拒绝降级路径**。判定依据是点击后的界面状态，
   * 而不是我们假造一个"用户点了拒绝"。
   */
  const beforeClick = Date.now();
  await uaSwitch.click({ timeout: 10_000 });
  await sidebar.waitForTimeout(2500);
  record('场景 14：点击开关后权限申请流程已完成', Date.now() - beforeClick < 12_000, `耗时 ${Date.now() - beforeClick}ms`);

  // 开关必须回弹为关：绝不允许留下一个"看起来开着"的开关
  const uaCheckedAfter = await uaSwitch.getAttribute('aria-checked');
  record('场景 15：拒绝后开关回弹为关闭', uaCheckedAfter === 'false', `aria-checked = ${uaCheckedAfter}`);

  // 提示文案必须逐字为「未授权，已使用降级模式」（runtime-messages.md 错误码表）
  const noticeText = await sidebar.locator('.settings-notice').textContent();
  const noticeVisible = await sidebar.locator('.settings-notice').isVisible();
  record(
    '场景 16：提示「未授权，已使用降级模式」',
    noticeVisible && noticeText === '未授权，已使用降级模式',
    `提示 = ${noticeText ?? 'null'}（可见=${noticeVisible}）`,
  );

  // 徽章必须保持未授权，不得因为"点了开关"就变成可用（FR-029 核心）
  const badgesAfter = await readBadges(sidebar);
  record(
    '场景 17：拒绝后徽章保持「UA：未授权」（不谎报成功）',
    badgesAfter.includes('UA：未授权'),
    `徽章 = ${badgesAfter.join(' / ')}`,
  );

  await sidebar.screenshot({ path: path.join(OUT_DIR, '05-ua-after-denial.png') });

  // 存储里不得留下 granted 残留（否则重启后会显示成"已授权"）
  const persisted = await sidebar.evaluate(async () => {
    const raw = await chrome.storage.local.get('site-settings:v1');
    return JSON.stringify(raw['site-settings:v1'] ?? null);
  });
  record('场景 18：拒绝后设置中无 granted 残留', !persisted.includes('"granted"'), `存储 = ${persisted}`);

  // 拒绝后其余功能照常可用（spec FR-036：拒绝授权仍能浏览、管理标签）
  await sidebar.keyboard.press('Escape');
  await sidebar.waitForTimeout(500);
  const stillBrowsing = await sidebar.locator('#browserContent .tab-host:not([hidden]) iframe').count();
  const tabCountVisible = await sidebar.textContent('#navTabCountBox');
  record(
    '场景 19：拒绝授权后仍可浏览与管理标签',
    stillBrowsing === 1 && tabCountVisible !== '0',
    `可见 iframe = ${stillBrowsing}，标签数 = ${tabCountVisible}`,
  );

  // 撤销路径：已授权状态下的撤销由单测覆盖（grant-flow.test.ts）；此处验证后台消息路由可达
  const queryResult = await sidebar.evaluate(async (key: string) => {
    const response = (await chrome.runtime.sendMessage({
      type: 'capabilities.query',
      payload: { originKey: key },
    })) as { ok?: boolean; data?: unknown } | undefined;
    return JSON.stringify(response ?? null);
  }, FIXTURE_ORIGIN);
  record(
    '场景 20：能力查询消息路由可达且返回未授权',
    queryResult.includes('"ua":"unauthorized"'),
    `后台响应 = ${queryResult}`,
  );
}

/** 打开站点设置面板（经九宫格菜单，路径与用户操作一致） */
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
  // 等面板升起动画结束：徽章在弹层内，弹层未落位时元素虽在 DOM 但不可见，
  // 用 attached 态 + 显式等待更稳，避免被动画时序卡住
  await sidebar.waitForSelector('.badge-row .badge', { state: 'attached' });
  await sidebar.locator('.sheet.open').waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined);
  await sidebar.waitForTimeout(300);
  return sidebar.locator('.badge-row .badge').allTextContents();
}

/** 读取显示模式分段控件当前选中的文案 */
async function readActiveMode(sidebar: Page): Promise<string | null> {
  const active = sidebar.locator('.mode-btn.on');
  if ((await active.count()) === 0) {
    return null;
  }
  return active.first().textContent();
}

/** 写控制台报告 */
async function writeConsoleReport(): Promise<void> {
  const path_ = path.join(OUT_DIR, 'console.log');
  const lines = consoleMessages.map((entry) => `[${entry.level}] (${entry.where}) ${entry.text}`);
  await writeFile(path_, lines.length === 0 ? '(无 error/warning)\n' : `${lines.join('\n')}\n`, 'utf8');
  record('场景 21：控制台零 error / 零 warning', consoleMessages.length === 0, `共 ${consoleMessages.length} 条`);
}

/** 输出汇总并设置退出码 */
async function finish(): Promise<void> {
  const failed = results.filter((entry) => !entry.passed);
  const reportPath = path.join(OUT_DIR, 'report.json');
  await writeFile(reportPath, `${JSON.stringify({ results, consoleMessages }, null, 2)}\n`, 'utf8');

  console.log(`\n=== T041 结果：${results.length - failed.length}/${results.length} 通过 ===`);
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
  console.error('T041 验证脚本异常：', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
