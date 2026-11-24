// @copylee/dsh-computer-use 桥：把它的 agent 工具（computer / computer_batch / windows ...）
// 当成「真实鼠标键盘后端」来调用。
//
// 背景：那个插件只注册 agent 工具（ctx.tools.register），没有对外暴露宿主服务；
// 但宿主 tools 服务本身提供了 execute(calls) 通道，所以本插件可以在自己的逻辑里
// 以"代 agent 调用工具"的方式使用它 —— 刷课做题需要点鼠标/敲键盘时自动走这条路，
// 拿不到工具（未安装/未授予控制权）时退回内置的 PowerShell(UIA) 驱动。
import { spawnSync } from 'node:child_process';
import { sleep } from './util.mjs';

const RESULT_TOOLS = /^(computer|computer_batch|windows|ui_elements|open_application|clipboard|request_access|list_granted_applications|switch_display|app_skill)$/;

/** 在 tools.execute 的返回值里找到那次工具执行的结果对象（{isError, value, content}） */
function findExecResult(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (typeof node.isError === 'boolean' && 'content' in node) return node;
  if (Array.isArray(node)) {
    for (const v of node) {
      const r = findExecResult(v, depth + 1);
      if (r) return r;
    }
    return null;
  }
  for (const v of Object.values(node)) {
    const r = findExecResult(v, depth + 1);
    if (r) return r;
  }
  return null;
}

/** 取一次工具执行结果里的文本（拼起来） */
function textOf(exec) {
  if (!exec || !Array.isArray(exec.content)) return '';
  return exec.content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function imageSize(buf) {
  if (!buf || buf.length < 32) return null;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // JPEG：扫 SOF0/1/2 段
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const m = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xc3) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}

function imageOf(content) {
  const blocks = Array.isArray(content) ? content : [];
  for (const b of blocks) {
    if (!b) continue;
    const src = b.source || b;
    const data = src && (src.data || src.base64 || src.image || src.url);
    if (b.type === 'image' && typeof data === 'string') {
      try {
        return { size: imageSize(Buffer.from(data, 'base64')), data };
      } catch {
        return { size: null, data };
      }
    }
  }
  return null;
}

/** 从 windows 列表文本里取出某个窗口的矩形：(left, top)-(right, bottom) → 截图坐标
 *  needle 必须只认「学习通客户端本体」：DSH 自己的聊天窗口标题里经常带「学习通」（会话标题就取自
 *  用户的问题），它在 windows 列表里排第一位、还常是 FOREGROUND，旧版按 /学习通|cxstudy/ 直接命中
 *  它，scale 从 0.5256 变成 1020/2582=0.395，之后每次点击都往外偏最多 168px（窗口边缘），
 *  导航、标签、课程卡片一律点不中 → not-on-list / not-course-page / course-not-found。 */
export function parseWinRect(text, needle = /cxstudy\.exe/i) {
  const lines = String(text || '').split(/\r?\n/);
  const find = (re) => {
    for (const line of lines) {
      // 先排掉 DSH 自己的窗口（它的标题里可能带「学习通」，尺寸/坐标都不是客户端）
      if (/DeepSeek Harness/i.test(line)) continue;
      if (!re.test(line)) continue;
      const m = line.match(/\((-?\d+),\s*(-?\d+)\)\s*-\s*\((-?\d+),\s*(-?\d+)\)/);
      if (!m) continue;
      const left = +m[1];
      const top = +m[2];
      const w = +m[3] - left + 1;
      const h = +m[4] - top + 1;
      if (w > 100 && h > 100) return { left, top, w, h, line: line.trim().slice(0, 160) };
    }
    return null;
  };
  // 主判据：进程名 cxstudy.exe；退路：标题里带「学习通」（已排除 DSH 窗口）
  return find(needle) || find(/学习通/);
}

export class ComputerUse {
  constructor({ ctx, log = () => {}, enabled = true } = {}) {
    this.ctx = ctx;
    this.log = log;
    this.enabled = enabled !== false;
    this._avail = undefined;
    this.scale = 0; // 截图px / 物理px
    this.screen = null; // {x,y,w,h} 物理像素（主屏）
    this.shot = null; // {w,h} 截图尺寸
    this.cuWin = null; // computer-use 眼里的窗口矩形（截图像素）
    this.psRect = null; // PowerShell/UIA 眼里的窗口矩形（物理像素）
    this.failures = 0;
    this.lastDiag = null;
  }

  /** 由 DeskV2 在每次动作前告知「窗口在物理像素里的位置」 */
  setWindowRect(rect) {
    if (rect && rect.w > 100 && rect.h > 100) this.psRect = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  }

  _tools() {
    try {
      const t = this.ctx && (typeof this.ctx.get === 'function' ? this.ctx.get('tools') : this.ctx.tools);
      return t || null;
    } catch {
      return null;
    }
  }

  /** 宿主里是否装了 @copylee/dsh-computer-use（看 computer 工具是否可见） */
  available() {
    if (!this.enabled) return false;
    if (this._avail !== undefined) return this._avail;
    const t = this._tools();
    let ok = false;
    try {
      ok = !!(t && typeof t.execute === 'function' && typeof t.get === 'function' && t.get('computer') && t.get('computer_batch'));
    } catch {
      ok = false;
    }
    this._avail = ok;
    this.log({ ev: 'cu-available', ok });
    return ok;
  }

  /**
   * 取一个活着的 Agent。computer-use 的输入授权是「按 session 记账」的：
   * 没有 agent 时它永远认为未授权（per-app 模式）；带上 agent 后，如果该会话的
   * 审批策略是 never，它会把这次调用当成 autoApprove（内部等价 allow-all）。
   *
   * 注意：宿主 agents.list() 里可能混着**已经不在 computer-use 账本里**的旧 session
   *（插件热加载后会这样），所以不能只取第一个，要按顺序试到能真的执行工具为止。
   */
  agent() {
    if (this._agent !== undefined) return this._agent;
    this._agent = null;
    this._cands = [];
    try {
      const agents = this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('agents') : null;
      if (agents && typeof agents.list === 'function') {
        const list = agents.list() || [];
        const cur = typeof agents.currentInitiator === 'function' ? agents.currentInitiator() : undefined;
        const all = [cur, ...list].filter((a) => a && a.id);
        const seen = new Set();
        for (const a of all) {
          if (seen.has(a.id)) continue;
          seen.add(a.id);
          this._cands.push(a);
        }
        // currentInitiator 优先，其余按「越新越可能活着」排序
        this._cands.sort((a, b) => (b === cur ? 1 : 0) - (a === cur ? 1 : 0));
        this._agent = this._cands[0] || null;
        this._agentId = (this._agent && this._agent.id) || null;
      }
    } catch {
      /* ignore */
    }
    this.log({ ev: 'cu-agent', id: this._agentId || null, cands: (this._cands || []).length });
    return this._agent;
  }

  /** 当前 agent 失效（session 不在 computer-use 账本里）时，换下一个候选 */
  nextAgent() {
    const cands = this._cands || [];
    const i = cands.indexOf(this._agent);
    const next = cands[i + 1] || null;
    this._agent = next;
    this._agentId = (next && next.id) || null;
    if (!next) this._agentOk = false;
    return next;
  }

  /** 以「代 agent 调用工具」的方式执行一次 computer-use 工具 */
  async call(name, args = {}, { timeoutMs = 90000 } = {}) {
    if (!RESULT_TOOLS.test(name)) throw new Error('不是 computer-use 工具: ' + name);
    const t = this._tools();
    if (!t || typeof t.execute !== 'function') throw new Error('宿主没有 tools.execute');
    const id = 'cu_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const ag = this.agentOk === false ? null : this.agent();
    const run = async (agent) => {
      const out = await t.execute({
        calls: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }],
        signal: AbortSignal.timeout(timeoutMs),
        ...(agent ? { agent } : {}),
      });
      return findExecResult(out) || { isError: true, content: [{ type: 'text', text: 'no-result' }], value: null };
    };
    let exec = await run(ag);
    const firstText = (Array.isArray(exec.content) ? exec.content : [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
    // 有的部署里带 agent 反而过不了「步骤准入」（UNKNOWN_TOOL）→ 退回不带 agent 的调用并记住
    if (ag && exec.isError && /UNKNOWN_TOOL|unknown tool|not admitted|admission|no executor/i.test(firstText)) {
      this.agentOk = false;
      this.log({ ev: 'cu-agent-off', why: firstText.slice(0, 120) });
      exec = await run(null);
    } else if (ag && exec.isError && /not live in this store|is not live|unknown session/i.test(firstText)) {
      // 这个 session 已经不在 computer-use 账本里（插件热加载后很常见）→ 换下一个候选
      for (let i = 0; i < 8; i++) {
        const next = this.nextAgent();
        if (!next) break;
        this.log({ ev: 'cu-agent-next', id: next.id || null });
        const e2 = await run(next);
        if (!(e2.isError && /not live in this store|is not live|unknown session/i.test(textOf(e2)))) {
          exec = e2;
          break;
        }
        exec = e2;
      }
    }
    if (!exec) return { ok: false, err: 'no-result', raw: 'empty' };
    const text = (Array.isArray(exec.content) ? exec.content : [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
    const img = imageOf(exec.content);
    const contentTypes = Array.isArray(exec.content)
      ? exec.content.map((b) => (b && (b.type || typeof b)) || '?').join(',')
      : typeof exec.content;
    this.lastCall = { name, ok: !exec.isError, hasImg: !!img, contentTypes, textLen: text.length };
    return { ok: !exec.isError, err: exec.isError ? text.slice(0, 400) : '', text, img, contentTypes, value: exec.value };
  }

  /** 读主屏物理分辨率（缓存） */
  _readScreen() {
    if (this.screen) return this.screen;
    const ps = 'Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; "$($b.X),$($b.Y),$($b.Width),$($b.Height)"';
    try {
      const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      const m = String(r.stdout || '').trim().match(/^(-?\d+),(-?\d+),(\d+),(\d+)$/);
      if (m) this.screen = { x: +m[1], y: +m[2], w: +m[3], h: +m[4] };
    } catch {
      /* ignore */
    }
    return this.screen;
  }

  /**
   * 校准坐标换算。最可靠的做法不是算屏幕缩放，而是拿「同一个窗口」在两边的矩形对比：
   *   - PowerShell/UIA 给的 rect（物理像素）
   *   - computer-use 的 windows 列表里的矩形（截图像素）
   * scale = 截图窗口宽 / 物理窗口宽，点击位置 = 截图窗口左上角 + 窗口内坐标 * scale。
   */
  async calibrate({ force = false } = {}) {
    if (!this.available()) return false;
    if (this.cuWin && this.psRect && !force) return true;
    // 1) 用 CU 的窗口列表拿窗口矩形
    try {
      const r = await this.call('windows', { action: 'list' }, { timeoutMs: 30000 });
      if (r.ok) {
        const win = parseWinRect(r.text);
        if (win) this.cuWin = win;
      }
      if (!this._winText) this._winText = r.text;
    } catch (e) {
      this.log({ ev: 'cu-windows-fail', err: String((e && e.message) || e).slice(0, 200) });
    }
    if (this.cuWin && this.psRect) {
      this.scale = this.cuWin.w / this.psRect.w;
      this.log({ ev: 'cu-calibrate', via: 'windows', cuWin: this.cuWin, psRect: this.psRect, scale: Number(this.scale.toFixed(4)) });
      return true;
    }
    // 2) 退路：截图宽度 / 主屏宽度
    const r = await this.call('computer', { action: 'screenshot' }, { timeoutMs: 60000 });
    const size = r.img && r.img.size;
    this.lastDiag = { ok: r.ok, err: r.err, hasImg: !!r.img, contentTypes: r.contentTypes || null };
    if (!size) {
      this.log({ ev: 'cu-calibrate-fail', ...this.lastDiag });
      return false;
    }
    const screen = this._readScreen();
    if (!screen) return false;
    this.shot = size;
    this.scale = size.w / screen.w;
    if (this.psRect) {
      // 用缩放比把 psRect 投到截图坐标上
      const left = Math.round((this.psRect.x - screen.x) * this.scale);
      const top = Math.round((this.psRect.y - screen.y) * this.scale);
      this.cuWin = { left, top, w: Math.round(this.psRect.w * this.scale), h: Math.round(this.psRect.h * this.scale) };
    }
    this.log({ ev: 'cu-calibrate', via: 'screen', shot: size, screen, scale: Number(this.scale.toFixed(4)) });
    return true;
  }

  /** 物理屏幕坐标 → 截图坐标 */
  toShot(px, py) {
    if (!(this.scale > 0)) throw new Error('CU 未校准');
    const s = this.screen || { x: 0, y: 0 };
    return { x: Math.round((px - s.x) * this.scale), y: Math.round((py - s.y) * this.scale) };
  }

  /** 窗口内相对坐标 → 截图坐标（winRect 为物理屏幕坐标） */
  toShotInRect(rect, rx, ry) {
    if (this.cuWin && this.scale > 0) {
      return { x: Math.round(this.cuWin.left + rx * this.scale), y: Math.round(this.cuWin.top + ry * this.scale) };
    }
    return this.toShot(rect.x + rx, rect.y + ry);
  }

  async clickShot(x, y) {
    const r = await this.call('computer', { action: 'left_click', coordinate: [Math.round(x), Math.round(y)] });
    if (!r.ok) throw new Error('CU 点击失败：' + (r.err || 'unknown'));
    return r;
  }

  async clickInRect(rect, rx, ry) {
    if (!(await this.calibrate())) throw new Error('CU 不可用');
    const p = this.toShotInRect(rect, rx, ry);
    return this.clickShot(p.x, p.y);
  }

  async moveInRect(rect, rx, ry) {
    if (!(await this.calibrate())) throw new Error('CU 不可用');
    const p = this.toShotInRect(rect, rx, ry);
    const r = await this.call('computer', { action: 'mouse_move', coordinate: [p.x, p.y] });
    if (!r.ok) throw new Error('CU 移动鼠标失败：' + (r.err || 'unknown'));
    return r;
  }

  async moveShot(x, y) {
    if (!(await this.calibrate())) throw new Error('CU 不可用');
    const r = await this.call('computer', { action: 'mouse_move', coordinate: [Math.round(x), Math.round(y)] });
    if (!r.ok) throw new Error('CU 移动鼠标失败：' + (r.err || 'unknown'));
    return r;
  }

  /** 敲键盘：keys 形如 'Return' / 'ctrl+a' / 'PGDN' 兼容写法 */
  async press(keys) {
    const k = String(keys || '').replace(/^\{|\}$/g, '').replace(/\bPGDN\b/i, 'Page_Down').replace(/\bPGUP\b/i, 'Page_Up');
    const r = await this.call('computer', { action: 'key', text: k });
    if (!r.ok) throw new Error('CU 按键失败：' + (r.err || 'unknown'));
    return r;
  }

  /** 输入文本（会先点目标再输入；这里只做键入，调用方先点击输入框） */
  async typeText(text, opts = {}) {
    const args = { action: 'type', text: String(text ?? '') };
    if (opts && opts.target) args.target = String(opts.target);
    if (opts && Array.isArray(opts.coordinate)) args.coordinate = opts.coordinate;
    const r = await this.call('computer', args);
    if (!r.ok) throw new Error('CU 输入失败：' + (r.err || 'unknown'));
    return r;
  }

  /** 滚轮 */
  async scroll(direction, amount = 5, atShot = null) {
    const args = { action: 'scroll', scroll_direction: direction, scroll_amount: amount };
    if (atShot) args.coordinate = [Math.round(atShot.x), Math.round(atShot.y)];
    const r = await this.call('computer', args);
    if (!r.ok) throw new Error('CU 滚轮失败：' + (r.err || 'unknown'));
    return r;
  }

  /** 打开/激活应用（会自动清掉 ELECTRON_RUN_AS_NODE 的坑由调用方负责） */
  async openApp(name) {
    const r = await this.call('open_application', { name }, { timeoutMs: 120000 });
    if (!r.ok) throw new Error('CU 打开应用失败：' + (r.err || 'unknown'));
    return r;
  }

  async windows() {
    const r = await this.call('windows', { action: 'list' });
    return r.ok ? r.text : '';
  }

  async focusWindow(name) {
    const r = await this.call('windows', { action: 'focus', name }, { timeoutMs: 30000 });
    if (!r.ok) throw new Error('CU 聚焦窗口失败：' + (r.err || 'unknown'));
    return r;
  }

  /**
   * 申请控制某个应用（computer-use 的输入只对已授权的应用生效）。
   * 已经从会话里授权过就会直接返回 granted；未授权时宿主会弹一次批准。
   */
  async ensureAccess(apps = ['学习通']) {
    // 带上活着的 Agent 时，computer-use 会按会话审批策略自动放行（策略为 never → autoApprove），
    // 不需要也不应该再调 request_access（插件侧调用没有审批通道，必然失败）。
    if (this.agent()) {
      this.log({ ev: 'cu-access', ok: true, via: 'agent' });
      return true;
    }
    try {
      const r = await this.call('request_access', { apps, reason: '刷课做题需要控制学习通客户端' }, { timeoutMs: 120000 });
      this.log({ ev: 'cu-access', ok: r.ok, text: (r.text || r.err || '').slice(0, 200) });
      return r.ok;
    } catch (e) {
      this.log({ ev: 'cu-access-fail', err: String((e && e.message) || e).slice(0, 200) });
      return false;
    }
  }

  /** 连续动作（一个 computer_batch 调用里跑完，最快） */
  async batch(actions) {
    const r = await this.call('computer_batch', { actions, finish: 'screenshot' }, { timeoutMs: 180000 });
    if (!r.ok) throw new Error('CU 批量动作失败：' + (r.err || 'unknown'));
    return r;
  }

  /** 读窗口文字（UIA，只对非 webview 控件有效） */
  async windowText() {
    const r = await this.call('ui_elements', { text: true, tail: 3000 });
    return r.ok ? r.text : '';
  }
}

export default ComputerUse;
