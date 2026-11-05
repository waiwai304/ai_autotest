import fs from 'node:fs';
import path from 'node:path';

export interface PcSection {
  baseURL?: string;
  /** PC 前台 URL 语言前缀（如 /zh-cn）；缺省用 /${defaultLocale} */
  localePrefix?: string;
  /** PC 前台页面路径表：key -> path（不含域名与语言前缀） */
  paths?: Record<string, string>;
}

export interface WapSection {
  baseURL?: string;
  /** WAP hash 路由入口段（如 /wap#） */
  entry?: string;
  /** WAP 页面 hash 路由表：key -> route（含查询串） */
  paths?: Record<string, string>;
}

export interface BossSection {
  baseURL?: string;
  /** 后台安全入口段（如 /3hxSz0YT），页面路由会拼在它后面 */
  entry?: string;
  /** 后台页面路径表：key -> path（拼在 entry 之后） */
  paths?: Record<string, string>;
  /** 后台 API 前缀（不含 entry） */
  apiPrefix?: string;
  /** 后台 API 端点表：key -> 相对 apiPrefix 的路径 */
  api?: Record<string, string>;
}

export interface SiteConfig {
  id: string;
  name: string;
  baseURL: string;
  adapter: string;
  enabled: boolean;
  locales: string[];
  defaultLocale: string;
  currency: string;
  timeoutMs: number;
  productLoadTimeoutMs: number;
  features: Record<string, boolean>;
  testData: {
    searchKeyword: string;
    validMarketProductUrl: string;
    destination: string;
    weightGrams: number;
    lengthCm: number;
    widthCm: number;
    heightCm: number;
    /** 供应链源站域名（默认 https://detail.market.example.com） */
    sourceSiteMarket?: string;
    /** full-chain 用例使用的 供应链商品 num_iid */
    numIidFullChain?: string;
    /** WAP 详情页用例商品 num_iid */
    numIidWapDetail?: string;
    /** WAP 加购用例商品 num_iid */
    numIidWapCart?: string;
    /** WAP 搜索关键词（单值兜底） */
    searchKeywordWap?: string;
    /** WAP 全链下单关键词池：每轮随机抽一个搜索选品下单（ian 要求不重复用同一测试商品） */
    searchKeywords?: string[];
  };
  pc?: PcSection;
  wap?: WapSection;
  boss?: BossSection;
}

const configPath = path.resolve(process.cwd(), 'config/sites.json');
const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
  sites: SiteConfig[];
};

const selected = new Set(
  (process.env.TEST_SITE_IDS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);

export const sites = raw.sites.filter(
  (site) => site.enabled && (selected.size === 0 || selected.has(site.id)),
);

if (sites.length === 0) {
  throw new Error('没有找到已启用的测试站点，请检查 config/sites.json 和 TEST_SITE_IDS');
}
