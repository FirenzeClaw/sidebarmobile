// sidebarmobile — Demo 交互逻辑（app.js，无框架原生 JS）
// 2026-09-29 | 视图 A/B 切换、标签与历史栈、悬停子菜单、底部弹层、权限对话框、六主题切换。
// 约定：动态文本一律走 textContent；仅受信任的静态 SVG 字符串使用 innerHTML。

'use strict';

/* ==================== 主题卡数据（与 themes.css 同源，用于主题卡预览的 inline style） ==================== */
const THEME_CARDS = [
  { id: 'chrome-day',    name: 'Chrome 白昼',   bg: '#FFFFFF', surface: '#F1F3F4', primary: '#0B57D0', onPrimary: '#FFFFFF', text: '#1F1F1F' },
  { id: 'chrome-night',  name: 'Chrome 夜间',   bg: '#202124', surface: '#2D2E31', primary: '#A8C7FA', onPrimary: '#062E6F', text: '#E3E3E3' },
  { id: 'edge-day',      name: 'Edge 白昼',     bg: '#FFFFFF', surface: '#F3F3F3', primary: '#0F6CBD', onPrimary: '#FFFFFF', text: '#242424' },
  { id: 'edge-night',    name: 'Edge 夜间',     bg: '#1F1F1F', surface: '#2B2B2B', primary: '#479EF5', onPrimary: '#1B1B1B', text: '#FFFFFF' },
  { id: 'firefox-day',   name: 'Firefox 白昼',  bg: '#FFFFFF', surface: '#F0F0F4', primary: '#0060DF', onPrimary: '#FFFFFF', text: '#15141A' },
  { id: 'firefox-night', name: 'Firefox 夜间',  bg: '#1C1B22', surface: '#2B2A33', primary: '#00DDFF', onPrimary: '#15141A', text: '#FBFBFE' },
];

/* ==================== 内联 SVG 图标（线性风格，stroke=currentColor） ==================== */
function svg(inner) {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + inner + '</svg>';
}
const ICONS = {
  search:   svg('<circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/>'),
  theme:    svg('<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/>'),
  back:     svg('<polyline points="14.5 5.5 8 12 14.5 18.5"/>'),
  forward:  svg('<polyline points="9.5 5.5 16 12 9.5 18.5"/>'),
  home:     svg('<path d="M4 11.5 12 4.5l8 7V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/>'),
  menu:     svg('<line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/>'),
  close:    svg('<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>'),
  refresh:  svg('<path d="M20 12a8 8 0 1 1-2.4-5.7"/><polyline points="20 3.5 20 8.5 15 8.5"/>'),
  copy:     svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>'),
  external: svg('<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M19 14v5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19V8a1.5 1.5 0 0 1 1.5-1.5H11"/>'),
  edit:     svg('<path d="M4 20h4.5L20 8.5a2.12 2.12 0 0 0-3-3L5.5 17z"/><path d="M14.5 7 17 9.5"/>'),
  trash:    svg('<path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6.5 7l1 13h9l1-13"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>'),
  devices:  svg('<rect x="2.5" y="5" width="14" height="10" rx="1.5"/><path d="M6 19h8"/><rect x="16.5" y="9.5" width="5" height="9.5" rx="1.2"/>'),
  shield:   svg('<path d="M12 3l7.5 3v5.5c0 4.6-3 8-7.5 9.5-4.5-1.5-7.5-4.9-7.5-9.5V6z"/>'),
  share:    svg('<circle cx="6" cy="12" r="2.5"/><circle cx="17" cy="5.5" r="2.5"/><circle cx="17" cy="18.5" r="2.5"/><path d="M8.3 10.8 14.8 6.7M8.3 13.2l6.5 4.1"/>'),
  bookmark: svg('<path d="M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1z"/>'),
  history:  svg('<path d="M4.5 12a7.5 7.5 0 1 1 2.2 5.3"/><polyline points="4 12.5 4 17 8.5 17"/><path d="M12 8v4.5l3 1.8"/>'),
  plus:     svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  check:    svg('<polyline points="5 12.5 10 17.5 19 7"/>'),
  moon:     svg('<path d="M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5z"/>'),
  sun:      svg('<circle cx="12" cy="12" r="4.2"/><line x1="12" y1="2.5" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="21.5"/><line x1="2.5" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="21.5" y2="12"/><line x1="4.8" y1="4.8" x2="6.6" y2="6.6"/><line x1="17.4" y1="17.4" x2="19.2" y2="19.2"/><line x1="4.8" y1="19.2" x2="6.6" y2="17.4"/><line x1="17.4" y1="6.6" x2="19.2" y2="4.8"/>'),
  grid:     svg('<rect x="4.5" y="4.5" width="6.5" height="6.5" rx="1.5"/><rect x="13" y="4.5" width="6.5" height="6.5" rx="1.5"/><rect x="4.5" y="13" width="6.5" height="6.5" rx="1.5"/><rect x="13" y="13" width="6.5" height="6.5" rx="1.5"/>'),
  more:     svg('<circle cx="12" cy="5.5" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="18.5" r="1.4" fill="currentColor" stroke="none"/>'),
  warning:  svg('<path d="M12 4 21 19.5H3z"/><line x1="12" y1="10" x2="12" y2="14.5"/><circle cx="12" cy="17" r=".9" fill="currentColor" stroke="none"/>'),
  globe:    svg('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.8 2.4 4 5.3 4 8.5s-1.2 6.1-4 8.5c-2.8-2.4-4-5.3-4-8.5s1.2-6.1 4-8.5z"/>'),
};

/* ==================== 模拟网站数据（内置假站点，各有 2-3 页假内容） ==================== */
// 站点色为演示内容色（模拟真实网站的品牌色，不属于 UI 主题色值）
const PALETTE = ['#3B82C4', '#C4537A', '#2F9E6E', '#D97A2B', '#7A5FBF', '#4A8F8F'];
const IMG_COLORS = ['#3B82C4', '#C4537A', '#2F9E6E', '#D97A2B', '#7A5FBF', '#4A8F8F'];

const DEFAULT_SITES = [
  { id: 's1', name: '每日见闻',   url: 'https://daily.news',  color: '#3B82C4' },
  { id: 's2', name: '像素画廊',   url: 'https://pix.gallery', color: '#C4537A' },
  { id: 's3', name: '开发者文档', url: 'https://dev.docs',    color: '#2F9E6E' },
  { id: 's4', name: '市集',       url: 'https://shop.demo',   color: '#D97A2B' },
];

function buildMockWeb() {
  const web = {
    'daily.news': {
      name: '每日见闻', color: '#3B82C4',
      pages: {
        '': { title: '每日见闻', blocks: [
          { t: 'hero', text: '每日见闻', sub: '2026年9月29日 · 演示站点' },
          { t: 'p', text: '这里是模拟新闻站首页。页面中的链接都可以点击，点击后会在当前标签内导航，并写入该标签的历史栈（可用底部 ← → 回退/前进）。' },
          { t: 'h2', text: '今日推荐' },
          { t: 'link', text: '侧栏浏览器的兴起：第二块屏幕', to: 'https://daily.news/article/1' },
          { t: 'link', text: '为什么移动视图在桌面端仍有意义', to: 'https://daily.news/article/2' },
          { t: 'h2', text: '外部链接' },
          { t: 'ext', text: '像素画廊（跨站导航演示）', url: 'https://pix.gallery' },
          { t: 'ext', text: '⚠ 禁止嵌入示例站（XFO 降级演示）', url: 'https://xfo-blocked.demo' },
        ] },
        'article/1': { title: '侧栏浏览器的兴起', blocks: [
          { t: 'hero', text: '侧栏浏览器的兴起', sub: '栏目 · 产品观察 · 5 分钟阅读' },
          { t: 'p', text: '越来越多的用户把即时通讯、文档与看板固定在浏览器侧栏。与独立窗口相比，侧栏更轻量，也更贴近「边做边查」的工作流。' },
          { t: 'p', text: '移动版页面在 360px 的窄栏里反而清晰易读：大字号、单栏排版、操作集中在拇指热区——这正是「侧栏里的手机浏览器」的出发点。' },
          { t: 'link', text: '下一篇：为什么移动视图在桌面端仍有意义', to: 'https://daily.news/article/2' },
          { t: 'link', text: '返回首页', to: 'https://daily.news' },
        ] },
        'article/2': { title: '移动视图为何仍有意义', blocks: [
          { t: 'hero', text: '为什么移动视图在桌面端仍有意义', sub: '栏目 · 技术评论 · 3 分钟阅读' },
          { t: 'p', text: '窄排版、大字号、少干扰——移动版页面天然适合侧栏。配合真实移动 UA，还能拿到为触屏优化的交互组件。' },
          { t: 'p', text: '当站点拒绝被嵌入时，扩展需要给出清晰的降级路径，而不是一面白墙。' },
          { t: 'link', text: '上一篇：侧栏浏览器的兴起', to: 'https://daily.news/article/1' },
          { t: 'link', text: '返回首页', to: 'https://daily.news' },
        ] },
      },
    },
    'pix.gallery': {
      name: '像素画廊', color: '#C4537A',
      pages: {},
    },
    'dev.docs': {
      name: '开发者文档', color: '#2F9E6E',
      pages: {
        '': { title: '开发者文档', blocks: [
          { t: 'hero', text: '开发者文档', sub: 'SidebarMobile API · 演示站点' },
          { t: 'p', text: '模拟文档站首页，包含两篇文档。' },
          { t: 'link', text: '快速上手：保存你的第一个网站', to: 'https://dev.docs/guide' },
          { t: 'link', text: 'API 参考：能力与权限', to: 'https://dev.docs/api' },
        ] },
        'guide': { title: '快速上手 · 开发者文档', blocks: [
          { t: 'hero', text: '快速上手', sub: '指南 · 2 分钟阅读' },
          { t: 'p', text: '在主页输入网址并回车，网站会被保存到网站列表，并立即在新标签中打开。' },
          { t: 'code', text: 'browser.sidebarMobile.open({\n  url: "https://daily.news",\n  mode: "mobile"\n})' },
          { t: 'link', text: '继续阅读：API 参考', to: 'https://dev.docs/api' },
          { t: 'link', text: '返回文档首页', to: 'https://dev.docs' },
        ] },
        'api': { title: 'API 参考 · 开发者文档', blocks: [
          { t: 'hero', text: 'API 参考', sub: '参考 · 能力与权限' },
          { t: 'p', text: '真实移动 UA 与登录状态复用是两个独立开关，各自需要对应的浏览器权限。' },
          { t: 'code', text: 'permissions: [\n  "declarativeNetRequest", // 真实移动 UA\n  "cookies"                 // 登录状态复用\n]' },
          { t: 'link', text: '返回快速上手', to: 'https://dev.docs/guide' },
          { t: 'link', text: '返回文档首页', to: 'https://dev.docs' },
        ] },
      },
    },
    'shop.demo': {
      name: '市集', color: '#D97A2B',
      pages: {
        '': { title: '市集', blocks: [
          { t: 'hero', text: '市集', sub: '模拟电商 · 演示站点' },
          { t: 'p', text: '点击商品进入详情页。注意：详情页模拟 SPA 的 pushState 更新，标签上会演示「地址可能未同步」徽章。' },
          { t: 'cards', items: [
            { label: '机械键盘', sub: '¥299 · 茶轴 87 键', to: 'https://shop.demo/item/kb' },
            { label: '保温杯',   sub: '¥89 · 500mL 钛灰色', to: 'https://shop.demo/item/cup' },
          ] },
        ] },
        'item/kb': { title: '机械键盘 · 市集', spa: true, blocks: [
          { t: 'hero', text: '机械键盘', sub: '¥299 · 茶轴 87 键' },
          { t: 'p', text: 'PBT 键帽，全键无冲，三模连接（演示文案）。' },
          { t: 'note', text: '本页由 pushState 局部更新，地址可能未同步。' },
          { t: 'link', text: '看看保温杯', to: 'https://shop.demo/item/cup' },
          { t: 'link', text: '返回市集首页', to: 'https://shop.demo' },
        ] },
        'item/cup': { title: '保温杯 · 市集', spa: true, blocks: [
          { t: 'hero', text: '保温杯', sub: '¥89 · 500mL 钛灰色' },
          { t: 'p', text: '双层真空，保温 12 小时（演示文案）。' },
          { t: 'note', text: '本页由 pushState 局部更新，地址可能未同步。' },
          { t: 'link', text: '看看机械键盘', to: 'https://shop.demo/item/kb' },
          { t: 'link', text: '返回市集首页', to: 'https://shop.demo' },
        ] },
      },
    },
  };

  // 像素画廊的作品页批量生成（4 张作品，各自一页）
  const photos = [
    { id: 'aurora', label: '极光', color: '#3B82C4' },
    { id: 'dune',   label: '沙丘', color: '#D97A2B' },
    { id: 'tide',   label: '潮汐', color: '#4A8F8F' },
    { id: 'moss',   label: '苔藓', color: '#2F9E6E' },
  ];
  const galleryPages = {
    '': { title: '像素画廊', blocks: [
      { t: 'hero', text: '像素画廊', sub: '模拟图床 · 演示站点' },
      { t: 'p', text: '点击任意色块查看「作品详情」。' },
      { t: 'imgs', items: photos.map((p) => ({ label: p.label, color: p.color, to: 'https://pix.gallery/photo/' + p.id })) },
      { t: 'ext', text: '每日见闻（跨站导航演示）', url: 'https://daily.news' },
    ] },
  };
  for (const p of photos) {
    galleryPages['photo/' + p.id] = { title: '作品 · ' + p.label, blocks: [
      { t: 'bigimg', label: p.label, color: p.color },
      { t: 'p', text: '《' + p.label + '》——演示摄影作品，摄于想象中的一角。' },
      { t: 'link', text: '返回画廊', to: 'https://pix.gallery' },
    ] };
  }
  web['pix.gallery'].pages = galleryPages;
  return web;
}

const MOCK_WEB = buildMockWeb();
const BLOCKED_HOST = 'xfo-blocked.demo';

/* ==================== 全局状态 ==================== */
const state = {
  view: 'home',            // 'home' | 'browser'
  theme: 'chrome-day',
  sites: DEFAULT_SITES.map((s) => ({ ...s })),
  tabs: [],                // { id, currentUrl, title, color, history:[], hIndex, loadState, addressMaybeStale }
  activeTabId: null,
  nextTabId: 1,
  nextSiteId: 100,
};

// 每个源（host）的站点级状态：移动/桌面模式 + 两项独立授权
const hostStateMap = {};
function getHostState(host) {
  if (!hostStateMap[host]) hostStateMap[host] = { mode: 'mobile', ua: 'unknown', cookie: 'unauthorized' };
  return hostStateMap[host];
}

/* ==================== 工具函数 ==================== */
const $ = (sel) => document.querySelector(sel);

// 受信任的静态 SVG 注入（仅用于 ICONS 常量，不处理外部文本）
function setIcon(el, name) { el.innerHTML = ICONS[name]; }

// DOM 构建辅助：字符串一律作为 textContent，杜绝注入
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    el.append(c);
  }
  return el;
}

function clearEl(el) { while (el.firstChild) el.removeChild(el.firstChild); }

function hostOf(url) { try { return new URL(url).hostname; } catch { return ''; } }
function pathOf(url) {
  try { const p = new URL(url).pathname.replace(/^\/+|\/+$/g, ''); return p; } catch { return ''; }
}

function siteColorFor(host) {
  const entry = MOCK_WEB[host];
  if (entry) return entry.color;
  const site = state.sites.find((s) => hostOf(s.url) === host);
  if (site) return site.color;
  let hash = 0;
  for (const ch of host) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  return PALETTE[hash % PALETTE.length];
}

function resolvePage(url) {
  const host = hostOf(url);
  const entry = MOCK_WEB[host];
  if (entry) {
    const page = entry.pages[pathOf(url)] || entry.pages[''];
    return { title: page.title, blocks: page.blocks, color: entry.color, name: entry.name, spa: !!page.spa };
  }
  // 未内置的域名：渲染通用模拟页
  return {
    title: host, color: siteColorFor(host), name: host, spa: false,
    blocks: [
      { t: 'hero', text: host, sub: '外部站点（模拟渲染）' },
      { t: 'p', text: 'Demo 中不发起真实网络请求，此页为占位渲染，用于演示添加网址后的浏览形态。' },
      { t: 'link', text: '打开「每日见闻」演示站', to: 'https://daily.news' },
    ],
  };
}

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/* ==================== 视图切换 ==================== */
function showView(name) {
  state.view = name;
  $('#viewHome').hidden = name !== 'home';
  $('#viewBrowser').hidden = name !== 'browser';
  renderTopBar();
  renderNavBar();
  if (name === 'browser') {
    renderBrowser();
    // 进入浏览视图时焦点落在内容区（tabindex=-1），保证键盘 Tab 起点可预期
    $('#contentArea').focus({ preventScroll: true });
  }
}

/* ==================== 统一顶栏：网址栏 + 深浅主题翻转 ==================== */
function renderTopBar() {
  const icon = $('#urlBarIcon');
  const text = $('#urlBarText');
  const badge = $('#urlBarBadge');
  const bar = $('#urlBar');
  clearEl(icon);
  icon.className = 'urlbar-icon';
  icon.style.background = '';

  // 主页视图：产品图标 +「主页」
  if (state.view !== 'browser') {
    icon.classList.add('urlbar-product');
    setIcon(icon, 'globe');
    text.textContent = '主页';
    text.removeAttribute('title');
    badge.hidden = true;
    bar.setAttribute('aria-label', '当前位置：主页');
    return;
  }

  // 浏览视图：当前页 favicon + 标题（截断），需要时带「可能未同步」徽章
  const tab = activeTab();
  if (!tab) {
    text.textContent = '';
    text.removeAttribute('title');
    badge.hidden = true;
    bar.setAttribute('aria-label', '当前位置：无打开的标签页');
    return;
  }
  icon.classList.add('urlbar-fav');
  icon.style.background = tab.color;
  icon.textContent = tab.title.slice(0, 1);
  text.textContent = tab.title;
  text.title = tab.currentUrl;
  badge.hidden = !tab.addressMaybeStale;
  bar.setAttribute('aria-label', '当前页面：' + tab.title + (tab.addressMaybeStale ? '（地址可能未同步）' : ''));
}

// 深浅主题快速翻转：同一浏览器语言家族内 day↔night
function flipDayNight() {
  const target = state.theme.endsWith('-day')
    ? state.theme.replace(/-day$/, '-night')
    : state.theme.replace(/-night$/, '-day');
  setTheme(target);
  const card = THEME_CARDS.find((t) => t.id === target);
  toast('已切换到 ' + (card ? card.name : target));
}

/* ==================== 视图 A：主页渲染 ==================== */
function renderHome() {
  const grid = $('#siteGrid');
  clearEl(grid);
  $('#siteGridEmpty').hidden = state.sites.length > 0;
  for (const site of state.sites) grid.append(buildSiteItem(site));
}

function buildSiteItem(site) {
  const item = h('div', { class: 'site-item', role: 'listitem', tabindex: '0',
    'aria-label': site.name + '，Enter 打开' });

  const icon = h('div', { class: 'site-icon', text: site.name.slice(0, 1), 'aria-hidden': 'true' });
  icon.style.background = site.color;
  const name = h('span', { class: 'site-name', text: site.name });

  const moreBtn = h('button', { class: 'site-more', type: 'button',
    'aria-label': site.name + ' 的更多操作', 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
  setIcon(moreBtn, 'more');

  item.append(icon, name, moreBtn);

  // 打开站点：点击 / Enter（触摸点击主行为也是打开，子菜单走 ⋮ 按钮）
  const open = () => openSiteInNewTab(site);
  item.addEventListener('click', (e) => { if (!e.target.closest('.site-more')) open(); });
  item.addEventListener('keydown', (e) => {
    if (e.target !== item) return;
    if (e.key === 'Enter') { e.preventDefault(); open(); }
  });

  // 悬停/聚焦子菜单（打开 / 编辑名称 / 删除 / 移动·桌面切换 / 授权设置）
  const menuItems = () => [
    { icon: 'external', label: '打开', action: open },
    { icon: 'edit', label: '编辑名称', action: () => startRename(item, site, name) },
    { icon: 'trash', label: '删除', danger: true, action: () => {
      state.sites = state.sites.filter((s) => s.id !== site.id);
      renderHome();
      toast('已删除「' + site.name + '」');
    } },
    { icon: 'devices', label: '移动·桌面切换', action: () => {
      const hs = getHostState(hostOf(site.url));
      hs.mode = hs.mode === 'mobile' ? 'desktop' : 'mobile';
      toast('「' + site.name + '」已切换为' + (hs.mode === 'desktop' ? '桌面' : '移动') + '模式');
    } },
    { icon: 'shield', label: '授权设置', action: () => openSheet(buildSiteSettingsSheet(hostOf(site.url))) },
  ];
  attachMenuTrigger(item, moreBtn, menuItems);

  return item;
}

// 编辑名称：原地替换为输入框，Enter 提交 / Esc 取消
function startRename(item, site, nameEl) {
  const input = h('input', { class: 'site-rename', type: 'text', value: site.name,
    'aria-label': '编辑网站名称' });
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v) { site.name = v; toast('已重命名为「' + v + '」'); }
    renderHome();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

/* ==================== 添加网址 ==================== */
function handleAddUrl(e) {
  e.preventDefault();
  const input = $('#addUrlInput');
  const errEl = $('#addUrlError');
  const raw = input.value.trim();

  let url = null;
  try { url = new URL(raw); } catch { url = null; }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
    errEl.textContent = '网址无效：请输入以 http:// 或 https:// 开头的完整网址。';
    errEl.hidden = false;
    input.focus();
    return;
  }
  errEl.hidden = true;

  const site = {
    id: 'u' + state.nextSiteId++,
    name: url.hostname,
    url: url.origin,
    color: siteColorFor(url.hostname),
  };
  state.sites.push(site);
  input.value = '';
  renderHome();
  openSiteInNewTab(site);
}

/* ==================== 标签与导航逻辑 ==================== */
function activeTab() { return state.tabs.find((t) => t.id === state.activeTabId) || null; }

function openSiteInNewTab(site) {
  const tab = {
    id: 't' + state.nextTabId++,
    currentUrl: site.url,
    title: site.name,
    color: site.color,
    history: [site.url],
    hIndex: 0,
    loadState: 'ok',
    addressMaybeStale: false,
  };
  state.tabs.push(tab);
  state.activeTabId = tab.id;
  applyNavigation(tab, site.url, { push: false });
  showView('browser');
}

function navigate(tab, url) {
  tab.history.length = tab.hIndex + 1;
  tab.history.push(url);
  tab.hIndex++;
  applyNavigation(tab, url, { push: false });
  renderBrowser();
}

// 应用一次导航的结果：解析页面 / 命中 XFO 降级 / 更新标题与徽章
function applyNavigation(tab, url) {
  tab.currentUrl = url;
  const host = hostOf(url);
  if (host === BLOCKED_HOST) {
    // 失败的 URL 保留在历史中，但不覆盖此前成功条目的标题（ui-states.md §降级覆盖层）
    tab.loadState = 'blocked';
    tab.addressMaybeStale = false;
    return;
  }
  const page = resolvePage(url);
  tab.loadState = 'ok';
  tab.title = page.title;
  tab.color = page.color;
  // 市集详情页模拟 SPA pushState：地址可能未同步（演示徽章）
  tab.addressMaybeStale = !!page.spa;
}

function goBack() {
  const tab = activeTab();
  if (!tab || tab.hIndex <= 0) return;
  tab.hIndex--;
  applyNavigation(tab, tab.history[tab.hIndex]);
  renderBrowser();
}

function goForward() {
  const tab = activeTab();
  if (!tab || tab.hIndex >= tab.history.length - 1) return;
  tab.hIndex++;
  applyNavigation(tab, tab.history[tab.hIndex]);
  renderBrowser();
}

function activateTab(id) {
  state.activeTabId = id;
  renderBrowser();
}

function closeTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const closingActive = state.tabs[idx].id === state.activeTabId;
  state.tabs.splice(idx, 1);
  if (state.tabs.length === 0) {
    state.activeTabId = null;
    closeSheet();
    showView('home');
    return;
  }
  if (closingActive) state.activeTabId = state.tabs[Math.min(idx, state.tabs.length - 1)].id;
  renderBrowser();
}

function refreshTab(tab) {
  // 非活动标签的刷新：仅模拟解析（标题/徽章更新）；活动标签播放内容区重载微光
  applyNavigation(tab, tab.currentUrl);
  if (tab.id === state.activeTabId && state.view === 'browser') {
    const area = $('#contentArea');
    area.classList.add('reloading');
    setTimeout(() => { area.classList.remove('reloading'); renderContent(); }, 560);
    renderContent();
  }
  renderBrowser();
}

/* ==================== 视图 B：渲染（顶部无标签栏，标签管理收口到弹层） ==================== */
function renderBrowser() {
  renderContent();
  renderTopBar();
  renderNavBar();
}

// 标签的图标子菜单项（标签列表弹层行内使用）：刷新 / 复制网址 / 普通标签页打开 / 关闭
function sheetTabMenuItems(tab) {
  return [
    { icon: 'refresh', label: '刷新', action: () => refreshTab(tab) },
    { icon: 'copy', label: '复制网址', action: async () => {
      const ok = await copyText(tab.currentUrl);
      toast(ok ? '已复制网址' : '复制失败：' + tab.currentUrl);
    } },
    { icon: 'external', label: '普通标签页打开', action: () => toast('已模拟在浏览器普通标签页打开') },
    { icon: 'close', label: '关闭', danger: true, action: () => {
      closeTab(tab.id);
      if (isSheetOpen() && state.tabs.length > 0) reopenSheet(buildTabListSheet);
    } },
  ];
}

function renderNavBar() {
  const tab = activeTab();
  const inBrowser = state.view === 'browser';
  // 主页视图下后退/前进恒为禁用态（ui 规格：底栏常驻但导航键仅浏览视图可用）
  $('#navBack').disabled = !inBrowser || !tab || tab.hIndex <= 0;
  $('#navForward').disabled = !inBrowser || !tab || tab.hIndex >= tab.history.length - 1;
  // 主页按钮在主页视图呈当前态
  const homeBtn = $('#navHome');
  homeBtn.classList.toggle('on', !inBrowser);
  if (!inBrowser) homeBtn.setAttribute('aria-current', 'page');
  else homeBtn.removeAttribute('aria-current');
  $('#navTabCount').textContent = String(state.tabs.length);
  $('#navTabs').setAttribute('aria-label', '标签列表，共 ' + state.tabs.length + ' 个标签');
}

function renderContent() {
  const area = $('#contentArea');
  clearEl(area);
  const tab = activeTab();
  if (!tab) return;
  if (tab.loadState === 'blocked') { area.append(buildBlockedCover(tab)); return; }
  const page = resolvePage(tab.currentUrl);
  area.append(buildMockPage(tab, page));
}

/* ---------- 模拟网页渲染 ---------- */
function buildMockPage(tab, page) {
  const root = h('div', { class: 'mock-page' });
  const hs = getHostState(hostOf(tab.currentUrl));
  for (const block of page.blocks) {
    switch (block.t) {
      case 'hero': {
        const hero = h('div', { class: 'mock-hero' },
          h('h2', { text: block.text }),
          h('p', { text: block.sub || '' }));
        hero.style.background = page.color;
        root.append(hero);
        break;
      }
      case 'h2': root.append(h('h3', { text: block.text })); break;
      case 'p': root.append(h('p', { text: block.text })); break;
      case 'note': root.append(h('p', { class: 'mock-note', text: block.text })); break;
      case 'code': root.append(h('div', { class: 'mock-code', text: block.text })); break;
      case 'link':
      case 'ext': {
        const url = block.to || block.url;
        const a = h('a', { class: 'mock-link', href: url }, block.text);
        if (hostOf(url) !== hostOf(tab.currentUrl)) {
          a.append(h('span', { class: 'mock-link-sub', text: hostOf(url) }));
        }
        a.addEventListener('click', (e) => { e.preventDefault(); navigate(tab, url); });
        root.append(a);
        break;
      }
      case 'imgs': {
        const wrap = h('div', { class: 'mock-imgs' });
        block.items.forEach((item, i) => {
          const a = h('a', { class: 'mock-img', href: item.to, text: item.label });
          a.style.background = item.color || IMG_COLORS[i % IMG_COLORS.length];
          a.addEventListener('click', (e) => { e.preventDefault(); navigate(tab, item.to); });
          wrap.append(a);
        });
        root.append(wrap);
        break;
      }
      case 'bigimg': {
        const d = h('div', { class: 'mock-bigimg', text: block.label });
        d.style.background = block.color || page.color;
        root.append(d);
        break;
      }
      case 'cards': {
        const wrap = h('div', { class: 'mock-cards' });
        for (const item of block.items) {
          const a = h('a', { class: 'mock-card', href: item.to },
            h('b', { text: item.label }), h('span', { text: item.sub }));
          a.addEventListener('click', (e) => { e.preventDefault(); navigate(tab, item.to); });
          wrap.append(a);
        }
        root.append(wrap);
        break;
      }
    }
  }
  // 桌面模式提示（模拟：内容区顶部提示当前渲染模式）
  if (hs.mode === 'desktop') {
    root.prepend(h('p', { class: 'mock-note', text: '当前以桌面模式请求渲染（模拟）。' }));
  }
  return root;
}

/* ---------- XFO 降级覆盖层（ui-states.md §降级覆盖层：一句话说明 + 四个操作） ---------- */
function buildBlockedCover(tab) {
  const cover = h('div', { class: 'blocked-cover', role: 'alert' });
  const icon = h('div', { class: 'blocked-icon', 'aria-hidden': 'true' });
  setIcon(icon, 'warning');
  cover.append(icon);
  cover.append(h('h2', { class: 'blocked-title', text: '该网站拒绝被嵌入' }));
  cover.append(h('p', { class: 'blocked-desc',
    text: '目标站点通过 X-Frame-Options 禁止在 iframe 中显示，侧栏无法加载其内容。' }));
  cover.append(h('p', { class: 'blocked-url', text: tab.currentUrl }));

  const actions = h('div', { class: 'blocked-actions' });
  const retry = h('button', { class: 'btn btn-primary', type: 'button', text: '重试' });
  retry.addEventListener('click', () => {
    toast('已重新请求，站点仍拒绝嵌入（模拟）');
    refreshTab(tab);
  });
  const openCurrent = h('button', { class: 'btn btn-tonal', type: 'button', text: '在当前标签页打开' });
  openCurrent.addEventListener('click', () => toast('已模拟在浏览器当前标签页打开'));
  const openNew = h('button', { class: 'btn btn-tonal', type: 'button', text: '在新标签页打开' });
  openNew.addEventListener('click', () => toast('已模拟在浏览器新标签页打开'));
  const backHome = h('button', { class: 'btn btn-ghost', type: 'button', text: '返回主页' });
  backHome.addEventListener('click', () => { showView('home'); renderHome(); });
  actions.append(retry, openCurrent, openNew, backHome);
  cover.append(actions);
  return cover;
}

/* ==================== 悬停图标子菜单控制器 ====================
 * 打开：hover ~150ms 防抖 / 触摸点击切换 / 键盘聚焦后 Enter 或 Space
 * 关闭：Esc / 点击菜单外 / 触发某操作后；同一时刻只开一个（ui-states.md §FR-026~028）
 */
const iconMenu = {
  el: null, trigger: null, items: [], hoverTimer: 0, closeTimer: 0, open: false,
};

function initIconMenu() {
  iconMenu.el = $('#iconMenu');
  document.addEventListener('pointerdown', (e) => {
    if (!iconMenu.open) return;
    if (iconMenu.el.contains(e.target)) return;
    if (iconMenu.trigger && iconMenu.trigger.contains(e.target)) return;
    closeIconMenu();
  }, true);
}

function openIconMenu(trigger, items, opts = {}) {
  clearTimeout(iconMenu.hoverTimer);
  clearTimeout(iconMenu.closeTimer);

  // 清理上一个触发器的 ARIA 与悬停态
  if (iconMenu.trigger) {
    iconMenu.trigger.setAttribute('aria-expanded', 'false');
    const host = iconMenu.trigger.closest('.site-item, .tab, .tablist-row');
    if (host) host.classList.remove('menu-open');
  }

  iconMenu.trigger = trigger;
  iconMenu.items = items;
  trigger.setAttribute('aria-expanded', 'true');
  const hostEl = trigger.closest('.site-item, .tab, .tablist-row');
  if (hostEl) hostEl.classList.add('menu-open');

  const menu = iconMenu.el;
  clearEl(menu);
  items.forEach((item, i) => {
    const btn = h('button', { class: 'menu-btn' + (item.danger ? ' danger' : ''),
      type: 'button', role: 'menuitem', 'aria-label': item.label, title: item.label });
    setIcon(btn, item.icon);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeIconMenu();
      item.action();
    });
    btn.addEventListener('keydown', (e) => {
      const btns = [...menu.querySelectorAll('.menu-btn')];
      const idx = btns.indexOf(e.currentTarget);
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        (btns[idx + 1] || btns[0]).focus();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        (btns[idx - 1] || btns[btns.length - 1]).focus();
      } else if (e.key === 'Home') { e.preventDefault(); btns[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); btns[btns.length - 1].focus(); }
    });
    menu.append(btn);
    if (i === 0 && opts.focusFirst) setTimeout(() => btn.focus(), 0);
  });

  menu.hidden = false;
  iconMenu.open = true;
  positionIconMenu(trigger, hostEl || trigger);

  // 悬停在菜单上时取消关闭计时
  menu.onmouseenter = () => clearTimeout(iconMenu.closeTimer);
  menu.onmouseleave = () => scheduleCloseIconMenu(220);
}

function positionIconMenu(trigger, anchorEl) {
  const menu = iconMenu.el;
  const sidebarRect = $('#sidebar').getBoundingClientRect();
  const r = anchorEl.getBoundingClientRect();
  menu.style.visibility = 'hidden';
  menu.style.left = '0px';
  menu.style.top = '0px';
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;

  let left = r.left - sidebarRect.left + r.width / 2 - mw / 2;
  left = Math.max(6, Math.min(left, sidebarRect.width - mw - 6));

  let top = r.bottom - sidebarRect.top + 6;
  if (top + mh > sidebarRect.height - 6) top = r.top - sidebarRect.top - mh - 6;

  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  menu.style.visibility = '';
}

function closeIconMenu() {
  clearTimeout(iconMenu.hoverTimer);
  clearTimeout(iconMenu.closeTimer);
  if (iconMenu.trigger) {
    iconMenu.trigger.setAttribute('aria-expanded', 'false');
    const host = iconMenu.trigger.closest('.site-item, .tab, .tablist-row');
    if (host) host.classList.remove('menu-open');
  }
  iconMenu.el.hidden = true;
  iconMenu.open = false;
  iconMenu.trigger = null;
}

function scheduleCloseIconMenu(delay) {
  clearTimeout(iconMenu.closeTimer);
  iconMenu.closeTimer = setTimeout(closeIconMenu, delay);
}

// 为触发器挂接三类打开方式；anchor 用于悬停（整个条目/标签），btn 用于点击与键盘。
// 当 anchor === btn（标签项）时，点击/Enter 保留给主行为（激活标签），菜单只走悬停与 Space。
function attachMenuTrigger(anchor, btn, itemsFn) {
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');

  anchor.addEventListener('mouseenter', () => {
    clearTimeout(iconMenu.closeTimer);
    clearTimeout(iconMenu.hoverTimer);
    iconMenu.hoverTimer = setTimeout(() => {
      // 触摸端 tap 会伴随模拟 mouseenter，若锚点已因主行为（打开站点/切换标签）被移除则不再弹菜单
      if (anchor.isConnected) openIconMenu(btn, itemsFn());
    }, 150);
  });
  anchor.addEventListener('mouseleave', () => {
    clearTimeout(iconMenu.hoverTimer);
    scheduleCloseIconMenu(220);
  });
  if (btn === anchor) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (iconMenu.open && iconMenu.trigger === btn) closeIconMenu();
    else openIconMenu(btn, itemsFn());
  });
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      openIconMenu(btn, itemsFn(), { focusFirst: true });
    }
  });
}

/* ==================== 底部弹层控制器 ==================== */
let sheetOpener = null;

function openSheet(builder) {
  closeIconMenu();
  const overlay = $('#sheetOverlay');
  const sheet = $('#sheet');
  sheetOpener = document.activeElement;
  clearEl(sheet);
  sheet.append(h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }));
  sheet.append(builder());
  wireSheetTitle(sheet);
  overlay.hidden = false;
  sheet.hidden = false;
  requestAnimationFrame(() => {
    overlay.classList.add('open');
    sheet.classList.add('open');
  });
  const firstBtn = sheet.querySelector('button:not([disabled])');
  if (firstBtn) setTimeout(() => firstBtn.focus(), 80);
}

// 为弹层挂接可访问名称（引用面板内标题）
function wireSheetTitle(sheet) {
  const title = sheet.querySelector('.sheet-title');
  if (title) {
    title.id = 'sheetTitle';
    sheet.setAttribute('aria-labelledby', 'sheetTitle');
  } else {
    sheet.removeAttribute('aria-labelledby');
  }
}

function closeSheet() {
  const overlay = $('#sheetOverlay');
  const sheet = $('#sheet');
  if (sheet.hidden) return;
  overlay.classList.remove('open');
  sheet.classList.remove('open');
  setTimeout(() => { overlay.hidden = true; sheet.hidden = true; }, 220);
  if (sheetOpener && document.contains(sheetOpener)) sheetOpener.focus();
  sheetOpener = null;
}

function isSheetOpen() { return !$('#sheet').hidden; }

/* ---------- 弹层 1：标签列表 ---------- */
function buildTabListSheet() {
  const wrap = h('div', {});
  wrap.append(h('h2', { class: 'sheet-title', text: '标签列表' }));
  const list = h('div', { class: 'tablist' });
  for (const tab of state.tabs) {
    const row = h('div', { class: 'tablist-row' + (tab.id === state.activeTabId ? ' active' : ''),
      role: 'button', tabindex: '0', 'aria-label': '切换到标签「' + tab.title + '」' });
    const fav = h('span', { class: 'tab-favicon', text: tab.title.slice(0, 1), 'aria-hidden': 'true' });
    fav.style.background = tab.color;
    const main = h('span', { class: 'tablist-main' },
      h('span', { class: 'tablist-title', text: tab.title }),
      h('span', { class: 'tablist-url', text: tab.currentUrl }));
    // 行内图标子菜单触发钮（刷新 / 复制网址 / 普通打开 / 关闭），规格与悬停子菜单一致
    const moreBtn = h('button', { class: 'tablist-more', type: 'button',
      'aria-label': '标签「' + tab.title + '」的更多操作', 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
    setIcon(moreBtn, 'more');
    const closeBtn = h('button', { class: 'tablist-close', type: 'button',
      'aria-label': '关闭标签「' + tab.title + '」' });
    setIcon(closeBtn, 'close');
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab.id);
      if (isSheetOpen() && state.tabs.length > 0) reopenSheet(buildTabListSheet);
    });
    row.append(fav, main, moreBtn, closeBtn);
    attachMenuTrigger(row, moreBtn, () => sheetTabMenuItems(tab));
    const activate = () => { activateTab(tab.id); closeSheet(); };
    row.addEventListener('click', (e) => { if (!e.target.closest('button')) activate(); });
    row.addEventListener('keydown', (e) => {
      if (e.target !== row) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });
    list.append(row);
  }
  wrap.append(list);

  const newBtn = h('button', { class: 'tablist-new', type: 'button', 'aria-label': '新建标签（回主页选网站）' });
  setIcon(newBtn, 'plus');
  newBtn.addEventListener('click', () => {
    closeSheet();
    showView('home');
    renderHome();
  });
  wrap.append(newBtn);
  return wrap;
}

// 弹层内容原地刷新（保留打开态，不重新播放动画）
function reopenSheet(builder) {
  const sheet = $('#sheet');
  clearEl(sheet);
  sheet.append(h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }));
  sheet.append(builder());
  wireSheetTitle(sheet);
}

/* ---------- 弹层 2：九宫格菜单 ---------- */
function buildGridMenuSheet() {
  const wrap = h('div', {});
  const tab = activeTab();
  const grid = h('div', { class: 'menu-grid' });

  const noTab = !tab; // 无活动标签时（如主页视图打开菜单），依赖当前标签的格子禁用
  const cells = [
    { icon: 'moon', label: '夜间模式', action: () => reopenSheet(buildThemeSheet) },
    { icon: 'grid', label: '网站列表', action: () => { closeSheet(); showView('home'); renderHome(); } },
    { icon: 'history', label: '历史', action: () => reopenSheet(buildHistorySheet) },
    { icon: 'copy', label: '复制网址', disabled: noTab ? 'noTab' : false, action: async () => {
      closeSheet();
      if (!tab) return;
      const ok = await copyText(tab.currentUrl);
      toast(ok ? '已复制网址' : '复制失败：' + tab.currentUrl);
    } },
    { icon: 'external', label: '普通打开', disabled: noTab ? 'noTab' : false, action: () => { closeSheet(); toast('已模拟在浏览器普通标签页打开'); } },
    { icon: 'share', label: '分享', disabled: true },
    { icon: 'bookmark', label: '添加书签', disabled: noTab ? 'noTab' : false, action: () => {
      closeSheet();
      if (!tab) return;
      const host = hostOf(tab.currentUrl);
      if (state.sites.some((s) => hostOf(s.url) === host)) { toast('该网站已在网站列表中'); return; }
      state.sites.push({ id: 'u' + state.nextSiteId++, name: tab.title, url: new URL(tab.currentUrl).origin, color: siteColorFor(host) });
      renderHome();
      toast('已保存到网站列表');
    } },
    { icon: 'devices', label: '电脑模式', disabled: noTab ? 'noTab' : false, on: tab ? getHostState(hostOf(tab.currentUrl)).mode === 'desktop' : false,
      action: () => { if (tab) { closeSheet(); toggleDesktopMode(hostOf(tab.currentUrl)); } } },
    { icon: 'shield', label: '站点设置', disabled: noTab ? 'noTab' : false, action: () => {
      if (!tab) return;
      reopenSheet(buildSiteSettingsSheet(hostOf(tab.currentUrl)));
    } },
    { icon: 'close', label: '关闭当前', disabled: noTab ? 'noTab' : false, action: () => { closeSheet(); if (tab) closeTab(tab.id); } },
  ];

  for (const cell of cells) {
    const disabledNote = cell.disabled === 'noTab' ? '（无打开的标签页）' : '（暂未开放）';
    const btn = h('button', { class: 'menu-cell' + (cell.on ? ' on' : ''), type: 'button',
      disabled: cell.disabled ? true : false,
      'aria-label': cell.label + (cell.disabled ? disabledNote : '') });
    const iconWrap = h('span', { class: 'cell-icon', 'aria-hidden': 'true' });
    setIcon(iconWrap, cell.icon);
    btn.append(iconWrap, h('span', { class: 'cell-label', text: cell.label }));
    if (!cell.disabled) btn.addEventListener('click', cell.action);
    grid.append(btn);
  }
  wrap.append(grid);

  // 底部页点指示（单页，首点高亮）
  const dots = h('div', { class: 'menu-dots', 'aria-hidden': 'true' },
    h('i', { class: 'on' }), h('i', {}));
  wrap.append(dots);
  return wrap;
}

/* ---------- 弹层 3：主题选择 ---------- */
function buildThemeSheet() {
  const wrap = h('div', {});
  wrap.append(h('h2', { class: 'sheet-title', text: '主题与夜间模式' }));
  const grid = h('div', { class: 'theme-grid' });
  for (const t of THEME_CARDS) {
    const current = t.id === state.theme;
    const card = h('button', { class: 'theme-card' + (current ? ' current' : ''), type: 'button',
      'aria-label': '切换到 ' + t.name + (current ? '（当前主题）' : ''),
      'aria-pressed': current ? 'true' : 'false' });

    const preview = h('div', { class: 'theme-preview', 'aria-hidden': 'true' });
    const strip = h('div', { class: 'tp-strip' });
    strip.style.background = t.surface;
    for (let i = 0; i < 3; i++) { const d = h('i', {}); d.style.background = t.text; d.style.opacity = '.35'; strip.append(d); }
    const body = h('div', { class: 'tp-body' });
    body.style.background = t.bg;
    const pill = h('span', { class: 'tp-pill' });
    pill.style.background = t.primary;
    const lines = h('span', { class: 'tp-text' });
    for (const w of ['86%', '62%']) { const l = h('i', {}); l.style.background = t.text; l.style.opacity = '.3'; l.style.width = w; lines.append(l); }
    body.append(pill, lines);
    preview.append(strip, body);
    card.append(preview);
    card.append(h('span', { class: 'tp-name', text: t.name }));
    if (current) {
      const check = h('span', { class: 'theme-check', 'aria-hidden': 'true' });
      setIcon(check, 'check');
      card.append(check);
    }
    card.addEventListener('click', () => {
      setTheme(t.id);
      reopenSheet(buildThemeSheet);
      toast('已切换到 ' + t.name);
    });
    grid.append(card);
  }
  wrap.append(grid);
  return wrap;
}

function setTheme(id) {
  state.theme = id;
  document.documentElement.dataset.theme = id;
  const card = THEME_CARDS.find((t) => t.id === id);
  $('#stageThemeName').textContent = card ? card.name : id;
  // 深浅翻转按钮：图标随当前模式（白天示月、夜间示日）
  const isNight = id.endsWith('-night');
  const flipBtn = $('#themeFlipBtn');
  setIcon(flipBtn, isNight ? 'sun' : 'moon');
  flipBtn.setAttribute('aria-label', isNight ? '切换到浅色主题' : '切换到深色主题');
}

/* ---------- 弹层 4：站点设置面板 ---------- */
function buildSiteSettingsSheet(host) {
  return function build() {
    const hs = getHostState(host);
    const tab = activeTab();
    const site = state.sites.find((s) => hostOf(s.url) === host);
    const siteName = site ? site.name : (MOCK_WEB[host] ? MOCK_WEB[host].name : host);
    const color = siteColorFor(host);

    const wrap = h('div', {});
    wrap.append(h('h2', { class: 'sheet-title', text: '站点设置' }));

    const head = h('div', { class: 'settings-head' });
    const fav = h('span', { class: 'tab-favicon', text: siteName.slice(0, 1), 'aria-hidden': 'true' });
    fav.style.background = color;
    head.append(fav, h('div', {},
      h('div', { class: 'settings-site', text: siteName }),
      h('div', { class: 'settings-host', text: host })));
    wrap.append(head);

    const rows = h('div', { class: 'settings-rows' });

    // 开关 1：移动/桌面模式（开启桌面模式需权限）
    rows.append(buildSwitchRow({
      label: '桌面模式',
      sub: hs.mode === 'desktop' ? '当前以桌面版页面请求' : '当前以移动版页面请求',
      checked: hs.mode === 'desktop',
      onToggle: (on) => toggleDesktopMode(host, on, true),
    }));

    // 开关 2：真实移动 UA（独立权限）
    rows.append(buildSwitchRow({
      label: '真实移动 UA',
      sub: '通过 declarativeNetRequest 修改请求头',
      checked: hs.ua === 'granted',
      onToggle: async (on) => {
        if (!on) { hs.ua = 'unknown'; reopenSheet(buildSiteSettingsSheet(host)); return; }
        const ok = await requestPermission({
          title: '权限申请',
          desc: '「' + siteName + '」请求「真实移动 UA」权限：修改发往该站点的 User-Agent 请求头（declarativeNetRequest）。',
        });
        hs.ua = ok ? 'granted' : 'denied';
        if (!ok) toast('未授权，已使用降级模式');
        reopenSheet(buildSiteSettingsSheet(host));
      },
    }));

    // 开关 3：登录状态复用（Cookie，独立权限）
    rows.append(buildSwitchRow({
      label: '登录状态复用',
      sub: '读取该站点 Cookie 以复用浏览器登录会话',
      checked: hs.cookie === 'granted',
      onToggle: async (on) => {
        if (!on) { hs.cookie = 'unauthorized'; reopenSheet(buildSiteSettingsSheet(host)); return; }
        const ok = await requestPermission({
          title: '权限申请',
          desc: '「' + siteName + '」请求「登录状态复用」权限：读取该站点的 Cookie（cookies）。',
        });
        hs.cookie = ok ? 'granted' : 'denied';
        if (!ok) toast('未授权，已使用降级模式');
        reopenSheet(buildSiteSettingsSheet(host));
      },
    }));
    wrap.append(rows);

    // 能力状态徽章区（文案遵循 ui-states.md §FR-029）
    const badgeZone = h('div', { class: 'settings-badges' });
    badgeZone.append(h('p', { class: 'settings-badges-title', text: '能力状态' }));
    const row = h('div', { class: 'badge-row' });

    let uaBadge;
    if (hs.ua === 'granted') uaBadge = { text: 'UA：真实移动 UA', cls: 'ok' };
    else if (hs.ua === 'denied') uaBadge = { text: 'UA：已降级为移动视口', cls: 'warn' };
    else uaBadge = { text: 'UA：未知', cls: 'gray' };
    row.append(h('span', { class: 'badge ' + uaBadge.cls, text: uaBadge.text }));

    const cookieBadge = hs.cookie === 'granted'
      ? { text: 'Cookie：已检测到会话', cls: 'ok' }
      : { text: 'Cookie：未授权', cls: 'gray' };
    row.append(h('span', { class: 'badge ' + cookieBadge.cls, text: cookieBadge.text }));

    const navBadge = (tab && tab.addressMaybeStale)
      ? { text: '导航：可能未同步', cls: 'gray' }
      : { text: '导航：可追踪', cls: 'ok' };
    row.append(h('span', { class: 'badge ' + navBadge.cls, text: navBadge.text }));

    badgeZone.append(row);
    wrap.append(badgeZone);
    return wrap;
  };
}

function buildSwitchRow({ label, sub, checked, onToggle }) {
  const row = h('div', { class: 'settings-row' });
  const main = h('div', { class: 'settings-row-main' },
    h('span', { class: 'settings-row-label', text: label }),
    h('span', { class: 'settings-row-sub', text: sub }));
  const sw = h('button', { class: 'switch', type: 'button', role: 'switch',
    'aria-checked': checked ? 'true' : 'false', 'aria-label': label });
  sw.addEventListener('click', () => onToggle(!checked));
  row.append(main, sw);
  return row;
}

// 电脑模式切换：权限申请 → 允许则切换并模拟重载；拒绝则回弹并提示
// host 维度生效；fromSettings=true 时（开关来自站点设置面板）切换后重建面板内容
async function toggleDesktopMode(host, targetOn, fromSettings) {
  const hs = getHostState(host);
  const wantDesktop = targetOn !== undefined ? targetOn : hs.mode !== 'desktop';
  const at = activeTab();
  const affectedTab = at && hostOf(at.currentUrl) === host ? at : null;
  const rebuild = () => { if (fromSettings && isSheetOpen()) reopenSheet(buildSiteSettingsSheet(host)); };
  if (!wantDesktop) {
    hs.mode = 'mobile';
    toast('已切换为移动模式' + (affectedTab ? '，正在重新加载…' : ''));
    rebuild();
    if (affectedTab) refreshTab(affectedTab);
    return;
  }
  const ok = await requestPermission({
    title: '权限申请',
    desc: '请求以桌面模式浏览该站点：将发送桌面版版面请求（模拟权限）。',
  });
  if (ok) {
    hs.mode = 'desktop';
    toast('已切换为桌面模式' + (affectedTab ? '，正在重新加载…' : ''));
    rebuild();
    if (affectedTab) refreshTab(affectedTab);
  } else {
    toast('未授权，已使用降级模式');
    rebuild();
  }
}

/* ---------- 弹层 5：历史 ---------- */
function buildHistorySheet() {
  const wrap = h('div', {});
  wrap.append(h('h2', { class: 'sheet-title', text: '历史' }));
  const list = h('div', { class: 'history-list' });

  const entries = [];
  for (const tab of state.tabs) {
    tab.history.forEach((url, i) => {
      entries.push({ url, tab, active: i === tab.hIndex });
    });
  }
  entries.reverse();

  if (entries.length === 0) {
    list.append(h('p', { class: 'history-empty', text: '暂无历史记录。' }));
  }
  const now = new Date();
  for (const entry of entries.slice(0, 24)) {
    const page = resolvePage(entry.url);
    const time = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
    const row = h('button', { class: 'history-row', type: 'button',
      'aria-label': '打开 ' + page.title });
    const fav = h('span', { class: 'tab-favicon', text: page.title.slice(0, 1), 'aria-hidden': 'true' });
    fav.style.background = page.color;
    row.append(h('span', { class: 'history-time', text: time }), fav,
      h('span', { class: 'tablist-main' },
        h('span', { class: 'tablist-title', text: page.title + (entry.active ? '（当前）' : '') }),
        h('span', { class: 'tablist-url', text: entry.url })));
    row.addEventListener('click', () => {
      const tab = activeTab();
      closeSheet();
      if (tab) navigate(tab, entry.url);
    });
    list.append(row);
  }
  wrap.append(list);
  return wrap;
}

/* ==================== 模拟浏览器权限申请对话框 ==================== */
function requestPermission({ title, desc }) {
  return new Promise((resolve) => {
    closeIconMenu();
    const overlay = $('#permOverlay');
    $('#permTitle').textContent = title;
    $('#permDesc').textContent = desc;
    overlay.hidden = false;
    const allowBtn = $('#permAllow');
    const denyBtn = $('#permDeny');
    denyBtn.focus();

    const done = (ok) => {
      overlay.hidden = true;
      allowBtn.removeEventListener('click', onAllow);
      denyBtn.removeEventListener('click', onDeny);
      resolve(ok);
    };
    const onAllow = () => done(true);
    const onDeny = () => done(false);
    allowBtn.addEventListener('click', onAllow);
    denyBtn.addEventListener('click', onDeny);
  });
}

/* ==================== 全局键盘与初始化 ==================== */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#permOverlay').hidden) { $('#permDeny').click(); return; }
  if (iconMenu.open) {
    const trigger = iconMenu.trigger;
    closeIconMenu();
    if (trigger && trigger.isConnected) trigger.focus();
    return;
  }
  if (isSheetOpen()) closeSheet();
});

$('#sheetOverlay').addEventListener('click', closeSheet);

function init() {
  // 静态图标
  setIcon($('#addUrlSubmit'), 'plus');
  setIcon($('#brandLogo'), 'globe');
  setIcon($('#navBack'), 'back');
  setIcon($('#navForward'), 'forward');
  setIcon($('#navHome'), 'home');
  setIcon($('#navMenu'), 'menu');

  initIconMenu();

  // 顶栏：深浅主题快速翻转（完整六主题选择走九宫格「夜间模式」弹层）
  $('#themeFlipBtn').addEventListener('click', flipDayNight);
  setTheme(state.theme);

  // 视图 A
  $('#addUrlForm').addEventListener('submit', handleAddUrl);
  $('#addUrlInput').addEventListener('input', () => { $('#addUrlError').hidden = true; });

  // 底部导航（双视图常驻）
  $('#navBack').addEventListener('click', goBack);
  $('#navForward').addEventListener('click', goForward);
  $('#navHome').addEventListener('click', () => { showView('home'); renderHome(); });
  $('#navTabs').addEventListener('click', () => openSheet(buildTabListSheet));
  $('#navMenu').addEventListener('click', () => openSheet(buildGridMenuSheet));

  renderHome();
  showView('home');
}

init();
