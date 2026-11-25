// 浏览器会话管理：账号 → 调试端口 / profile / CDP 连接 / 控制器页面。
import fs from 'node:fs';
import path from 'node:path';
import { Cdp, Page, browserInfo, listTargets, SPOOF_SOURCE } from './cdp.mjs';
import { ensurePort, launchEdge, killEdgeTree } from './edge.mjs';
import { paths } from './paths.mjs';
import { safeAccountName, safePort } from './util.mjs';

export const DEFAULT_ACCOUNT = 'default';
export const DEFAULT_PORT = 9422;

/** 已经在跑的 Edge：优先复用登录页/空白页标签，避免重复开标签或窗口 */
async function pickReusableTarget(port) {
  if (!port) return '';
  try {
    const targets = (await listTargets(port)) || [];
    const pages = targets.filter((t) => (t.type || '') === 'page' && t.id);
    if (!pages.length) return '';
    // 优先复用「已登录的学习通页面」（个人空间/课程页）——扫码登录成功后登录页标签往往还留着，
    // 若优先复用它，控制器页会一直停在登录页，check/扫描就永远报「未登录」。
    const logged = pages.find((t) => {
      const u = String(t.url || '');
      return /chaoxing\.com/i.test(u) && !/passport\d?\.chaoxing\.com\/|\/login/i.test(u);
    });
    const login = pages.find((t) => /passport2?\.chaoxing\.com\/login|chaoxing\.com\/passport/i.test(String(t.url || '')));
    const blank = pages.find((t) => /^(about:blank|chrome:\/\/newtab|edge:\/\/newtab)/i.test(String(t.url || '')));
    const picked = logged || login || blank;
    return picked && picked.id ? String(picked.id) : '';
  } catch {
    return '';
  }
}

/** 刚由我们启动的 Edge：挑一个已经打开的 page target 复用，避免再开第二个登录窗口 */
async function pickLaunchedTarget(port, startUrl) {
  if (!port) return '';
  try {
    const targets = (await listTargets(port)) || [];
    const pages = targets.filter((t) => (t.type || '') === 'page' && t.id);
    if (!pages.length) return '';
    const want = String(startUrl || '').trim();
    const byUrl = want ? pages.find((t) => String(t.url || '').startsWith(want)) : null;
    const byChaoxing = pages.find((t) => /chaoxing\.com/i.test(String(t.url || '')));
    const picked = byUrl || byChaoxing || pages[0];
    return picked && picked.id ? String(picked.id) : '';
  } catch {
    return '';
  }
}

export function accountList(store) {
  const accounts = store.get('accounts', {});
  return Object.values(accounts);
}

/** profileDir 必须落在插件自己的 profiles 目录里：
 *  允许任意目录会让 `--user-data-dir` 指向用户已有的 Edge 配置（登录态被复用）或 UNC 共享，
 *  还会在数据目录外创建目录。 */
function profileDirFor(raw, id) {
  const def = path.join(paths().profiles, id);
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return def;
  if (/^\\\\|^\/\//.test(s)) throw new Error('profileDir 不能是网络路径');
  const abs = path.resolve(s);
  const root = path.resolve(paths().profiles);
  let real = abs;
  let base = root;
  try { real = fs.realpathSync(abs); } catch { /* 不存在就用字面路径 */ }
  try { base = fs.realpathSync(root); } catch { /* ignore */ }
  const rel = path.relative(base, real);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`profileDir 必须位于 ${base} 之下（可用 add 动作的默认目录）`);
  }
  return abs;
}

export function accountGet(store, name, { create = false, port, profileDir } = {}) {
  const id = safeAccountName(name || DEFAULT_ACCOUNT);
  const accounts = store.get('accounts', {});
  const own = Object.prototype.hasOwnProperty.call(accounts, id);
  let acc = own ? accounts[id] : null;
  const wantPort = port === undefined || port === null || String(port) === '' ? 0 : safePort(port);
  if (port !== undefined && port !== null && String(port) !== '' && !wantPort) {
    throw new Error('调试端口必须在 9300-9499 之间（插件专用段，避免接管其它浏览器的调试实例）');
  }
  if (!acc && create) {
    acc = {
      name: id,
      port: wantPort || DEFAULT_PORT,
      profileDir: profileDirFor(profileDir, id),
      createdAt: new Date().toISOString(),
    };
    accounts[id] = acc;
    store.set('accounts', accounts);
  }
  if (!acc) throw new Error(`账号 "${id}" 不存在，请先用 chaoxing_account 的 add 动作登记（会给出默认端口和 profile 目录）`);
  // 已存在时，显式传入的 port/profileDir 视为“重新登记”（修复被写坏/丢失字段的记录）
  let changed = false;
  if (wantPort && wantPort !== Number(acc.port)) {
    acc.port = wantPort;
    changed = true;
  }
  if (profileDir) {
    const next = profileDirFor(profileDir, id);
    if (next !== String(acc.profileDir || '')) {
      acc.profileDir = next;
      changed = true;
    }
  }
  if (!acc.profileDir) {
    acc.profileDir = path.join(paths().profiles, id);
    changed = true;
  }
  // 旧数据可能存着 9222 之类的端口：迁移到默认段，避免下次启动去探测/复用别的浏览器
  if (!safePort(acc.port)) {
    acc.port = DEFAULT_PORT;
    changed = true;
  }
  if (changed) {
    accounts[id] = acc;
    store.set('accounts', accounts);
  }
  return acc;
}

export class AccountHub {
  constructor(store) {
    this.store = store;
    this.live = new Map(); // name -> { port, cdp, page, account }
    this._inflight = new Map(); // name -> Promise（ensureBrowser 并发去重）
  }

  async _connect(account) {
    const port = Number(account.port) || DEFAULT_PORT;
    const info = await browserInfo(port);
    if (!info) return null;
    const cdp = await Cdp.connect(port);
    return { port, cdp, page: null };
  }

  /** 连接（必要时启动）浏览器；返回 { port, cdp, account }。并发调用共享同一个 in-flight promise */
  ensureBrowser(account, { startIfNeeded = true, edgePath, startUrl = 'https://i.chaoxing.com/base' } = {}) {
    // 同一账号的并发调用必须共享同一个 in-flight promise：否则两个调用都会走到
    // _connect→launchEdge，各自启动一个 Edge（双开、抢调试端口、profile 锁冲突）。
    // 只按账号名去重；失败不缓存（finally 里清掉，下次调用重新尝试）。
    const name = String(account.name || DEFAULT_ACCOUNT);
    const inflight = this._inflight.get(name);
    if (inflight) return inflight;
    const tracked = this._connectOrLaunch(account, { startIfNeeded, edgePath, startUrl }).finally(() => {
      if (this._inflight.get(name) === tracked) this._inflight.delete(name);
    });
    this._inflight.set(name, tracked);
    return tracked;
  }

  async _connectOrLaunch(account, { startIfNeeded = true, edgePath, startUrl = 'https://i.chaoxing.com/base' } = {}) {
    // 调用方有时只给 { name }（比如面板/命令里的临时对象）。这里先用已登记记录补齐
    // port/profileDir，否则会按默认 9422 + 空 profile 另起一个浏览器（历史 bug）。
    try {
      const stored = (this.store.get('accounts', {}) || {})[account.name] || null;
      if (stored) {
        if (!account.port && stored.port) account.port = stored.port;
        if (!account.profileDir && stored.profileDir) account.profileDir = stored.profileDir;
        if (!account.pid && stored.pid) account.pid = stored.pid;
      }
    } catch {
      /* ignore */
    }
    const cached = this.live.get(account.name);
    if (cached && cached.cdp) {
      // 已关闭的连接不用再等一个 RTT；健康检查也别用 20s 默认超时（Edge 卡死时会把每次调用拖住 20s）
      if (cached.cdp._closed) {
        this.live.delete(account.name);
      } else {
        try {
          await cached.cdp.send('Browser.getVersion', {}, null, { timeoutMs: 2500 });
          return cached;
        } catch {
          try {
            cached.cdp.close();
          } catch {
            /* ignore */
          }
          this.live.delete(account.name);
        }
      }
    }

    let live = await this._connect(account);
    if (!live) {
      if (!startIfNeeded) {
        throw new Error(`调试端口 ${account.port} 上没有 Edge。请先执行 chaoxing_account 的 start 动作启动浏览器。`);
      }
      const picked = await ensurePort(account.port);
      const launched = await launchEdge({
        port: picked.port,
        profileDir: account.profileDir || path.join(paths().profiles, account.name),
        edgePath,
        startUrl,
      });
      // 不管是新启动还是复用已开的 Edge，实际可用端口都是 picked.port；
      // 连接必须用它，否则 account.port 是旧值时必然「端口上有 Edge 但 CDP 连不上」
      account.port = picked.port;
      if (launched.pid) account.pid = launched.pid;
      {
        const accounts = this.store.get('accounts', {});
        const prev = accounts[account.name] || {};
        // 只写回真实字段，避免用空值把已有的 profileDir 覆盖掉（历史 bug：账号的 profileDir 被抹掉）
        const next = { ...prev, ...account };
        if (!next.profileDir) next.profileDir = path.join(paths().profiles, account.name);
        accounts[account.name] = next;
        this.store.set('accounts', accounts);
      }
      live = await this._connect(account);
      if (!live) throw new Error(`Edge 已在端口 ${picked.port} 启动，但 CDP 连接失败`);
      // 刚启动的这个 Edge 里的第一个标签页就是我们的，直接复用它当控制器页，
      // 这样登录时只有一个窗口（不会再额外弹一个 about:blank 窗口）。
      live.freshTargetId = await pickLaunchedTarget(live.port, startUrl);
    }
    live.account = account;
    this.live.set(account.name, live);
    return live;
  }

  /** 控制器页面（用来读目录、登录探测等），必要时新建 */
  async ensurePage(account, { edgePath, newWindow = false, viewport = null } = {}) {
    const live = await this.ensureBrowser(account, { edgePath });
    if (live.page) {
      // 页面在导航中时 evaluate 会因「execution context destroyed」失败：短退避重试一次即可，
      // 不要直接整页重建（重建要多花 4 个 RTT 的 enable/注入）
      for (let i = 0; i < 2; i++) {
        try {
          if ((await live.page.evaluate('1+1', { timeoutMs: 2500 })) === 2) return { ...live, page: live.page };
          break;
        } catch (e) {
          if (i === 0) await new Promise((r) => setTimeout(r, 300));
        }
      }
    }
    // 刚启动浏览器时：直接接管它自带的那一页，避免多开一个窗口
    if (live.freshTargetId) {
      const targetId = live.freshTargetId;
      live.freshTargetId = '';
      try {
        live.page = await Page.create(live.cdp, { targetId, url: '', timeoutMs: 15000 });
        return { ...live, page: live.page };
      } catch {
        /* 接管失败就退回新建 */
      }
    }
    // 已经有登录页/空白页标签时就复用，避免每次点「开始」都再开一个标签
    const reusable = await pickReusableTarget(live.port);
    if (reusable) {
      try {
        live.page = await Page.create(live.cdp, { targetId: reusable, url: '', timeoutMs: 15000 });
        return { ...live, page: live.page };
      } catch {
        /* 复用失败就退回新建 */
      }
    }
    live.page = await Page.create(live.cdp, { newWindow, url: 'about:blank', viewport });
    return { ...live, page: live.page };
  }

  /** 丢弃缓存的控制器页（CDP 会话失效 / 页面被关时用），下次 ensurePage 会重建 */
  invalidatePage(account) {
    const name = typeof account === 'string' ? account : account && account.name;
    const live = this.live.get(name);
    if (!live) return false;
    try {
      if (live.page) live.page.close().catch(() => {});
    } catch {
      /* ignore */
    }
    live.page = null;
    live.freshTargetId = '';
    return true;
  }

  /** 打开一个任务页（默认在当前窗口开标签页，用完即关；不会每次都弹新窗口） */
  async openTaskPage(account, { url = 'about:blank', width = 1200, height = 4600, spoof = SPOOF_SOURCE, edgePath, newWindow = false } = {}) {
    const live = await this.ensureBrowser(account, { edgePath });
    const page = await Page.create(live.cdp, {
      newWindow: !!newWindow,
      url: 'about:blank',
      viewport: width ? { width, height, deviceScaleFactor: 1, mobile: false } : null,
      spoof,
    });
    // 传了 url 就直接导航过去（旧实现只建空页、忽略 url，导致「网页入口」停在 about:blank）
    if (url && url !== 'about:blank') {
      try {
        await page.goto(url, { waitMs: 6000, timeoutMs: 30000 });
      } catch {
        /* 导航失败也把页面交回去，调用方自己判断 href */
      }
    }
    const port = live.port;
    return { page, port, cdp: live.cdp, targetId: page.targetId };
  }

  async status(account) {
    const port = Number(account.port) || DEFAULT_PORT;
    const info = await browserInfo(port);
    const live = this.live.get(account.name);
    return {
      account: account.name,
      port,
      profileDir: account.profileDir,
      running: !!info,
      version: info ? info.Browser || '' : '',
      connected: !!(live && live.cdp),
      pid: account.pid || 0,
    };
  }

  async stop(account, { kill = true } = {}) {
    const live = this.live.get(account.name);
    if (live) {
      try {
        if (live.page) await live.page.close();
      } catch {
        /* ignore */
      }
      try {
        live.cdp.close();
      } catch {
        /* ignore */
      }
      this.live.delete(account.name);
    }
    if (kill && account.pid) {
      const ok = killEdgeTree(account.pid);
      account.pid = 0;
      const accounts = this.store.get('accounts', {});
      const prev = accounts[account.name] || {};
      const next = { ...prev, ...account };
      if (!next.profileDir) next.profileDir = path.join(paths().profiles, account.name);
      accounts[account.name] = next;
      this.store.set('accounts', accounts);
      return { killed: ok };
    }
    return { killed: false };
  }
}
