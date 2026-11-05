/**
 * 多站点配置读取与 URL 构建（ian 2026-09-23 要求：域名与页面路径不写死进用例，多网站复用）
 *
 * - 站点档案：config/sites.json（每站一份 pc/wap/boss 完整路径映射）
 * - 选站点：env TEST_SITE_ID（缺省取第一个 enabled 站点）；.env 已配 TEST_SITE_IDS 时取其第一个
 * - 临时换域名（不改 json）：env SITE_PC_BASE_URL / SITE_WAP_BASE_URL / SITE_BOSS_BASE_URL
 *
 * 用法（用例内禁止出现任何 https://域名 或页面路径字面量）：
 *   import { site, pcUrl, bossUrl, bossApi, wapEntry, wapRoute, offerMarket } from './helpers/site';
 *   await page.goto(pcUrl('warehouse'));          // https://demo.example.com/zh-cn/dashboard/warehouse
 *   await page.goto(bossUrl('packagePicking'));   // https://boss.demo.example.com/3hxSz0YT/warehouse/package-picking
 *   await fetch(bossApi('packageLists'), ...)     // https://boss.demo.example.com/api/admin/v1/waybill/package/lists
 */
import { sites } from '../../src/config';
import type { SiteConfig } from '../../src/config';

const envOr = (v: string | undefined, fallback: string): string =>
  v && v.trim() ? v.trim() : fallback;

// ---------- 环节地址临时覆盖（ian 2026-10-20：发起页点进用例环节修改的地址，仅当次 Campaign 生效） ----------
// runner 注入 env SITE_PATH_OVERRIDES（JSON）：{"pc":{"login":"/..."}, "wap":{...}, "boss":{"weighIn":"/warehouse/goods-check"}, "bossApi":{...}}
// 优先级：当次覆盖 > sites.json 档案默认。不合法 JSON 整体忽略（回退档案），不阻断执行。
type PathOverrideScope = 'pc' | 'wap' | 'boss' | 'bossApi';
type PathOverrides = Partial<Record<PathOverrideScope, Record<string, string>>>;

function loadPathOverrides(): PathOverrides {
  const raw = (process.env.SITE_PATH_OVERRIDES || '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch {
    console.error(`[site-config] SITE_PATH_OVERRIDES 不是合法 JSON，已忽略（按档案默认执行）: ${raw.slice(0, 200)}`);
    return {};
  }
}
export const pathOverrides: PathOverrides = loadPathOverrides();

/** 单键覆盖：scope+key 命中且非空 → 覆盖值；否则档案默认 */
function ovPath(scope: PathOverrideScope, key: string, fallback: string | undefined): string | undefined {
  const v = (pathOverrides[scope] || {})[key];
  if (typeof v === 'string' && v.trim()) return v.trim();
  return fallback;
}

if (Object.keys(pathOverrides).length) {
  const flat = (Object.keys(pathOverrides) as PathOverrideScope[])
    .flatMap((s) => Object.entries(pathOverrides[s] || {}).map(([k, v]) => `${s}.${k}=${v}`))
    .join(', ');
  console.log(`[site-config] 环节地址覆盖生效（仅当次）: ${flat}`);
}

/** 选站点：TEST_SITE_ID > TEST_SITE_IDS 第一个 > 第一个 enabled 站点 */
function pickSite(): SiteConfig {
  const explicit = (process.env.TEST_SITE_ID || '').trim();
  if (explicit) {
    const found = sites.find((s) => s.id === explicit);
    if (!found) {
      throw new Error(`TEST_SITE_ID=${explicit} 未匹配到 config/sites.json 中的站点（可选：${sites.map((s) => s.id).join(', ')}）`);
    }
    return found;
  }
  const idsEnv = (process.env.TEST_SITE_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (idsEnv.length) {
    const found = sites.find((s) => s.id === idsEnv[0]);
    if (found) return found;
  }
  return sites[0];
}

export const site: SiteConfig = pickSite();

// ---------- PC 前台 ----------
// ian 2026-09-24 规约：网址完全用前台输入/站点档案保存的值原样拼接，不再自动插入 localePrefix 等派生前缀。
// 页面路径（含 /zh-cn 前缀）直接存在档案 pc.paths 里，base + path 原样相接。
const pcBase = envOr(process.env.SITE_PC_BASE_URL, site.pc?.baseURL || site.baseURL);
const pcPaths = site.pc?.paths ?? {};

/** PC 前台页面完整 URL：pcUrl('warehouse') -> {pc.baseURL}{paths.warehouse}（档案 paths 为完整路径，如 /zh-cn/dashboard/warehouse） */
export function pcUrl(key: string): string {
  const p = ovPath('pc', key, pcPaths[key]);
  if (p === undefined) throw new Error(`config/sites.json[${site.id}] 缺少 pc.paths.${key}，请先在站点档案中补齐`);
  return `${pcBase}${p === '/' ? '' : p}`;
}
export const pcHome = `${pcBase}${pcPaths['home'] && pcPaths['home'] !== '/' ? pcPaths['home'] : ''}`;

// ---------- WAP（uni-app hash 路由） ----------
// ian 2026-09-24 规约：WAP base 原样使用前台输入值（如 https://域名/wap），不自动剥除也不自动补 /wap；
// hash 入口默认仅 '#'（旧档案 '/wap#' 的 /wap 前缀同样不自动拼，需要时写进 base 输入值）。
const wapBase = envOr(process.env.SITE_WAP_BASE_URL, site.wap?.baseURL || pcBase);
/** WAP hash 入口段，默认 '#'；路径前缀（如 /wap）由 base 输入值自带 */
export const wapEntry = site.wap?.entry ?? '#';
const wapPaths = site.wap?.paths ?? {};
/** WAP 站点 base（legacy 用例直用：base 原样，不派生前缀） */
export const wapSiteBase = wapBase;

/** WAP hash 路由（含前导 / 与查询串），如 wapRoute('login') -> '/pages/user/login' */
export function wapRoute(key: string): string {
  const r = ovPath('wap', key, wapPaths[key]);
  if (r === undefined) throw new Error(`config/sites.json[${site.id}] 缺少 wap.paths.${key}，请先在站点档案中补齐`);
  return r;
}
/** WAP 深链完整 URL：wapUrl('login') -> {wapBase}{entry}/pages/user/login（如 https://…/wap#/pages/user/login） */
export function wapUrl(key: string): string {
  return `${wapBase}${wapEntry}${wapRoute(key)}`;
}
/** WAP 首页（空 hash 路由） */
export const wapHome = `${wapBase}${wapEntry}/`;

// ---------- 后台（boss） ----------
const bossBase = envOr(process.env.SITE_BOSS_BASE_URL, site.boss?.baseURL || '');
// SITE_BOSS_ENTRY：平台多站点（不同安全入口段，如 shop-v2 /xDDQtbeo）覆盖 sites.json 默认 entry
const bossEntry = envOr(process.env.SITE_BOSS_ENTRY, site.boss?.entry ?? '');
const bossPaths = site.boss?.paths ?? {};
const bossApiPrefix = site.boss?.apiPrefix ?? '/api/admin/v1';
const bossApiMap = site.boss?.api ?? {};

/** 后台根（域名+安全入口段）：bossRoot -> https://boss.xxx.com/3hxSz0YT */
export const bossRoot = `${bossBase}${bossEntry}`;

/** 后台页面完整 URL：bossUrl('package') -> {boss.baseURL}{entry}{paths.package} */
export function bossUrl(key: string): string {
  const p = ovPath('boss', key, bossPaths[key]);
  if (p === undefined) throw new Error(`config/sites.json[${site.id}] 缺少 boss.paths.${key}，请先在站点档案中补齐`);
  return `${bossBase}${bossEntry}${p}`;
}

/** 后台 API 完整 URL（不带安全入口段）：bossApi('packageLists') -> {boss.baseURL}{apiPrefix}/{api.packageLists} */
export function bossApi(key: string): string {
  const p = ovPath('bossApi', key, bossApiMap[key]);
  if (p === undefined) throw new Error(`config/sites.json[${site.id}] 缺少 boss.api.${key}，请先在站点档案中补齐`);
  return `${bossBase}${bossApiPrefix}/${p.replace(/^\//, '')}`;
}

/** 后台 API 根（域名+apiPrefix，不含 entry），供脚本按相对路径直调任意端点 */
export const bossApiRoot = `${bossBase}${bossApiPrefix}`;

/**
 * 固定前台币种为 USD 的 localStorage 注入脚本（2026-09-24 ian 报告 F2 误报修复）：
 * 站点给新会话分配的默认币种不稳定（实测各轮 USD/CNY/JPY 随机），非 USD 时价格渲染 ¥/JPY 符号，
 * 导致写死 $ 的价格断言误报「详情页未渲染价格」。登录后立即 evaluate 注入，随后的页面加载全部生效。
 * 注意：evaluate 传字符串表达式；各金额断言已另加 [$¥￥€£] 兜底（即便注入失效也不误报成"未渲染"）。
 */
export const SET_CURRENCY_USD = `(() => {
  try {
    // 2026-09-28 修复：站点默认币种已不止 USD/CNY/JPY，新会话可能分配 RUB 等；
    // 旧版整表覆盖 currencyData 会丢掉站点原始币种（如 RUB）导致首页初始化异常渲染成空壳。
    // 现改为：优先复用站点原币种表里的 USD 项；原表缺失时才用内置兜底表。
    const FALLBACK_USD = {"id":2,"title":"美元","code":"USD","code_text":"美元","symbol_left":"$","symbol_right":"","decimal_place":"2","value":0.148};
    const FALLBACK_ALL = {"CNY":{"id":1,"title":"人民币","code":"CNY","code_text":"人民币","symbol_left":"¥","symbol_right":"","decimal_place":"2","value":1},"USD":FALLBACK_USD,"AED":{"id":3,"title":"阿联酋迪拉姆","code":"AED","code_text":"阿联酋迪拉姆","symbol_left":"د.إ","symbol_right":"","decimal_place":"2","value":0.545}};
    let usd = null;
    try {
      const raw = localStorage.getItem('currencyData');
      if (raw) {
        const list = JSON.parse(raw);
        const arr = Array.isArray(list) ? list : Object.keys(list || {}).map((k) => list[k]);
        usd = arr.find((c) => c && c.code === 'USD') || null;
      }
    } catch (e) {}
    if (!usd) {
      usd = FALLBACK_USD;
      localStorage.setItem('currencyData', JSON.stringify(FALLBACK_ALL));
    }
    localStorage.setItem('selectedCurrency', 'USD');
    localStorage.setItem('currencySymbol', (usd.symbol_left || '$'));
    localStorage.setItem('currentCurrencyData', JSON.stringify(usd));
    localStorage.setItem('currentExchangeRate', String(usd.value || 0.148));
  } catch (e) {}
})()`;

// ---------- 商品源 ----------
/** 供应链商品详情页源链接 */
export function offerMarket(iid: string): string {
  const origin = site.testData.sourceSiteMarket || 'https://detail.market.example.com';
  return `${origin}/offer/${iid}.html`;
}

// ---------- 测试用例库（3008 平台 /library/，2026-10-08 ian） ----------
// runner 注入 env：LIB_KEYWORDS / LIB_IMAGES / LIB_LINKS（'|' 分隔，最多 3 条；
// Campaign 发起页勾选=指定条目，未勾=随机抽取）。用例侧优先级：手动单值 env > LIB_* 池 > 站点档案默认。
export function libPool(kind: 'KEYWORDS' | 'IMAGES' | 'LINKS', fallback: string[] = []): string[] {
  const v = process.env[`LIB_${kind}`] || '';
  const pool = v.split('|').map((x) => x.trim()).filter(Boolean);
  return pool.length ? pool : fallback;
}

/** 从 LIB_LINKS/其他文本抽 market offer num_iid（链接形态 .../offer/<数字>.html 或纯数字）；抽不到返回 fallback。
 * 2026-10-09 ian：发起页勾选（LIB_LINKS_MODE=picked）却抽不到编号时【直接抛错】——
 * 全链是真实下单链路，静默回退站点档案=用户勾了 A 商品却下单 B，比失败更不可接受；
 * 错误消息指明勾了什么、正确格式是什么。随机抽取模式保持回退（best-effort）。 */
export function pickMarketFromLib(fallback: string): { iid: string; source: string } {
  const links = libPool('LINKS');
  for (let i = 0; i < links.length; i++) {
    const idx = Math.floor(Math.random() * links.length);
    const m = /offer\/(\d{6,})/.exec(links[idx]) || /^(\d{6,})$/.exec(links[idx].trim());
    if (m) return { iid: m[1], source: `用例库链接#${idx}` };
  }
  if (links.length && process.env.LIB_LINKS_MODE === 'picked') {
    throw new Error(`测试用例库勾选的 ${links.length} 条链接均不含 供应链 offer 编号（${links.join(' | ')}）。`
      + '全链选品仅支持 https://detail.market.example.com/offer/<数字>.html 或纯商品编号；淘宝/微店等链接请改用支持搜索的用例（如加购/购物车/收藏）或换成供应链链接');
  }
  if (links.length) {
    return { iid: fallback, source: `站点档案 numIidFullChain（库随机 ${links.length} 条均无 供应链编号，回退）` };
  }
  return { iid: fallback, source: '站点档案 numIidFullChain' };
}

/** 调试输出：加载了哪个站点档案 */
if (process.env.DEBUG_SITE_CONFIG) {
  console.log(`[site-config] site=${site.id} pc=${pcBase} wap=${wapBase} boss=${bossRoot} (URL 原样拼接，无派生前缀)`);
}
