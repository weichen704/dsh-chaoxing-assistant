// lib/ws.mjs —— 零依赖 RFC6455 WebSocket 客户端（CDP 专用底层内核）
//
// 背景：真实运行环境是 Electron 主进程的 Node（可能是 Node 20，没有全局 WebSocket），
// 所以这里用 node:net 自实现一个最小可用客户端；若宿主有 globalThis.WebSocket 则优先用它。
//
// 针对 CDP 的取舍：
//   - 握手不带 Origin 头（Chrome/Edge 会拒绝带 Origin 的 DevTools WebSocket 升级）
//   - 客户端发出的帧必须掩码；长度支持 7 位 / 16 位(126) / 64 位(127)
//   - 必须能收超大消息：单条 CDP 消息（截图 base64）可能好几 MB
//   - 必须支持分片重组（continuation 帧）、服务端 ping 回 pong、close 回执
//   - 连接错误/关闭时要通知上层，让所有 pending 请求被 reject
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
// 单条消息上限：足够容纳几 MB 截图，同时防跑飞
const MAX_MESSAGE_BYTES = 256 * 1024 * 1024;
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BIN = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** RFC6455 的 Sec-WebSocket-Accept 计算 */
function acceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

/** 解析 ws:// wss:// URL */
function parseWsUrl(url) {
  const u = new URL(String(url));
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
    throw new Error(`不是 WebSocket URL: ${url}`);
  }
  const secure = u.protocol === 'wss:';
  const host = u.hostname || '127.0.0.1';
  const port = Number(u.port || (secure ? 443 : 80));
  const path = `${u.pathname || '/'}${u.search || ''}`;
  return { secure, host, port, path, hostHeader: `${host}:${port}` };
}

/**
 * 消息分发中心。
 * 关键点：连接建立后、上层还来不及注册 onMessage 时到达的消息不能丢
 * （握手响应和第一批帧可能同一个 TCP 包到达），这里先缓存，等第一个订阅者出现再补发。
 */
function createMessageHub() {
  const cbs = new Set();
  const backlog = [];
  let backlogBytes = 0;
  return {
    add(cb) {
      cbs.add(cb);
      if (backlog.length) {
        const q = backlog.splice(0, backlog.length);
        backlogBytes = 0;
        for (const text of q) {
          for (const c of Array.from(cbs)) {
            try {
              c(text);
            } catch (e) {
              /* ignore */
            }
          }
        }
      }
      return () => cbs.delete(cb);
    },
    emit(text) {
      if (!cbs.size) {
        // 最多缓存 64 条 / 8MB，防止没人订阅时无限增长
        if (backlog.length < 64 && backlogBytes + text.length <= 8 * 1024 * 1024) {
          backlog.push(text);
          backlogBytes += text.length;
        }
        return;
      }
      for (const c of Array.from(cbs)) {
        try {
          c(text);
        } catch (e) {
          /* ignore */
        }
      }
    },
  };
}

/**
 * 字节队列：避免数据块反复 concat 造成 O(n^2)（几 MB 的截图消息会很明显）。
 * peek(n) 只读不消费，read(n) 消费。
 */
class ByteQueue {
  constructor() {
    this._parts = [];
    this._off = 0;
    this.length = 0;
  }

  push(buf) {
    if (buf && buf.length) {
      this._parts.push(buf);
      this.length += buf.length;
    }
  }

  peek(n) {
    if (this.length < n) return null;
    const first = this._parts[0];
    if (first.length - this._off >= n) return first.subarray(this._off, this._off + n);
    const out = Buffer.allocUnsafe(n);
    let copied = 0;
    let idx = 0;
    let off = this._off;
    while (copied < n) {
      const p = this._parts[idx];
      const take = Math.min(p.length - off, n - copied);
      p.copy(out, copied, off, off + take);
      copied += take;
      off = 0;
      idx += 1;
    }
    return out;
  }

  read(n) {
    if (this.length < n) return null;
    const first = this._parts[0];
    let out;
    if (first.length - this._off >= n) {
      out = first.subarray(this._off, this._off + n);
      this._off += n;
      if (this._off === first.length) {
        this._parts.shift();
        this._off = 0;
      }
    } else {
      out = Buffer.allocUnsafe(n);
      let copied = 0;
      while (copied < n) {
        const p = this._parts[0];
        const off = this._off;
        const take = Math.min(p.length - off, n - copied);
        p.copy(out, copied, off, off + take);
        copied += take;
        this._off += take;
        if (this._off === p.length) {
          this._parts.shift();
          this._off = 0;
        }
      }
    }
    this.length -= n;
    return out;
  }
}

/**
 * node:net 实现的 WebSocket 客户端。
 * 对外接口（与全局 WebSocket 适配器保持一致）：
 *   sendText(str) / onMessage(cb) / onClose(cb) / close()
 */
export class WsClient {
  constructor(socket) {
    this.kind = 'net';
    this._socket = socket;
    this._inbox = new ByteQueue();
    this._hub = createMessageHub();
    this._closeCbs = new Set();
    this._fragOpcode = 0;
    this._fragParts = [];
    this._fragBytes = 0;
    this._closed = false;
    this._closeInfo = null;
    this._drainQueue = [];
    this._draining = false;

    try {
      socket.setNoDelay(true);
    } catch (e) {
      /* ignore */
    }

    socket.on('data', (chunk) => {
      this._inbox.push(chunk);
      try {
        this._pump();
      } catch (err) {
        this._protocolError(err);
      }
    });
    socket.on('drain', () => {
      this._draining = false;
      this._flushWrites();
    });
    socket.on('error', (err) => {
      this._finish({ code: 1006, reason: String((err && err.message) || err) });
    });
    socket.on('close', () => {
      this._finish({ code: 1006, reason: 'socket closed' });
    });
    socket.on('end', () => {
      this._finish({ code: 1006, reason: 'socket ended' });
    });
  }

  // ---- 对外 API ----

  /** 发一条文本帧（CDP 全是 JSON 文本） */
  sendText(str) {
    this._sendFrame(OP_TEXT, Buffer.from(String(str), 'utf8'));
  }

  /** sendText 的别名，方便调用 */
  send(str) {
    this.sendText(str);
  }

  /** 注册消息回调（text 字符串），返回取消订阅函数 */
  onMessage(cb) {
    return this._hub.add(cb);
  }

  /** 注册关闭回调，返回取消订阅函数 */
  onClose(cb) {
    this._closeCbs.add(cb);
    if (this._closed) {
      try {
        cb(this._closeInfo || { code: 1000, reason: 'closed' });
      } catch (e) {
        /* ignore */
      }
    }
    return () => this._closeCbs.delete(cb);
  }

  /** 主动关闭：先发 close 帧，再 end；短暂兜底 destroy */
  close(code = 1000, reason = '') {
    if (this._closed) return;
    try {
      this._sendFrame(OP_CLOSE, makeClosePayload(code, reason));
    } catch (e) {
      /* ignore */
    }
    try {
      this._socket.end();
    } catch (e) {
      /* ignore */
    }
    const sock = this._socket;
    setTimeout(() => {
      try {
        if (!sock.destroyed) sock.destroy();
      } catch (e) {
        /* ignore */
      }
    }, 400).unref?.();
    this._finish({ code, reason });
  }

  // ---- 内部：发送 ----

  _write(buf) {
    if (this._closed) throw new Error('WebSocket 已关闭');
    const sock = this._socket;
    if (!sock || sock.destroyed) throw new Error('WebSocket socket 已销毁');
    this._drainQueue.push(buf);
    this._flushWrites();
  }

  _flushWrites() {
    if (this._draining || this._closed) return;
    const sock = this._socket;
    while (this._drainQueue.length) {
      const buf = this._drainQueue[0];
      let ok = false;
      try {
        ok = sock.write(buf);
      } catch (err) {
        this._finish({ code: 1006, reason: String((err && err.message) || err) });
        return;
      }
      this._drainQueue.shift();
      if (!ok) {
        this._draining = true;
        return;
      }
    }
  }

  /** 组帧：FIN=1 + 客户端掩码 */
  _sendFrame(opcode, payload) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const len = data.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | len;
    } else if (len <= 0xffff) {
      header = Buffer.allocUnsafe(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = crypto.randomBytes(4);
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i += 1) masked[i] = data[i] ^ mask[i & 3];
    this._write(Buffer.concat([header, mask, masked], header.length + 4 + len));
  }

  // ---- 内部：接收 ----

  _pump() {
    if (this._closed) return;
    for (;;) {
      if (this._inbox.length < 2) return;
      const head = this._inbox.peek(2);
      if (!head) return;
      const b0 = head[0];
      const b1 = head[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let headerLen = 2;
      if (len === 126) {
        const ext = this._inbox.peek(4);
        if (!ext) return;
        len = ext.readUInt16BE(2);
        headerLen = 4;
      } else if (len === 127) {
        const ext = this._inbox.peek(10);
        if (!ext) return;
        const big = ext.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE_BYTES)) {
          this._protocolError(new Error(`WebSocket 帧过大: ${big} 字节`));
          return;
        }
        len = Number(big);
        headerLen = 10;
      }
      if (masked) headerLen += 4;
      if (len > MAX_MESSAGE_BYTES) {
        this._protocolError(new Error(`WebSocket 帧过大: ${len} 字节`));
        return;
      }
      if (this._inbox.length < headerLen + len) return; // 等更多数据
      const frame = this._inbox.read(headerLen + len);
      const payload = frame.subarray(headerLen);
      if (masked) {
        const mask = frame.subarray(headerLen - 4, headerLen);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
      }
      this._handleFrame(fin, opcode, payload);
    }
  }

  _handleFrame(fin, opcode, payload) {
    switch (opcode) {
      case OP_TEXT:
      case OP_BIN: {
        if (fin) {
          this._deliver(payload);
        } else {
          this._fragOpcode = opcode;
          this._fragParts = [Buffer.from(payload)];
          this._fragBytes = payload.length;
        }
        return;
      }
      case OP_CONT: {
        if (!this._fragOpcode) {
          this._protocolError(new Error('收到意外的 continuation 帧'));
          return;
        }
        this._fragParts.push(Buffer.from(payload));
        this._fragBytes += payload.length;
        if (this._fragBytes > MAX_MESSAGE_BYTES) {
          this._protocolError(new Error(`WebSocket 分片消息过大: ${this._fragBytes} 字节`));
          return;
        }
        if (fin) {
          const full = Buffer.concat(this._fragParts, this._fragBytes);
          this._fragOpcode = 0;
          this._fragParts = [];
          this._fragBytes = 0;
          this._deliver(full);
        }
        return;
      }
      case OP_PING: {
        try {
          this._sendFrame(OP_PONG, payload);
        } catch (e) {
          /* ignore */
        }
        return;
      }
      case OP_PONG:
        return;
      case OP_CLOSE: {
        let code = 1000;
        let reason = '';
        if (payload.length >= 2) {
          code = payload.readUInt16BE(0);
          reason = payload.subarray(2).toString('utf8');
        }
        try {
          this._sendFrame(OP_CLOSE, makeClosePayload(code, ''));
        } catch (e) {
          /* ignore */
        }
        try {
          this._socket.end();
        } catch (e) {
          /* ignore */
        }
        this._finish({ code, reason });
        return;
      }
      default:
        // 未知 opcode：忽略（不协商扩展）
        return;
    }
  }

  _deliver(buf) {
    if (!buf || !buf.length) {
      // 空文本帧也要回调（CDP 不会发，但别吞）
      this._emit('');
      return;
    }
    // 分片重组后才解码，避免多字节 UTF-8 被切断
    this._emit(buf.toString('utf8'));
  }

  _emit(text) {
    this._hub.emit(text);
  }

  _protocolError(err) {
    try {
      this._sendFrame(OP_CLOSE, makeClosePayload(1002, 'protocol error'));
    } catch (e) {
      /* ignore */
    }
    this._finish({ code: 1006, reason: String((err && err.message) || err) });
    try {
      this._socket.destroy();
    } catch (e) {
      /* ignore */
    }
  }

  _finish(info) {
    if (this._closed) return;
    this._closed = true;
    this._closeInfo = info;
    this._drainQueue.length = 0;
    for (const cb of Array.from(this._closeCbs)) {
      try {
        cb(info);
      } catch (e) {
        /* ignore */
      }
    }
  }
}

function makeClosePayload(code, reason) {
  const body = Buffer.from(String(reason || ''), 'utf8').subarray(0, 123);
  const buf = Buffer.allocUnsafe(2 + body.length);
  buf.writeUInt16BE(code, 0);
  body.copy(buf, 2);
  return buf;
}

/**
 * 用 node:net 建连 + 手写 WS 握手。
 * 注意：不发送 Origin 头 —— Chrome/Edge 的 DevTools WebSocket 会拒绝带 Origin 的升级请求。
 */
export function openTcpWebSocket(url, timeoutMs = 8000) {
  const { secure, host, port, path, hostHeader } = parseWsUrl(url);
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    let settled = false;
    let buf = Buffer.alloc(0);
    const sock = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    const timer = setTimeout(() => fail(new Error(`WebSocket 握手超时(${timeoutMs}ms): ${url}`)), timeoutMs);
    timer.unref?.();

    function cleanupHandshake() {
      clearTimeout(timer);
      sock.removeListener('data', onData);
      sock.removeListener('error', fail);
      sock.removeListener('close', onHandshakeClose);
      sock.removeListener('connect', onConnect);
    }

    function fail(err) {
      if (settled) return;
      settled = true;
      cleanupHandshake();
      try {
        sock.destroy();
      } catch (e) {
        /* ignore */
      }
      reject(err instanceof Error ? err : new Error(String(err)));
    }

    function onConnect() {
      const req = [
        `GET ${path} HTTP/1.1`,
        `Host: ${hostHeader}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n');
      try {
        sock.write(req, 'latin1');
      } catch (err) {
        fail(err);
      }
    }

    function onHandshakeClose() {
      fail(new Error(`WebSocket 握手期间连接被关闭: ${url}`));
    }

    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) {
        if (buf.length > 65536) fail(new Error('WebSocket 握手响应头过长'));
        return;
      }
      const head = buf.subarray(0, idx).toString('latin1');
      const rest = buf.subarray(idx + 4);
      const lines = head.split('\r\n');
      const statusLine = lines.shift() || '';
      const m = /^HTTP\/1\.\d\s+(\d{3})/.exec(statusLine);
      const status = m ? Number(m[1]) : 0;
      if (status !== 101) {
        fail(new Error(`WebSocket 握手被拒绝(${status}): ${statusLine}`));
        return;
      }
      const headers = {};
      for (const line of lines) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      const accept = headers['sec-websocket-accept'];
      if (accept && accept !== acceptKey(key)) {
        fail(new Error('WebSocket 握手 Sec-WebSocket-Accept 校验失败'));
        return;
      }
      settled = true;
      cleanupHandshake();
      const client = new WsClient(sock);
      if (rest.length) {
        client._inbox.push(rest);
        try {
          client._pump();
        } catch (err) {
          client._protocolError(err);
        }
      }
      resolve(client);
    }

    sock.once(secure ? 'secureConnect' : 'connect', onConnect);
    sock.on('data', onData);
    sock.on('error', fail);
    sock.on('close', onHandshakeClose);
  });
}

/** 全局 WebSocket（Node 22+/Electron 新版可能有）适配成与 WsClient 相同的接口 */
function openGlobalWebSocket(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const WS = globalThis.WebSocket;
    let ws;
    try {
      ws = new WS(url);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let settled = false;
    const hub = createMessageHub();
    const closeCbs = new Set();
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch (e) {
        /* ignore */
      }
      reject(new Error(`WebSocket 连接超时(${timeoutMs}ms): ${url}`));
    }, timeoutMs);
    timer.unref?.();

    const adapter = {
      kind: 'global',
      sendText(str) {
        if (settled && adapter._closed) throw new Error('WebSocket 已关闭');
        ws.send(String(str));
      },
      send(str) {
        adapter.sendText(str);
      },
      onMessage(cb) {
        return hub.add(cb);
      },
      onClose(cb) {
        closeCbs.add(cb);
        return () => closeCbs.delete(cb);
      },
      close() {
        if (adapter._closed) return;
        adapter._closed = true;
        try {
          ws.close();
        } catch (e) {
          /* ignore */
        }
      },
      _closed: false,
    };

    ws.addEventListener('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(adapter);
    });
    ws.addEventListener('message', (ev) => {
      const data = ev && ev.data;
      let text = null;
      if (typeof data === 'string') text = data;
      else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString('utf8');
      else if (ArrayBuffer.isView(data)) text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
      else if (data && typeof data.text === 'function') {
        // Blob：异步读取（CDP 只发文本帧，正常走不到这里）
        data.text().then((t) => hub.emit(t));
        return;
      }
      if (text == null) return;
      hub.emit(text);
    });
    const onGone = (info) => {
      adapter._closed = true;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`WebSocket 连接失败: ${url}${info && info.reason ? ' ' + info.reason : ''}`));
        return;
      }
      for (const cb of Array.from(closeCbs)) {
        try {
          cb(info || { code: 1006, reason: 'closed' });
        } catch (e) {
          /* ignore */
        }
      }
    };
    ws.addEventListener('close', (ev) => onGone({ code: (ev && ev.code) || 1006, reason: (ev && ev.reason) || '' }));
    ws.addEventListener('error', (ev) => {
      // 全局实现的 error 事件不带细节；close 事件随后会到
      if (!settled) {
        onGone({ code: 1006, reason: (ev && ev.message) || 'websocket error' });
      }
    });
  });
}

/** 宿主是否有全局 WebSocket */
export function hasGlobalWebSocket() {
  return typeof globalThis.WebSocket === 'function';
}

/**
 * 打开一条 WebSocket 连接，返回统一接口对象 { sendText, onMessage, onClose, close }。
 * preferGlobal=true 时优先使用 globalThis.WebSocket，失败则回退到 node:net 实现。
 */
export async function openWebSocket(url, { timeoutMs = 8000, preferGlobal = true } = {}) {
  let globalErr = null;
  if (preferGlobal && hasGlobalWebSocket()) {
    try {
      return await openGlobalWebSocket(url, timeoutMs);
    } catch (err) {
      globalErr = err; // 全局实现失败 → 回退到自实现
    }
  }
  try {
    return await openTcpWebSocket(url, timeoutMs);
  } catch (err) {
    if (globalErr) {
      err.message = `${err.message}（全局 WebSocket 也失败: ${globalErr.message}）`;
    }
    throw err;
  }
}

export default { WsClient, openWebSocket, openTcpWebSocket, hasGlobalWebSocket };
