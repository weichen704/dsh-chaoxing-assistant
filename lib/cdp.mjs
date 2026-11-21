// lib/cdp.mjs —— CDP 内核（HTTP 探测 + WebSocket 会话 + Page 封装）
//
// 零外部依赖、纯 ESM、只用 node: 内置模块；可在 Electron 主进程（Node 20，无全局 WebSocket）直接跑。
// 对外 API 是插件其它模块的契约，签名不要随意改。
import http from 'node:http';
import { Buffer } from 'node:buffer';
import { openWebSocket } from './ws.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms | 0)));

// ---------------------------------------------------------------------------
// 反检测脚本：注入到每个新文档（Page.addScriptToEvaluateOnNewDocument）
// 让页面认为自己是可见、有焦点的前台文档，并吞掉常见的“离开页面/不可见”事件。
// ---------------------------------------------------------------------------
export const SPOOF_SOURCE = `(() => {
  try {
    const proto = Document.prototype;
    const def = (k, v) => { try { Object.defineProperty(proto, k, { configurable: true, get: () => v }); } catch (e) {} };
    def('hidden', false); def('visibilityState', 'visible'); def('webkitHidden', false); def('webkitVisibilityState', 'visible');
    try { Document.prototype.hasFocus = () => true; } catch (e) {}
    const orig = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, fn, opts) {
      if (/^(blur|visibilitychange|webkitvisibilitychange|pagehide|freeze)$/.test(String(type))) return;
      return orig.call(this, type, fn, opts);
    };
  } catch (e) {}
})();`;

// ---------------------------------------------------------------------------
// 底层 HTTP：DevTools 的 HTTP 端点（/json/version、/json/list、/json/close）
// ---------------------------------------------------------------------------
function httpRequestText(port, path, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const p = Number(port);
    if (!Number.isFinite(p) || p <= 0) {
      reject(new Error(`非法端口: ${port}`));
      return;
    }
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(value);
    };
    const req = http.request(
      {
        host: '127.0.0.1',
        port: p,
        path: String(path),
        method: 'GET',
        agent: false, // 不复用 socket，避免连接池残留
        headers: { Connection: 'close' },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          chunks.push(c);
          size += c.length;
          if (size > 64 * 1024 * 1024) {
            finish(reject, new Error(`HTTP 响应过大(>64MB): ${path}`));
            try {
              res.destroy();
            } catch (e) {
              /* ignore */
            }
          }
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          finish(resolve, { status: res.statusCode || 0, text });
        });
        res.on('error', (err) => finish(reject, err));
      },
    );
    const timer = setTimeout(() => {
      finish(reject, new Error(`HTTP 超时(${timeoutMs}ms): http://127.0.0.1:${p}${path}`));
      try {
        req.destroy();
      } catch (e) {
        /* ignore */
      }
    }, Math.max(1, timeoutMs));
    timer.unref?.();
    req.on('error', (err) => finish(reject, err));
    req.end();
  });
}

/** GET http://127.0.0.1:<port><path> → 文本；网络错误/超时/非 2xx 抛错 */
export async function getText(port, path, timeoutMs = 4000) {
  const { status, text } = await httpRequestText(port, path, timeoutMs);
  if (status < 200 || status >= 300) {
    throw new Error(`HTTP ${status} ${path}: ${String(text).slice(0, 200)}`);
  }
  return text;
}

/** GET → JSON；解析失败抛错 */
export async function getJson(port, path, timeoutMs = 4000) {
  const text = await getText(port, path, timeoutMs);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON 解析失败 ${path}: ${String(text).slice(0, 200)}`);
  }
}

/** GET /json/version；连不上返回 null（不抛错），用于探测浏览器是否就绪 */
export async function browserInfo(port, timeoutMs = 4000) {
  try {
    const info = await getJson(port, '/json/version', timeoutMs);
    if (!info || typeof info !== 'object') return null;
    if (!info.webSocketDebuggerUrl) return null;
    return info;
  } catch (err) {
    return null;
  }
}

/** GET /json/list → 目标数组；连接失败会抛错（探测请用 browserInfo） */
export async function listTargets(port) {
  const list = await getJson(port, '/json/list');
  return Array.isArray(list) ? list : [];
}

/** GET /json/close/<id>，忽略一切错误 */
export async function closeTarget(port, targetId) {
  if (!targetId) return;
  try {
    await getText(port, `/json/close/${encodeURIComponent(String(targetId))}`, 3000);
  } catch (err) {
    /* 目标可能已经关了 / 浏览器可能已经退出，忽略 */
  }
}

// ---------------------------------------------------------------------------
// Cdp：一条到浏览器级 WebSocket 的连接（flatten 模式，页面用 sessionId 区分）
// ---------------------------------------------------------------------------
export class Cdp {
  constructor(ws, port, info) {
    this.port = Number(port);
    this.info = info || {};
    this._ws = ws;
    this._id = 0;
    this._pending = new Map(); // id → { method, resolve, reject, timer }
    this._events = new Set(); // (method, params, sessionId) => void
    this._waiters = new Set(); // waitEvent 的等待者
    this._closed = false;
    this.defaultTimeoutMs = 20000;

    this._offMsg = ws.onMessage((text) => {
      try {
        this._onMessage(text);
      } catch (err) {
        /* 单条坏消息不能打断连接 */
      }
    });
    this._offClose = ws.onClose((info2) => {
      this._failAll(new Error(`CDP 连接已断开: ${(info2 && info2.reason) || 'closed'}`));
    });
  }

  /** 连到 127.0.0.1:<port> 的浏览器级 WS；先读 /json/version 拿 webSocketDebuggerUrl */
  static async connect(port, { timeoutMs = 8000, preferGlobal = true } = {}) {
    const info = await browserInfo(port, timeoutMs);
    if (!info) {
      throw new Error(`无法连接 CDP: 127.0.0.1:${port} 无响应（/json/version 失败）`);
    }
    let wsUrl = info.webSocketDebuggerUrl;
    if (!wsUrl) throw new Error('CDP /json/version 未返回 webSocketDebuggerUrl');
    // 少数版本返回 localhost；统一用 127.0.0.1，避免 IPv6/解析差异
    wsUrl = String(wsUrl).replace('://localhost', '://127.0.0.1');
    const ws = await openWebSocket(wsUrl, { timeoutMs, preferGlobal });
    return new Cdp(ws, port, info);
  }

  _onMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (err) {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.id !== undefined && msg.id !== null && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this._pending.get(msg.id);
      if (!p) return; // 已被超时清理
      this._pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const err = new Error(`${p.method} ${msg.error.message || 'CDP error'}`);
        err.cdpError = { code: msg.error.code, message: msg.error.message, data: msg.error.data };
        err.method = p.method;
        p.reject(err);
      } else {
        p.resolve(msg.result || {});
      }
      return;
    }
    if (typeof msg.method === 'string') {
      this._dispatch(msg.method, msg.params || {}, msg.sessionId === undefined ? null : msg.sessionId);
    }
  }

  _dispatch(method, params, sessionId) {
    for (const handler of Array.from(this._events)) {
      try {
        handler(method, params, sessionId);
      } catch (err) {
        /* 监听器异常隔离 */
      }
    }
    if (!this._waiters.size) return;
    for (const w of Array.from(this._waiters)) {
      if (w.method !== method) continue;
      if (w.sessionId !== null && w.sessionId !== sessionId) continue;
      if (w.predicate) {
        let matched = false;
        try {
          matched = !!w.predicate(params);
        } catch (err) {
          this._waiters.delete(w);
          clearTimeout(w.timer);
          w.reject(err instanceof Error ? err : new Error(String(err)));
          continue;
        }
        if (!matched) continue;
      }
      this._waiters.delete(w);
      clearTimeout(w.timer);
      w.resolve(params);
    }
  }

  /**
   * 发一条 CDP 命令 → Promise<result>；CDP error 抛 Error(method + ' ' + message) 并带 .cdpError
   * 第 4 个参数是附加选项（{ timeoutMs }），默认 20s。
   * 也兼容 send(method, params, { sessionId, timeoutMs }) 的写法。
   */
  send(method, params = {}, sessionId = null, opts = {}) {
    if (sessionId && typeof sessionId === 'object') {
      opts = sessionId;
      sessionId = opts.sessionId === undefined ? null : opts.sessionId;
    }
    if (this._closed) return Promise.reject(new Error(`CDP 连接已关闭: ${method}`));
    const id = (this._id += 1);
    const msg = { id, method, params: params || {} };
    if (sessionId) msg.sessionId = sessionId;
    const timeoutMs = Number.isFinite(opts && opts.timeoutMs) ? opts.timeoutMs : this.defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        const err = new Error(`CDP 命令超时(${timeoutMs}ms): ${method}`);
        err.method = method;
        err.timeout = true;
        reject(err);
      }, Math.max(1, timeoutMs));
      timer.unref?.();
      this._pending.set(id, { method, resolve, reject, timer });
      let text;
      try {
        text = JSON.stringify(msg);
      } catch (err) {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(err);
        return;
      }
      try {
        this._ws.sendText(text);
      } catch (err) {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /** 监听所有事件：handler(method, params, sessionId) → unsubscribe() */
  onEvent(handler) {
    this._events.add(handler);
    return () => this._events.delete(handler);
  }

  /** 等某个事件；超时 reject */
  waitEvent(method, { sessionId = null, predicate = null, timeoutMs = 10000 } = {}) {
    return new Promise((resolve, reject) => {
      if (this._closed) {
        reject(new Error(`CDP 连接已关闭，无法等待事件: ${method}`));
        return;
      }
      const waiter = { method, sessionId, predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this._waiters.delete(waiter);
        reject(new Error(`等待事件超时(${timeoutMs}ms): ${method}`));
      }, Math.max(1, timeoutMs));
      waiter.timer.unref?.();
      this._waiters.add(waiter);
    });
  }

  _failAll(err) {
    this._closed = true;
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this._pending.clear();
    for (const w of this._waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this._waiters.clear();
  }

  /** 关连接（不会关浏览器） */
  close() {
    if (this._closed) return;
    this._failAll(new Error('CDP 连接已关闭'));
    try {
      this._offMsg?.();
      this._offClose?.();
    } catch (e) {
      /* ignore */
    }
    try {
      this._ws.close();
    } catch (e) {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Page：一个 target + 一个 flatten session 的封装
// ---------------------------------------------------------------------------
export class Page {
  constructor(cdp, targetId, sessionId) {
    this.cdp = cdp;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this._closed = false;
    this._handlers = new Set();
    this._unsubCdp = null;
    this._spoofId = null;
  }

  /**
   * 建一个新 target 并接管它。
   * 注意：事件监听必须在 Target.attachToTarget 之前装好，否则第一批事件会丢。
   */
  static async create(cdp, { newWindow = true, url = 'about:blank', spoof = '', viewport = null, timeoutMs = 20000, targetId: attachTarget = '' } = {}) {
    let targetId = attachTarget ? String(attachTarget) : null;
    const createdHere = !targetId;
    let page = null;
    let unsub = null;
    const buffered = [];
    try {
      if (!targetId) {
        const created = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: !!newWindow }, null, { timeoutMs });
        targetId = created && created.targetId;
        if (!targetId) throw new Error('Target.createTarget 未返回 targetId');
      }
      page = new Page(cdp, targetId, null);

      // 先装监听再 attach：此时还不知道 sessionId，先按原样缓存
      unsub = cdp.onEvent((method, params, sid) => {
        if (page.sessionId) {
          if (sid === page.sessionId) page._dispatch(method, params);
        } else {
          buffered.push({ method, params, sid });
        }
      });

      const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true }, null, { timeoutMs });
      const sessionId = attached && attached.sessionId;
      if (!sessionId) throw new Error('Target.attachToTarget 未返回 sessionId');
      page.sessionId = sessionId;
      page._unsubCdp = unsub;
      for (const ev of buffered) {
        if (ev.sid === sessionId) page._dispatch(ev.method, ev.params);
      }
      buffered.length = 0;

      await page.send('Page.enable', {}, { timeoutMs });
      await page.send('Runtime.enable', {}, { timeoutMs });
      // 自动接受 JS 原生弹窗（alert/confirm/beforeunload）：
      // 学习通作业页在有未保存答案时离开会触发 beforeunload，不处理会让 Page.navigate 挂死。
      page.on((method) => {
        if (method === 'Page.javascriptDialogOpening') {
          page.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
        }
      });
      const script = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: spoof || SPOOF_SOURCE }, { timeoutMs });
      page._spoofId = script && script.identifier ? script.identifier : null;
      if (viewport) await page.setViewport(viewport);
      if (url && url !== 'about:blank') {
        await page.goto(url, { waitMs: Math.min(9000, Math.max(1500, timeoutMs)) });
      }
      return page;
    } catch (err) {
      if (unsub) {
        try {
          unsub();
        } catch (e) {
          /* ignore */
        }
      }
      if (page) {
        page._closed = true;
        page._handlers.clear();
        try {
          page._unsubCdp?.();
        } catch (e) {
          /* ignore */
        }
      }
      if (createdHere && targetId) await closeTarget(cdp.port, targetId);
      if (err && typeof err === 'object' && !err.targetId) err.targetId = targetId;
      throw err;
    }
  }

  /** 页面级事件：handler(method, params) → unsubscribe() */
  on(handler) {
    this._handlers.add(handler);
    return () => this._handlers.delete(handler);
  }

  _dispatch(method, params) {
    for (const h of Array.from(this._handlers)) {
      try {
        h(method, params);
      } catch (e) {
        /* ignore */
      }
    }
  }

  /** 发命令（自动带 sessionId）；第 3 个参数可传 { timeoutMs } */
  send(method, params = {}, opts = {}) {
    if (this._closed) return Promise.reject(new Error(`Page 已关闭: ${method}`));
    if (!this.sessionId) return Promise.reject(new Error(`Page 尚未 attach: ${method}`));
    return this.cdp.send(method, params, this.sessionId, opts || {});
  }

  /**
   * 在页面里求值。
   * - awaitPromise=true：表达式返回 Promise 时会等它
   * - 有 exceptionDetails 时抛 Error（含 text / exception.description）
   * - 找不到可序列化对象时返回 null
   */
  async evaluate(expr, { awaitPromise = true, returnByValue = true, timeoutMs = 20000 } = {}) {
    const res = await this.send(
      'Runtime.evaluate',
      {
        expression: String(expr),
        awaitPromise,
        returnByValue,
        userGesture: true,
        // 不用 includeCommandLineAPI / timeout 参数：老版本 Chromium 对未知参数会直接报错
      },
      { timeoutMs: Math.max(1000, timeoutMs) + 2000 },
    );
    if (res && res.exceptionDetails) {
      const details = res.exceptionDetails;
      const parts = [];
      if (details.text) parts.push(String(details.text));
      const ex = details.exception;
      if (ex) {
        if (ex.description) parts.push(String(ex.description));
        else if (ex.value !== undefined && ex.value !== null) parts.push(String(ex.value));
        else if (ex.unserializableValue !== undefined) parts.push(String(ex.unserializableValue));
      }
      const err = new Error(`evaluate 异常: ${parts.filter(Boolean).join('\n') || '未知异常'}`);
      err.exceptionDetails = details;
      throw err;
    }
    const r = res && res.result;
    if (!r) return null;
    if (Object.prototype.hasOwnProperty.call(r, 'value')) return r.value;
    // undefined / NaN / Infinity / 函数等无法按值序列化的，统一当 null
    return null;
  }

  /** 跳转并等 readyState==='complete'（最多 waitMs），随后再等 300ms 让首屏脚本跑完 */
  async goto(url, { waitMs = 9000 } = {}) {
    if (this._closed) throw new Error('Page 已关闭');
    const navTimeout = Math.max(4000, Math.min(waitMs, 20000));
    let nav = null;
    try {
      nav = await this.send('Page.navigate', { url: String(url), transitionType: 'typed' }, { timeoutMs: navTimeout });
    } catch (err) {
      // 被 beforeunload / confirm 弹窗挡住时，先接受弹窗再重试一次
      await this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      await sleep(250);
      nav = await this.send('Page.navigate', { url: String(url), transitionType: 'typed' }, { timeoutMs: navTimeout });
    }
    const started = Date.now();
    let ready = false;
    while (Date.now() - started < waitMs) {
      try {
        const state = await this.evaluate('document.readyState', { timeoutMs: 3000 });
        if (state === 'complete') {
          ready = true;
          break;
        }
      } catch (err) {
        /* 导航过程中执行上下文会被销毁，属正常，继续轮询 */
      }
      await sleep(150);
    }
    await sleep(300);
    const errorText = nav && nav.errorText;
    if (errorText && errorText !== 'net::ERR_ABORTED') {
      throw new Error(`页面跳转失败(${errorText}): ${url}`);
    }
    return ready;
  }

  /** 真实鼠标点击（视口坐标 CSS px） */
  async click(x, y) {
    const px = Number(x);
    const py = Number(y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) throw new Error(`非法点击坐标: ${x},${y}`);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none', buttons: 0, modifiers: 0 });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 });
    await sleep(90);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', buttons: 0, clickCount: 1, modifiers: 0 });
  }

  /** 滚轮（deltaY>0 向下） */
  async wheel(x, y, deltaY) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Number(x),
      y: Number(y),
      deltaX: 0,
      deltaY: Number(deltaY),
      button: 'none',
      buttons: 0,
      modifiers: 0,
    });
  }

  /** 覆盖视口尺寸（deviceScaleFactor=1、mobile=false） */
  async setViewport({ width, height, deviceScaleFactor = 1, mobile = false } = {}) {
    const w = Math.round(Number(width));
    const h = Math.round(Number(height));
    if (!(w > 0) || !(h > 0)) throw new Error(`非法 viewport: ${width}x${height}`);
    await this.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: Number(deviceScaleFactor) || 1, mobile: !!mobile });
  }

  /** 截图 → Buffer（PNG 可能几 MB，走的是同一条 WS，不能截断） */
  async screenshot({ format = 'png', quality, clip = null } = {}) {
    const fmt = format === 'jpeg' ? 'jpeg' : 'png';
    const params = { format: fmt, fromSurface: true };
    if (fmt === 'jpeg' && quality !== undefined && quality !== null) {
      params.quality = Math.max(0, Math.min(100, Math.round(Number(quality))));
    }
    if (clip) {
      params.clip = {
        x: Number(clip.x) || 0,
        y: Number(clip.y) || 0,
        width: Number(clip.width),
        height: Number(clip.height),
        scale: Number(clip.scale) || 1,
      };
      params.captureBeyondViewport = true;
    }
    const res = await this.send('Page.captureScreenshot', params, { timeoutMs: 60000 });
    if (!res || !res.data) throw new Error('Page.captureScreenshot 未返回 data');
    const buf = Buffer.from(res.data, 'base64');
    if (!buf.length) throw new Error('截图数据为空');
    return buf;
  }

  /** 关掉自己创建的 target（不 kill 浏览器） */
  async close() {
    if (this._closed) return;
    this._closed = true;
    this._handlers.clear();
    try {
      this._unsubCdp?.();
    } catch (e) {
      /* ignore */
    }
    this._unsubCdp = null;
    try {
      await closeTarget(this.cdp.port, this.targetId);
    } catch (e) {
      /* ignore */
    }
  }
}

export default { Cdp, Page, SPOOF_SOURCE, getJson, getText, browserInfo, listTargets, closeTarget };
