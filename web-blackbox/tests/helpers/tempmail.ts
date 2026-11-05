/**
 * tempmail.ts —— 临时邮箱取码（默认 nimail.cn 免费共享模式）
 * 2026-11-04 ian：注册流程默认使用临时邮箱收验证码，替代「随机 @qq.com 假邮箱收不到码」的旧做法。
 *
 * nimail 免费 API（无需 Basic 授权码 = 共享模式，并发受限但可注册取码）：
 *   1) POST https://www.nimail.cn/api/applymail   mail=<addr>                申请邮箱（10 分钟有效）
 *   2) POST https://www.nimail.cn/api/getmails    mail=<addr>&time=0&_=<ms>  轮询邮件列表
 *   3) GET  https://www.nimail.cn/api/raw-html/<addr>/<mailId>               取邮件原始 HTML
 * 邮件只在申请后 10 分钟内可查，故注册/登录的取码窗口必须紧贴申请动作。
 *
 * 设计要点：
 *  - 不依赖 Playwright，纯 fetch（Node 18+ 全局 fetch）——可在任何 spec/脚本里复用
 *  - 域名白名单：部分站点注册表单校验邮箱域名后缀，nimail.cn 被拒时可用 TEMPMAIL_DOMAIN 覆盖
 *  - 提取验证码：优先「验证码/校验码/verification code」附近 4~8 位数字，其次全文最高优先级数字串
 */
const API = {
  apply: 'https://www.nimail.cn/api/applymail',
  mails: 'https://www.nimail.cn/api/getmails',
  raw: 'https://www.nimail.cn/api/raw-html',
};

const DOMAIN = (process.env.TEMPMAIL_DOMAIN || 'nimail.cn').trim();
const AUTH = (process.env.TEMPMAIL_AUTH || '').trim(); // 可选 Basic 授权码；不传 = 免费共享模式

function headers(form: boolean): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (form) h['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
  if (AUTH) h['Authorization'] = AUTH.startsWith('Basic ') ? AUTH : `Basic ${AUTH}`;
  return h;
}

async function postForm(url: string, data: Record<string, string>): Promise<any> {
  const body = new URLSearchParams(data).toString();
  const res = await fetch(url, { method: 'POST', headers: headers(true), body });
  const txt = await res.text();
  try {
    return JSON.parse(txt);
  } catch {
    throw new Error(`临时邮箱接口返回非 JSON（${res.status}）：${txt.slice(0, 160)}`);
  }
}

export type Mailbox = { address: string; local: string; appliedAt: number; provider: string };

/** 申请一个可用临时邮箱（随机前缀；10 分钟有效窗口） */
export async function applyMailbox(): Promise<Mailbox> {
  const local = 'ob' + Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 6);
  const address = `${local}@${DOMAIN}`;
  const r = await postForm(API.apply, { mail: address });
  if (String(r?.success) !== 'true') {
    throw new Error(`临时邮箱申请失败：${JSON.stringify(r).slice(0, 200)}`);
  }
  return { address, local, appliedAt: Date.now(), provider: 'nimail' };
}

/**
 * 为指定地址开通收信窗口（同址重复申请 = 重置 10 分钟窗口）。
 * 2026-11-04 ian：站点不需要验证码时不必申请（省 nimail 共享额度）；
 * 后续某步骤突然要求验证码时，用本函数按需开通。
 */
export async function applyMailboxFor(address: string): Promise<Mailbox> {
  const local = address.split('@')[0];
  const r = await postForm(API.apply, { mail: address });
  if (String(r?.success) !== 'true') {
    throw new Error(`临时邮箱开通失败（${address}）：${JSON.stringify(r).slice(0, 200)}`);
  }
  return { address, local, appliedAt: Date.now(), provider: 'nimail' };
}

/** 生成一个未开通的临时邮箱地址（用于「站点不需要验证码」的注册场景） */
export function newMailboxAddress(): string {
  const local = 'ob' + Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 6);
  return `${local}@${DOMAIN}`;
}

export type MailItem = { id: string; subject: string; from: string; time: string; email: string };

/** 最近一次邮件列表接口的错误（供上层报错展示，避免「空列表」被误判为「没收到」） */
let _lastListError = '';
export function lastMailError(): string {
  return _lastListError;
}
export function clearMailError(): void {
  _lastListError = '';
}

/** 拉取邮箱当前邮件列表（空数组 = 暂无邮件） */
export async function listMails(address: string): Promise<MailItem[]> {
  const r = await postForm(API.mails, { mail: address, time: '0', _: String(Date.now()) });
  if (String(r?.success) !== 'true') {
    _lastListError = JSON.stringify(r).slice(0, 160);
    return [];
  }
  _lastListError = '';
  const arr = Array.isArray(r?.mail) ? r.mail : r?.mail ? [r.mail] : [];
  return arr.map((m: any) => ({
    id: String(m.id || ''),
    subject: String(m.subject || ''),
    from: String(m.from || ''),
    time: String(m.time || ''),
    email: String(m.email || ''),
  }));
}

/**
 * 取邮件正文（原始 HTML 文本）。
 * 2026-11-04 ian 关键坑：nimail 的 raw-html 路径里邮箱地址必须**原样带 @**，
 *   一旦 URL 编码成 %40 就返回「Invalid email address」（实测 3059 bytes 正文 → 30 bytes 错误页）。
 */
export async function fetchMailBody(address: string, id: string): Promise<string> {
  const url = `${API.raw}/${address}/${encodeURIComponent(id)}`; // 地址不编码，仅 id 编码
  try {
    const res = await fetch(url, { headers: headers(false) });
    const text = (await res.text()) || '';
    if (/Invalid email address/i.test(text) || text.trim().length < 60) {
      // 兜底：极少数情况下地址含特殊字符需编码，再试一次编码版本
      const alt = await fetch(`${API.raw}/${encodeURIComponent(address)}/${encodeURIComponent(id)}`, { headers: headers(false) })
        .then((r) => r.text())
        .catch(() => '');
      if (alt && !/Invalid email address/i.test(alt) && alt.trim().length >= 60) return alt;
      return ''; // 正文不可用（交由主题提码/上层日志说明）
    }
    return text;
  } catch {
    return '';
  }
}

/**
 * 从文本/邮件正文提取验证码。
 * 2026-11-04 ian：真实站点验证码为 4~8 位不定长（vtest2026 是 4 位且写在邮件主题「登录验证码：2965」里），
 * 故默认不限定位数（4~8），语义关键词优先，避免把时间戳/年份当验证码。
 */
export function extractCode(raw: string, digits?: number): string | null {
  const text = String(raw || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
  const D = digits ? String(digits) : '[4-8]';
  const dg = digits ? `\\d{${D}}` : '\\d{4,8}';
  const pats = [
    // 语义优先：验证码/校验码/code 后的纯数字
    new RegExp(`(?:验证码|校验码|动态码|激活码|确认码|verification\\s*code|code|otp)[^0-9]{0,12}(${dg})`, 'i'),
    // 数字在前：「2965 是您的验证码」
    new RegExp(`(${dg})\\s*(?:是您|是你的|为您的|作为|用于|is your)`, 'i'),
    // 兜底：任意 4~8 位独立数字（宁可多试一次，不轻易判失败）
    /\b(\d{4,8})\b/,
  ];
  for (const p of pats) {
    const m = text.match(p);
    if (m?.[1]) return m[1];
  }
  // 2026-11-04 ian：邮件模板常把每位数字放在独立 <td>/<span>，去标签后变成「5 3 6 9」——
  // 关键字附近允许 4~8 位「被空白/标签分隔」的数字，拼接后返回。
  const spaced = text.match(
    new RegExp(`(?:验证码|校验码|动态码|激活码|确认码|verification\\s*code|code|otp)[^0-9]{0,16}((?:\\d[\\s\\u00a0]{0,3}){4,8})`, 'i'),
  );
  if (spaced?.[1]) {
    const joined = spaced[1].replace(/\D/g, '');
    if (joined.length >= 4 && joined.length <= 8) return joined;
  }
  // 最后兜底：文本里任意「单位数字 + 空白」连续 4~8 段（仍限定必须出现过验证码关键词）
  if (/验证码|校验码|code|otp/i.test(text)) {
    const seq = text.match(/(?:^|\D)((?:\d[\s\u00a0]{1,3}){3,7}\d)(?!\d)/);
    if (seq?.[1]) {
      const joined = seq[1].replace(/\D/g, '');
      if (joined.length >= 4 && joined.length <= 8) return joined;
    }
  }
  return null;
}

export type WaitOpts = {
  timeoutMs?: number;
  intervalMs?: number;
  subjectRe?: RegExp; // 主题过滤（如 /验证码|verify|code/i）
  fromRe?: RegExp; // 发件人过滤（如站点域名）
  digits?: number;
  logs?: string[];
  ignoreIds?: Set<string>; // 忽略这些邮件（站点在触发弹窗前已发过码时，只认新邮件）
  onTick?: (n: number) => void | Promise<void>; // 每轮回调（如点一次「重新发送」/关弹窗）
};

/**
 * 等待并提取验证码：轮询列表 → 取最新匹配邮件正文 → 正则提取。
 * 失败抛错（含已等待时长与收到的邮件主题，便于排查）。
 */
export async function waitForCode(address: string, opts: WaitOpts = {}): Promise<{ code: string; mail: MailItem }> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 4_000;
  const subjectRe = opts.subjectRe ?? /验证码|校验码|code|verify|verif|确认|激活/i;
  const digits = opts.digits ?? 6;
  const logs = opts.logs ?? [];
  const deadline = Date.now() + timeoutMs;
  const seen = new Set<string>();
  const ignore = opts.ignoreIds;
  const topics: string[] = [];
  let n = 0;
  while (Date.now() < deadline) {
    n++;
    try {
      await opts.onTick?.(n);
      const mails = await listMails(address);
      for (const m of mails) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        if (ignore?.has(m.id)) continue;
        topics.push(m.subject || '(无主题)');
        if (opts.fromRe && !opts.fromRe.test(m.from)) continue;
        // 主题优先（vtest2026 主题即「登录验证码：2965」，正文常是模板噪声）
        const fromSubject = extractCode(m.subject, digits);
        if (fromSubject) {
          logs.push(`收到验证码邮件「${m.subject}」，从主题提取验证码 ${fromSubject}（第 ${n} 轮轮询）`);
          return { code: fromSubject, mail: m };
        }
        const body = await fetchMailBody(address, m.id);
        const code = extractCode(body, digits);
        if (code) {
          logs.push(`收到验证码邮件「${m.subject}」，从正文提取验证码 ${code}（第 ${n} 轮轮询）`);
          return { code, mail: m };
        }
      }
    } catch (e: any) {
      logs.push(`临时邮箱轮询异常（第 ${n} 轮）：${String(e?.message || e).slice(0, 120)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `临时邮箱 ${address} 在 ${Math.round(timeoutMs / 1000)}s 内未收到含验证码的邮件` +
      (topics.length ? `（已收到 ${topics.length} 封：${topics.slice(0, 5).join(' / ')}）` : '（未收到任何邮件）') +
      (_lastListError ? `；邮箱接口异常：${_lastListError}` : ''),
  );
}
