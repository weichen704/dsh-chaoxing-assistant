// 浏览器会话管理：账号 → 调试端口 / profile / CDP 连接 / 控制器页面。
import path from 'node:path';
import { Cdp, Page, browserInfo, listTargets, SPOOF_SOURCE } from './cdp.mjs';
import { ensurePort, launchEdge, killEdgeTree } from './edge.mjs';
import { paths } from './paths.mjs';

export const DEFAULT_ACCOUNT = 'default';
export const DEFAULT_PORT = 9422;

/** 已经在跑的 Edge：优先复用登录页/空白页标签，避免重复开标签或窗口 */
async function pickReusableTarget(port) {
  if (!port) return '';
  try {
    const targets = (await listTargets(port)) || [];
    const pages = targets.filter((t) => (t.type || '') === 'page' && t.id);
    if (!pages.length) return '';
    const login = pages.find((t) => /passport2?\.chaoxing\.com\/login|chaoxing\.com\/passport/i.test(String(t.url || '')));
    const blank = pages.find((t) => /^(about:blank|chrome:\/\/newtab|edge:\/\/newtab)/i.test(String(t.url || '')));
    const picked = login || blank;
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

export function accountGet(store, name, { create = false, port, profileDir } = {}) {
  const id = String(name || DEFAULT_ACCOUNT);
  const accounts = store.get('accounts', {});
  let acc = accounts[id];
  if (!acc && create) {
    acc = {
      name: id,
      port: Number(port) || DEFAULT_PORT,
      profileDir: profileDir || path.join(paths().profiles, id),
      createdAt: new Date().toISOString(),
    };
    accounts[id] = acc;
    store.set('accounts', accounts);
  }
  if (!acc) throw new Error(`账号 "${id}" 不存在，请先用 chaoxing_account 的 add 动作登记（会给出默认端口和 profile 目录）`);
  // 已存在时，显式传入的 port/profileDir 视为“重新登记”（修复被写坏/丢失字段的记录）
  if (acc) {
    let changed = false;
    if (port !== undefined && Number(port) && Number(port) !== Number(acc.port)) {
      acc.port = Number(port);
      changed = true;
    }
    if (profileDir && String(profileDir) !== String(acc.profileDir || '')) {
      acc.profileDir = String(profileDir);
      changed = true;
    }
    if (!acc.profileDir) {
      acc.profileDir = path.join(paths().profiles, id);
      changed = true;
    }
    if (changed) {
      accounts[id] = acc;
      store.set('accounts', accounts);
    }
  }
  return acc;
}

export class AccountHub {
  constructor(store) {
    this.store = store;
    this.live = new Map(); // name -> { port, cdp, page, account }
  }

  async _connect(account) {
    const port = Number(account.port) || DEFAULT_PORT;
    const info = await browserInfo(port);
    if (!info) return null;
    const cdp = await Cdp.connect(port);
    return { port, cdp, page: null };
  }

  /** 连接（必要时启动）浏览器；返回 { port, cdp, account } */
  async ensureBrowser(account, { startIfNeeded = true, edgePath, startUrl = 'https://i.chaoxing.com/base' } = {}) {
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
      try {
        await cached.cdp.send('Browser.getVersion');
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
      if (launched.pid) {
        account.pid = launched.pid;
        account.port = picked.port;
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
      try {
        const alive = await live.page.evaluate('1+1');
        if (alive === 2) return { ...live, page: live.page };
      } catch {
        /* fall through 重建 */
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
