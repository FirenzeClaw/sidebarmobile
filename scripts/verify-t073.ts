// sidebarmobile — US6 端到端验证脚本（scripts）
// 2026-09-29 | Kimi(speckit-implement) | T073：三通道菜单操作 + 四类菜单契约 + 20 标签页压力

/**
 * [DONE] T073 手动检查点的自动化执行器（US6 范围，quickstart 场景 13–14）。
 *
 * 验收项：
 *   1. **三通道分别验证菜单开关**：鼠标悬停、触摸 tap、键盘 Tab+Enter
 *   2. Esc 与外部点击关闭，并回焦触发器
 *   3. 四类上下文菜单的菜单项与 ui-states.md 逐字一致
 *   4. 20 个标签页下标签列表可用、活动标签可见、操作不遮挡内容
 *   5. 每个纯图标按钮都有 aria-label
 *   6. 控制台无代码缺陷类 error
 *
 * **可访问性是功能不是装饰**（FR-027/FR-028）：三条通道各有独立断言，
 * 只测鼠标的实现会在键盘断言处失败 —— 这正是本脚本存在的意义。
 *
 * **进程纪律**：自带夹具服务（端口 8921），try/finally 保证浏览器与服务被回收。
 *
 * 用法：node --experimental-strip-types scripts/verify-t073.ts
 */
import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startFixtureServer } from '../tests/helpers/fixture-lifecycle.ts';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const EXTENSION_PATH = path.join(PROJECT_ROOT, 'dist', 'chrome');
const OUT_DIR = path.join(PROJECT_ROOT, '.playwright-mcp', 't073');
const FIXTURE_PORT = 8921;

/** 契约 ui-states.md 的四张菜单表格（与 context-menu-spec.ts 同源，此处独立写一遍以形成交叉校验） */
const EXPECTED_MENU_LABELS = {
  tabEntry: ['刷新', '复制网址', '在普通标签页打开', '关闭'],
  navigation: ['前进', '后退', '刷新', '复制当前网址'],
  siteEntry: ['打开', '编辑名称', '删除', '切换移动/桌面', '授权设置'],
  siteSettings: ['移动/桌面切换', '真实移动 UA 开关', '登录复用开关', '能力状态说明'],
} as const;

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
    const userDataDir = path.join(os.tmpdir(), `sidebarmobile-t073-${Date.now()}`);
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
       * 启用触摸：契约要求验证"触摸点击"通道，而 Playwright 的 touchscreen 需要
       * 上下文显式开启 hasTouch，否则 tap 直接报错。
       */
      hasTouch: true,
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

    // 准备两个标签，使标签列表有内容可供菜单与压力测试使用
    await addUrl(sidebar, `${fixtureOrigin}/embeddable`);
    await goHome(sidebar);
    await addUrl(sidebar, `${fixtureOrigin}/spa`);

    await checkIconButtonsHaveLabels(sidebar);
    await checkSiteEntryMenuChannels(sidebar);
    await checkNavigationMenu(sidebar, fixtureOrigin);
    await checkSiteSettingsMenu(sidebar);
    await checkTabEntryMenuChannelKeyboard(sidebar);
    await checkTwentyTabStress(sidebar, fixtureOrigin);
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

async function addUrl(sidebar: Page, url: string): Promise<void> {
  await sidebar.waitForSelector('#addUrlInput', { state: 'visible' });
  await sidebar.fill('#addUrlInput', url);
  await sidebar.click('#addUrlSubmit');
  await sidebar.waitForTimeout(1400);
}

async function goHome(sidebar: Page): Promise<void> {
  await sidebar.keyboard.press('Escape');
  await sidebar.waitForTimeout(300);
  await sidebar.click('#navHome');
  await sidebar.waitForTimeout(400);
}

/** 菜单是否可见 */
async function menuVisible(sidebar: Page): Promise<boolean> {
  const menu = sidebar.locator('#iconMenu');
  if ((await menu.count()) === 0) {
    return false;
  }
  return menu.isVisible();
}

/** 读取当前菜单的项文案（按 DOM 顺序） */
async function readMenuLabels(sidebar: Page): Promise<string[]> {
  await sidebar.waitForSelector('#iconMenu .menu-btn', { state: 'attached' });
  return sidebar.locator('#iconMenu .menu-btn').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('aria-label') ?? ''),
  );
}

/** 场景 5（先做）：所有纯图标按钮都有 aria-label（FR-028） */
async function checkIconButtonsHaveLabels(sidebar: Page): Promise<void> {
  await goHome(sidebar);
  const audit = await sidebar.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const missing: string[] = [];
    for (const button of buttons) {
      const label = (button.getAttribute('aria-label') ?? '').trim();
      const text = (button.textContent ?? '').trim();
      // 有可见文本的按钮不需要 aria-label；纯图标按钮必须有
      if (label.length === 0 && text.length === 0) {
        missing.push(button.id.length > 0 ? `#${button.id}` : `.${button.className}`);
      }
    }
    return { total: buttons.length, missing };
  });

  record(
    '场景 5：所有纯图标按钮都有 aria-label',
    audit.missing.length === 0,
    `检查 ${audit.total} 个按钮，缺 aria-label 的 = ${audit.missing.length === 0 ? '无' : audit.missing.join(', ')}`,
  );

  // 触发钮必须声明弹出的是菜单（ARIA menu 模式的前提）
  const triggerAudit = await sidebar.evaluate(() => {
    const triggers = Array.from(document.querySelectorAll('[aria-haspopup="menu"]'));
    const withoutExpanded = triggers.filter((element) => !element.hasAttribute('aria-expanded'));
    return { count: triggers.length, withoutExpanded: withoutExpanded.length };
  });
  record(
    '场景 5：菜单触发钮同时声明 aria-expanded',
    triggerAudit.count > 0 && triggerAudit.withoutExpanded === 0,
    `触发钮 ${triggerAudit.count} 个，缺 aria-expanded = ${triggerAudit.withoutExpanded}`,
  );
}

/** 场景 1：网站条目菜单 —— 鼠标悬停通道 */
async function checkSiteEntryMenuChannels(sidebar: Page): Promise<void> {
  await goHome(sidebar);
  await sidebar.waitForSelector('#siteGrid .site-item');

  const firstItem = sidebar.locator('#siteGrid .site-item').first();
  const moreButton = firstItem.locator('.site-more');

  // --- 鼠标悬停 ---
  await moreButton.hover();
  await sidebar.waitForTimeout(400);
  const hoverOpen = await menuVisible(sidebar);
  record('场景 1a：鼠标悬停打开菜单', hoverOpen, `菜单可见 = ${hoverOpen}`);

  if (hoverOpen) {
    const labels = await readMenuLabels(sidebar);
    record(
      '场景 1a：网站条目菜单项与契约逐字一致',
      labels.join(' | ') === EXPECTED_MENU_LABELS.siteEntry.join(' | '),
      `实际 = ${labels.join(' | ')}`,
    );
    // ARIA：触发器展开态
    const expanded = await moreButton.getAttribute('aria-expanded');
    record('场景 1a：触发器 aria-expanded 同步为 true', expanded === 'true', `aria-expanded = ${expanded}`);
    await sidebar.screenshot({ path: path.join(OUT_DIR, '01-site-menu-hover.png') });

    // --- Esc 关闭并回焦 ---
    await sidebar.keyboard.press('Escape');
    await sidebar.waitForTimeout(400);
    const closedByEsc = !(await menuVisible(sidebar));
    const focusReturned = await sidebar.evaluate(() => {
      const active = document.activeElement;
      return active !== null && active.classList.contains('site-more');
    });
    record('场景 2a：Esc 关闭菜单', closedByEsc, `菜单可见 = ${!closedByEsc}`);
    record('场景 2b：Esc 关闭后回焦触发器', focusReturned, `焦点在 ⋮ 触发器 = ${focusReturned}`);
  } else {
    record('场景 1a：网站条目菜单项与契约逐字一致', false, '菜单未打开，跳过');
    record('场景 1a：触发器 aria-expanded 同步为 true', false, '菜单未打开，跳过');
    record('场景 2a：Esc 关闭菜单', false, '菜单未打开，跳过');
    record('场景 2b：Esc 关闭后回焦触发器', false, '菜单未打开，跳过');
  }

  // --- 外部点击关闭 ---
  /**
   * 用键盘打开再点外部，而不是 hover 打开。
   *
   * 上一步的 Esc 关闭后，mouseenter 不会再次触发（指针没离开过元素），
   * hover 会静默无效；键盘通道与指针状态无关，是更可靠的前置。
   */
  await moreButton.focus();
  await sidebar.keyboard.press('Enter');
  await sidebar.waitForTimeout(500);

  if (await menuVisible(sidebar)) {
    // 点内容区空白处（菜单外）
    await sidebar.locator('.home-brand .brand-name').click({ force: true });
    await sidebar.waitForTimeout(500);
    const closedByOutside = !(await menuVisible(sidebar));
    record('场景 2c：外部点击关闭菜单', closedByOutside, `菜单可见 = ${!closedByOutside}`);
  } else {
    record('场景 2c：外部点击关闭菜单', false, '菜单未打开，跳过');
  }
}

/**
 * 场景 1b：导航区菜单（含键盘通道）。
 *
 * **测试前置**：必须让后退键处于可用状态。
 * 契约把导航菜单挂在导航键上，而**禁用按钮在 Chromium 里无法接收焦点** ——
 * 若后退键是禁用的，`focus()` 会静默失败、焦点留在原处，随后的 Enter 会打开
 * **上一个菜单**（本项目实测踩到过：读到的菜单项是网站条目的），断言就会指向错误的对象。
 * 因此这里先经扩展自身的导航产生历史，让后退键可用。
 */
async function checkNavigationMenu(sidebar: Page, fixtureOrigin: string): Promise<void> {
  await sidebar.waitForTimeout(500);

  /**
   * 造历史：直接往当前标签的扩展历史栈里写两条。
   *
   * 为什么不用 UI 构造：`addUrl` 每次都会**新开标签**（FR-004 的行为），不会给同一个标签
   * 增加历史；而 iframe 内部的链接点击在 Tier 1 下不被观测（US4 结论），也不进历史栈。
   * 本场景只需要"后退键处于可用状态"这个前置，直接构造最直接，且不改变被测行为。
   */
  await sidebar.evaluate(async (origin: string) => {
    const now = new Date().toISOString();
    const tabs = [
      {
        tabId: 'nav-history-tab',
        originKey: origin,
        currentUrl: `${origin}/embeddable?nav=2`,
        title: '导航历史标签',
        history: [
          { url: `${origin}/embeddable`, title: '第一步', visitedAt: now },
          { url: `${origin}/embeddable?nav=2`, title: '第二步', visitedAt: now },
        ],
        historyIndex: 1,
        loadState: 'loaded' as const,
        createdAt: now,
      },
    ];
    await chrome.storage.local.set({
      'session:v1': { version: 1, tabs, activeTabId: 'nav-history-tab', savedAt: now },
    });
  }, fixtureOrigin);

  await sidebar.reload();
  await sidebar.waitForSelector('#navTabCountBox');
  await sidebar.waitForTimeout(2000);

  const backEnabled = await sidebar.locator('#navBack').isEnabled();
  record('场景 1b 前置：后退键可用（禁用按钮无法聚焦）', backEnabled, `后退键可用 = ${backEnabled}`);

  // --- 键盘 Tab + Enter 通道 ---
  const navBack = sidebar.locator('#navBack');
  await navBack.focus();
  await sidebar.keyboard.press('Enter');
  await sidebar.waitForTimeout(500);

  const keyboardOpen = await menuVisible(sidebar);
  record('场景 1b：键盘 Enter 打开导航菜单', keyboardOpen, `菜单可见 = ${keyboardOpen}`);

  if (keyboardOpen) {
    const labels = await readMenuLabels(sidebar);
    record(
      '场景 1b：导航菜单项与契约逐字一致',
      labels.join(' | ') === EXPECTED_MENU_LABELS.navigation.join(' | '),
      `实际 = ${labels.join(' | ')}`,
    );

    // 键盘打开必须把焦点移入菜单第一项（否则键盘用户到不了菜单项）
    const focusInMenu = await sidebar.evaluate(() => {
      const active = document.activeElement;
      const menu = document.getElementById('iconMenu');
      return active !== null && menu !== null && menu.contains(active);
    });
    record('场景 1b：键盘打开后焦点进入菜单', focusInMenu, `焦点在菜单内 = ${focusInMenu}`);

    // 方向键在项间移动
    await sidebar.keyboard.press('ArrowDown');
    await sidebar.waitForTimeout(200);
    const focusMoved = await sidebar.evaluate(() => {
      const active = document.activeElement;
      const menu = document.getElementById('iconMenu');
      if (active === null || menu === null) {
        return false;
      }
      const items = Array.from(menu.querySelectorAll('.menu-btn'));
      return items.indexOf(active as Element) === 1;
    });
    record('场景 1c：方向键在菜单项间移动', focusMoved, `焦点移到第 2 项 = ${focusMoved}`);

    await sidebar.screenshot({ path: path.join(OUT_DIR, '02-nav-menu-keyboard.png') });
    await sidebar.keyboard.press('Escape');
    await sidebar.waitForTimeout(400);
  } else {
    record('场景 1b：导航菜单项与契约逐字一致', false, '菜单未打开，跳过');
    record('场景 1b：键盘打开后焦点进入菜单', false, '菜单未打开，跳过');
    record('场景 1c：方向键在菜单项间移动', false, '菜单未打开，跳过');
  }
}

/** 场景 1d：站点设置钮菜单（触摸 tap 通道） */
async function checkSiteSettingsMenu(sidebar: Page): Promise<void> {
  await sidebar.waitForTimeout(400);

  /**
   * --- 触摸 tap 通道 ---
   *
   * 用 touchscreen.tap 而不是 mouse click：tap 会走 `touchToggle`（立即切换），
   * 而 mouse click 走的是 `touchToggle` 同一个处理器 —— 两者的区别在于 tap 之前
   * **不会**产生 hover 事件，因此这条断言能真正验证"不依赖 hover 也能开"。
   */
  await goHome(sidebar);
  // 复位菜单状态：前序场景可能留下打开的菜单，残留状态会让 tap 变成"切换到关闭"
  await sidebar.keyboard.press('Escape');
  await sidebar.waitForTimeout(600);
  const urlBar = sidebar.locator('#urlBar');
  const box = await urlBar.boundingBox();
  if (box === null) {
    record('场景 1d：触摸 tap 打开菜单', false, '找不到网址栏位置');
    return;
  }

  // 触摸通道用 tap 事件而不是 hover：hover 不会触发 touchToggle
  await sidebar.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await sidebar.waitForTimeout(700);

  let touchOpen = await menuVisible(sidebar);
  if (!touchOpen) {
    /**
     * 重试一次。
     *
     * 触摸合成在本环境里受前序交互影响（指针状态、焦点残留）：第一次 tap 可能被
     * 前一个场景遗留的 pointerdown/焦点状态吞掉。重试是**为了区分"通道坏了"与"环境噪声"**，
     * 而不是掩盖问题 —— 若重试也打不开，说明通道确实有问题，下面照旧判失败。
     */
    await sidebar.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await sidebar.waitForTimeout(700);
    touchOpen = await menuVisible(sidebar);
  }
  record('场景 1d：触摸 tap 打开菜单（不依赖 hover）', touchOpen, `菜单可见 = ${touchOpen}`);

  if (touchOpen) {
    const labels = await readMenuLabels(sidebar);
    record(
      '场景 1d：站点设置菜单项与契约逐字一致',
      labels.join(' | ') === EXPECTED_MENU_LABELS.siteSettings.join(' | '),
      `实际 = ${labels.join(' | ')}`,
    );

    // 触摸打开不应把焦点强行移入菜单（触摸端无键盘焦点概念）
    const focusInMenu = await sidebar.evaluate(() => {
      const active = document.activeElement;
      const menu = document.getElementById('iconMenu');
      return active !== null && menu !== null && menu.contains(active);
    });
    record('场景 1d：触摸打开不强移焦点进菜单', !focusInMenu, `焦点在菜单内 = ${focusInMenu}`);

    await sidebar.screenshot({ path: path.join(OUT_DIR, '03-settings-menu-touch.png') });
    await sidebar.keyboard.press('Escape');
    await sidebar.waitForTimeout(400);
  } else {
    /**
     * 触摸 tap 在桌面 Chromium 里可能被合成为鼠标事件（从而走 hover 通道）。
     * 这时不判失败，而是如实记录"该环境无法区分触摸通道"，避免把环境限制报成产品缺陷。
     */
    record('场景 1d：站点设置菜单项与契约逐字一致', false, '触摸通道未打开菜单（该环境可能合成为鼠标事件）');
    record('场景 1d：触摸打开不强移焦点进菜单', false, '菜单未打开，跳过');
  }
}

/** 场景 1e：标签页项菜单（键盘通道） */
async function checkTabEntryMenuChannelKeyboard(sidebar: Page): Promise<void> {
  await goHome(sidebar);
  await sidebar.keyboard.press('Escape');
  await sidebar.waitForTimeout(500);
  await sidebar.click('#navTabCount');
  await sidebar.waitForSelector('.tablist-row');
  await sidebar.waitForTimeout(600);

  /**
   * 纯键盘路径：**不悬停**，直接聚焦 ⋮ 并按 Enter。
   *
   * 之所以强调"不悬停"：⋮ 的 `opacity: 0` 只是视觉隐藏，键盘仍然可达（这是可访问性的要求）。
   * 一旦先 hover，指针就停在行上，`mouseleave` 之类的合成事件会干扰后续断言 ——
   * 而且那样测的就不是"仅键盘用户"的路径了（quickstart 场景 13 明确要求"仅键盘"）。
   */
  const firstRow = sidebar.locator('.tablist-row').first();
  const firstMore = firstRow.locator('.tablist-more');
  await firstMore.focus();
  await sidebar.waitForTimeout(200);
  await sidebar.keyboard.press('Enter');
  await sidebar.waitForTimeout(700);

  const open = await menuVisible(sidebar);
  record('场景 1e：键盘 Enter 打开标签页项菜单', open, `菜单可见 = ${open}`);

  if (open) {
    const labels = await readMenuLabels(sidebar);
    record(
      '场景 1e：标签页项菜单与契约逐字一致',
      labels.join(' | ') === EXPECTED_MENU_LABELS.tabEntry.join(' | '),
      `实际 = ${labels.join(' | ')}`,
    );
    await sidebar.screenshot({ path: path.join(OUT_DIR, '04-tab-menu-keyboard.png') });
    await sidebar.keyboard.press('Escape');
    await sidebar.waitForTimeout(400);
  } else {
    const diag = await sidebar.evaluate(() => {
      const btn = document.querySelector('.tablist-more');
      return {
        hasButton: btn !== null,
        connected: btn?.isConnected ?? false,
        haspopup: btn?.getAttribute('aria-haspopup') ?? null,
        expanded: btn?.getAttribute('aria-expanded') ?? null,
        focused: document.activeElement?.className ?? null,
      };
    });
    record('场景 1e：标签页项菜单与契约逐字一致', false, `菜单未打开；诊断 = ${JSON.stringify(diag)}`);
  }

  // 标签行必须声明 aria-current（读屏器需要知道哪一行是当前项）
  const activeRowAudit = await sidebar.evaluate(() => {
    const active = document.querySelector('.tablist-row.active');
    return {
      hasActive: active !== null,
      ariaCurrent: active?.getAttribute('aria-current') ?? null,
    };
  });
  record(
    '场景 1e：活动标签行标记 aria-current',
    activeRowAudit.hasActive && activeRowAudit.ariaCurrent === 'true',
    `aria-current = ${activeRowAudit.ariaCurrent ?? 'null'}`,
  );

  await sidebar.keyboard.press('Escape');
  await sidebar.waitForTimeout(400);
}

/** 场景 4：20 标签页压力（SC-003，quickstart 场景 14） */
async function checkTwentyTabStress(sidebar: Page, fixtureOrigin: string): Promise<void> {
  /**
   * 经存储直接注入 20 个标签而不是逐个点添加：本场景验证的是**侧栏在 20 标签下的可用性**，
   * 而不是添加流程（那条路径由 T029 覆盖）。逐个添加 20 次会让脚本跑很久且中途状态难控。
   */
  await sidebar.evaluate(
    async (origin: string) => {
      const now = new Date().toISOString();
      const tabs = Array.from({ length: 20 }, (_unused, index) => ({
        tabId: `stress-tab-${index}`,
        originKey: origin,
        currentUrl: `${origin}/embeddable?tab=${index}`,
        title: `压力测试标签 ${index}`,
        history: [{ url: `${origin}/embeddable?tab=${index}`, title: `压力测试标签 ${index}`, visitedAt: now }],
        historyIndex: 0,
        loadState: 'loaded' as const,
        createdAt: now,
      }));
      await chrome.storage.local.set({
        'session:v1': {
          version: 1,
          tabs,
          // 活动标签选最后一个：验证它在长列表里也可见
          activeTabId: 'stress-tab-19',
          savedAt: now,
        },
      });
    },
    fixtureOrigin,
  );

  await sidebar.reload();
  await sidebar.waitForSelector('#navTabCountBox');
  await sidebar.waitForTimeout(2500);

  const tabCount = await sidebar.textContent('#navTabCountBox');
  record('场景 4：20 个标签全部恢复', tabCount === '20', `标签数 = ${tabCount}`);

  await sidebar.click('#navTabCount');
  await sidebar.waitForSelector('.tablist-row');
  await sidebar.waitForTimeout(600);

  const rowCount = await sidebar.locator('.tablist-row').count();
  record('场景 4：标签列表列出全部 20 项（无虚拟滚动）', rowCount === 20, `列表行数 = ${rowCount}`);

  // 活动标签可见：滚动到它并确认在弹层可视区内
  const activeVisible = await sidebar.evaluate(() => {
    const active = document.querySelector('.tablist-row.active');
    if (active === null) {
      return false;
    }
    active.scrollIntoView({ block: 'nearest' });
    const rect = active.getBoundingClientRect();
    const sheet = document.getElementById('sheet');
    if (sheet === null) {
      return false;
    }
    const sheetRect = sheet.getBoundingClientRect();
    return rect.top >= sheetRect.top - 1 && rect.bottom <= sheetRect.bottom + 1;
  });
  record('场景 4：活动标签在列表中可见', activeVisible, `滚入可视区 = ${activeVisible}`);

  await sidebar.screenshot({ path: path.join(OUT_DIR, '05-twenty-tabs.png') });

  // 操作不遮挡内容：切到活动标签后内容区仍占满（覆盖层/弹层已收起）
  await sidebar.keyboard.press('Escape');
  await sidebar.waitForTimeout(600);

  const layout = await sidebar.evaluate(() => {
    const content = document.getElementById('browserContent');
    const sheet = document.getElementById('sheet');
    const menu = document.getElementById('iconMenu');
    const brand = document.querySelector('.bottom-nav');
    const measures: Record<string, number> = {};
    if (content !== null) {
      measures['contentWidth'] = Math.round(content.getBoundingClientRect().width);
      measures['contentHeight'] = Math.round(content.getBoundingClientRect().height);
    }
    measures['sheetVisible'] = sheet !== null && !sheet.hidden ? 1 : 0;
    measures['menuVisible'] = menu !== null && !menu.hidden ? 1 : 0;
    measures['navHeight'] = brand === null ? 0 : Math.round(brand.getBoundingClientRect().height);
    return measures;
  });

  record(
    '场景 4：内容区占用剩余空间（弹层与菜单已收起）',
    (layout['contentWidth'] ?? 0) > 300 && (layout['contentHeight'] ?? 0) > 400 && layout['sheetVisible'] === 0 && layout['menuVisible'] === 0,
    `内容区 ${layout['contentWidth'] ?? 0}×${layout['contentHeight'] ?? 0}，弹层可见 = ${layout['sheetVisible']}，菜单可见 = ${layout['menuVisible']}，底栏高 ${layout['navHeight']}`,
  );

  // 关闭全部 20 个标签不应崩（连续操作压力）
  await sidebar.click('#navTabCount');
  await sidebar.waitForSelector('.tablist-row');
  await sidebar.waitForTimeout(500);
  for (let index = 0; index < 20; index += 1) {
    await sidebar.locator('.tablist-row').first().locator('.tablist-close').click();
    await sidebar.waitForTimeout(350);
  }
  await sidebar.waitForTimeout(1000);
  const finalCount = await sidebar.textContent('#navTabCountBox');
  const homeVisible = await sidebar.locator('#viewSiteList').isVisible();
  record('场景 4：连续关闭 20 个标签后回到主页', finalCount === '0' && homeVisible, `标签数 = ${finalCount}，主页可见 = ${homeVisible}`);

  await sidebar.screenshot({ path: path.join(OUT_DIR, '06-after-close-all.png') });
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
    if (entry.text.includes('Failed to load resource')) {
      return false;
    }
    return true;
  });

  record(
    '场景 6：控制台无代码缺陷类 error / 无 warning',
    defectMessages.length === 0,
    `共 ${consoleMessages.length} 条，缺陷类 ${defectMessages.length} 条${defectMessages.length > 0 ? `：${defectMessages.map((entry) => entry.text).join(' | ')}` : ''}`,
  );
}

async function finish(): Promise<void> {
  const failed = results.filter((entry) => !entry.passed);
  const reportPath = path.join(OUT_DIR, 'report.json');
  await writeFile(reportPath, `${JSON.stringify({ results, consoleMessages }, null, 2)}\n`, 'utf8');

  console.log(`\n=== T073 结果：${results.length - failed.length}/${results.length} 通过 ===`);
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
  console.error('T073 验证脚本异常：', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
