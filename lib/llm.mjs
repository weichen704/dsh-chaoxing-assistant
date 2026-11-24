// 宿主大模型（llm 服务）接入层：路由解析、流式取文本、JSON 容错解析。
// 只使用 Node 内建能力；模块顶层不访问 ctx —— 插件可能在 llm 服务不存在时被 import。
//
// 宿主契约（已由 cordis inspect 确认）：
//   ctx.get('llm')               -> { stream(options), listProviders(), listModels(provider) }
//   ctx.get('agentDefaultModel') -> { currentSelection() }
//   llm.stream(options)          -> AsyncIterable<StreamChunk>
//   StreamChunk:
//     { type:'text-delta', index, text }
//     { type:'block-start', ... } / { type:'block-end', index, block }
//     { type:'usage', usage:{ inputTokens, outputTokens, totalTokens? } }
//     { type:'finish', reason:{ kind:'stop'|'tool-calls'|'max-tokens'|'error'|'aborted', failure? } }
//
// 兼容性要点：
//   - resolveRoute 会读 ctx.get('llm') / ctx.get('agentDefaultModel')，但只在函数里读；
//   - stream options 里不能留 undefined 空键：provider/model/reasoningEffort/system 都按需添加；
//   - reasoningEffort 只有在显式给出（构造参数 / 环境变量 / 当前选择）时才传。

const ENV_PROVIDER = 'CHAOXING_LLM_PROVIDER';
const ENV_MODEL = 'CHAOXING_LLM_MODEL';
const ENV_REASONING = 'CHAOXING_LLM_REASONING';

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function head(s, n = 300) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function errText(e) {
  if (!e) return 'unknown error';
  return String(e.message || e).slice(0, 300);
}

function positiveInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function getService(ctx, name) {
  if (!ctx || typeof ctx.get !== 'function') return undefined;
  try {
    return ctx.get(name);
  } catch {
    return undefined;
  }
}

function selectionOf(ctx) {
  const svc = getService(ctx, 'agentDefaultModel');
  if (!svc || typeof svc.currentSelection !== 'function') return null;
  let sel = null;
  try {
    sel = svc.currentSelection();
  } catch {
    return null;
  }
  const provider = str(sel && sel.provider);
  const model = str(sel && sel.model);
  if (!provider || !model) return null;
  return { provider, model, reasoningEffort: str(sel && sel.reasoningEffort) };
}

function withEffort(route, effort) {
  if (effort) route.reasoningEffort = effort;
  return route;
}

/**
 * 同步可确定的路由：显式 provider+model -> 环境变量 -> agentDefaultModel.currentSelection()。
 * 返回 route 对象或 null（null 表示要继续走异步的 providers 兜底）。
 */
function routeFromSync(ctx, opts = {}) {
  const o = opts || {};
  const explicitEffort = str(o.reasoningEffort);
  const explicitProvider = str(o.provider);
  const explicitModel = str(o.model);
  if (explicitProvider && explicitModel) {
    return withEffort({ ok: true, provider: explicitProvider, model: explicitModel, source: 'explicit' }, explicitEffort);
  }
  const envProvider = str(process.env[ENV_PROVIDER]);
  const envModel = str(process.env[ENV_MODEL]);
  const envEffort = str(process.env[ENV_REASONING]);
  if (envProvider && envModel) {
    return withEffort({ ok: true, provider: envProvider, model: envModel, source: 'env' }, explicitEffort || envEffort);
  }
  const sel = selectionOf(ctx);
  if (sel) {
    return withEffort(
      { ok: true, provider: sel.provider, model: sel.model, source: 'selection' },
      explicitEffort || sel.reasoningEffort,
    );
  }
  return null;
}

function pickId(x) {
  if (typeof x === 'string') return str(x);
  if (!x || typeof x !== 'object') return '';
  return str(x.id) || str(x.model) || str(x.name) || str(x.provider) || '';
}

/**
 * 解析出可用的大模型路由。
 * 顺序：显式 provider+model -> CHAOXING_LLM_PROVIDER/MODEL/REASONING -> agentDefaultModel.currentSelection()
 *       -> llm.listProviders()[0] + llm.listModels(provider)[0]（需要 await，因此本函数是 async）。
 * @returns {Promise<{ok:true,provider:string,model:string,reasoningEffort?:string,source:'explicit'|'env'|'selection'|'providers'}
 *          | {ok:false,reason:string}>}
 */
export async function resolveRoute(ctx, opts = {}) {
  const llm = getService(ctx, 'llm');
  if (!llm || typeof llm.stream !== 'function') return { ok: false, reason: 'llm service unavailable' };

  const fast = routeFromSync(ctx, opts);
  if (fast) return fast;

  let providers;
  try {
    providers = await llm.listProviders();
  } catch (e) {
    return { ok: false, reason: `llm listProviders failed: ${errText(e)}` };
  }
  const provider = Array.isArray(providers) ? providers.map(pickId).find(Boolean) || '' : '';
  if (!provider) return { ok: false, reason: 'no llm provider available' };

  let models;
  try {
    models = await llm.listModels(provider);
  } catch (e) {
    return { ok: false, reason: `llm listModels failed for ${provider}: ${errText(e)}` };
  }
  const model = Array.isArray(models) ? models.map(pickId).find(Boolean) || '' : '';
  if (!model) return { ok: false, reason: `no model available for provider ${provider}` };

  const effort = str(opts && opts.reasoningEffort) || str(process.env[ENV_REASONING]);
  return withEffort({ ok: true, provider, model, source: 'providers' }, effort);
}

function toInt(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizeUsage(u) {
  const inputTokens = toInt(u && (u.inputTokens ?? u.input ?? u.promptTokens));
  const outputTokens = toInt(u && (u.outputTokens ?? u.output ?? u.completionTokens));
  const totalTokens = toInt(u && u.totalTokens) || inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

function finishKind(reason) {
  if (!reason) return '';
  if (typeof reason === 'string') return reason;
  return str(reason.kind) || str(reason.type) || str(reason.reason);
}

function failureText(reason) {
  if (!reason) return 'unknown failure';
  if (typeof reason === 'string') return reason;
  const f = reason.failure || reason.error || null;
  if (!f) return str(reason.message) || 'unknown failure';
  if (typeof f === 'string') return f;
  const msg = str(f.message) || 'unknown failure';
  const code = f.code === undefined || f.code === null ? '' : String(f.code).trim();
  const status = f.status === undefined || f.status === null ? '' : String(f.status).trim();
  const meta = [];
  if (code) meta.push(`code=${code}`);
  if (status) meta.push(`status=${status}`);
  return meta.length ? `${msg} (${meta.join(' ')})` : msg;
}

function joinParts(parts) {
  return [...parts.keys()]
    .sort((a, b) => a - b)
    .map((k) => parts.get(k))
    .join('');
}

function findBalanced(text) {
  const start = String(text).search(/[{[]/);
  if (start < 0) return '';
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return '';
}

/** 去掉 JSON 里字符串之外的尾随逗号（模型偶尔会带）。 */
function stripTrailingCommas(s) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === '}' || s[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

/** 容错解析模型输出：直接 JSON -> ```json 围栏 -> 第一个平衡的 {...}/[...] 子串。 */
function parseJsonLoose(rawText) {
  const original = String(rawText == null ? '' : rawText).replace(/^\uFEFF/, '').trim();
  if (!original) throw new Error('empty text');
  const tries = [];
  const add = (s) => {
    const t = String(s == null ? '' : s).trim();
    if (t && !tries.includes(t)) tries.push(t);
  };
  const fenced = original.match(/```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/);
  if (fenced) add(fenced[1]);
  add(original);
  for (const cand of [...tries]) add(findBalanced(cand));

  let lastErr = null;
  for (const cand of tries) {
    try {
      return JSON.parse(cand);
    } catch (e) {
      lastErr = e;
    }
    const repaired = stripTrailingCommas(cand);
    if (repaired !== cand) {
      try {
        return JSON.parse(repaired);
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw new Error(lastErr ? lastErr.message : 'no JSON found');
}

/**
 * 宿主大模型客户端：一次构造对应一条路由（也可不指定，走默认解析）。
 * text()/json() 内部用 AbortController + setTimeout 做超时；finish.reason.kind 为 error/aborted 时抛错。
 */
export class LlmClient {
  constructor({
    ctx,
    log,
    provider,
    model,
    reasoningEffort,
    timeoutMs = 120000,
    maxTokens = 2000,
    purpose = 'chaoxing',
  } = {}) {
    this.ctx = ctx || null;
    this.log = typeof log === 'function' ? log : null;
    this.purpose = str(purpose) || 'chaoxing';
    this.timeoutMs = positiveInt(timeoutMs) || 120000;
    this.maxTokens = positiveInt(maxTokens) || 2000;
    this._opts = {
      provider: str(provider),
      model: str(model),
      reasoningEffort: str(reasoningEffort),
    };
    this._route = null;
    this._routeError = '';
    this._source = '';
    this._reasoningEffort = this._opts.reasoningEffort;
    // 构造时只做同步可确定的路由；providers 兜底留给第一次 text()（避免构造期间发网络请求）。
    const fast = routeFromSync(this.ctx, this._opts);
    if (fast) this._setRoute(fast);
  }

  /** 能解析出 route 且 ctx 里有 llm 服务才为 true */
  get ready() {
    return !!this._route && !!this._llm();
  }

  /** { provider, model } 或 null */
  get route() {
    return this._route ? { provider: this._route.provider, model: this._route.model } : null;
  }

  get provider() {
    return this._route ? this._route.provider : this._opts.provider;
  }

  get model() {
    return this._route ? this._route.model : this._opts.model;
  }

  get reasoningEffort() {
    return this._reasoningEffort;
  }

  get source() {
    return this._source;
  }

  _setRoute(route) {
    this._route = { provider: route.provider, model: route.model };
    this._source = route.source || '';
    this._reasoningEffort = this._opts.reasoningEffort || route.reasoningEffort || '';
  }

  _llm() {
    const llm = getService(this.ctx, 'llm');
    return llm && typeof llm.stream === 'function' ? llm : null;
  }

  _log(payload) {
    if (!this.log) return;
    try {
      this.log(payload);
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  /** 提前解析路由（providers/env/当前选择）；成功返回 true。用于插件启用时预热。 */
  async ensureReady() {
    try {
      await this._ensureRoute();
    } catch {
      /* 失败保留 routeError，由调用方决定降级 */
    }
    return this.ready;
  }

  async _ensureRoute() {
    const llm = this._llm();
    if (!llm) {
      this._routeError = 'llm service unavailable';
      throw new Error(this._routeError);
    }
    if (this._route) return this._route;
    const route = await resolveRoute(this.ctx, this._opts);
    if (!route.ok) {
      this._routeError = route.reason || 'llm route unavailable';
      throw new Error(this._routeError);
    }
    this._setRoute(route);
    return this._route;
  }

  async _consume(llm, options) {
    const parts = new Map();
    const blocks = [];
    let usage = null;
    let finish = null;
    try {
      for await (const chunk of llm.stream(options)) {
        if (!chunk || typeof chunk !== 'object') continue;
        const type = str(chunk.type);
        if (type === 'text-delta' || type === 'text_delta') {
          const idx = Number.isInteger(chunk.index) ? chunk.index : 0;
          const piece =
            typeof chunk.text === 'string' ? chunk.text : typeof chunk.delta === 'string' ? chunk.delta : '';
          if (piece) parts.set(idx, (parts.get(idx) || '') + piece);
        } else if (type === 'usage') {
          usage = normalizeUsage(chunk.usage);
        } else if (type === 'finish') {
          finish = chunk.reason !== undefined ? chunk.reason : chunk.finish !== undefined ? chunk.finish : null;
        } else if (type === 'error') {
          throw new Error(`llm error: ${failureText(chunk.error || chunk.failure || chunk)}`);
        } else if (type === 'block-end') {
          // 兜底：个别宿主只在 block 里给整段文本
          const block = chunk.block;
          const piece =
            block && typeof block.text === 'string' ? block.text : block && typeof block.content === 'string' ? block.content : '';
          if (piece) blocks.push(piece);
        }
      }
    } catch (e) {
      if (options.signal && options.signal.aborted) throw new Error('llm aborted');
      if (/^llm /.test(str(e && e.message))) throw e;
      throw new Error(`llm stream failed: ${errText(e)}`);
    }

    const kind = finishKind(finish);
    if (kind === 'error') throw new Error(`llm error: ${failureText(finish)}`);
    if (kind === 'aborted') throw new Error(`llm aborted: ${failureText(finish)}`);

    let text = joinParts(parts);
    if (!text && blocks.length) text = blocks.join('');
    return { text, usage: usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }

  /**
   * 发一轮对话并拼出完整文本。
   * @returns {Promise<{text:string, usage:{inputTokens:number,outputTokens:number,totalTokens:number},
   *                   provider:string, model:string}>}
   */
  async text(opts = {}) {
    try {
      return await this._textOnce(opts);
    } catch (e) {
      const msg = String((e && e.message) || e);
      // 超时/主动取消不重试（再等一轮只会更慢）；流中断、宿主瞬时错误退避重试一次
      if (/aborted|timeout/i.test(msg)) throw e;
      this._log({ ev: 'llm-text-retry', purpose: this.purpose, err: head(errText(e), 160) });
      await new Promise((r) => setTimeout(r, 800));
      return await this._textOnce(opts);
    }
  }

  async _textOnce({ system, user, maxTokens, temperature = 0.2, timeoutMs } = {}) {
    const route = await this._ensureRoute();
    const llm = this._llm();
    if (!llm) throw new Error('llm service unavailable');

    const prompt = String(user == null ? '' : user);
    if (!prompt.trim()) throw new Error('llm user prompt empty');

    const ms = positiveInt(timeoutMs) || this.timeoutMs;
    const budget = positiveInt(maxTokens) || this.maxTokens;
    const temp = Number.isFinite(Number(temperature)) ? Number(temperature) : 0.2;

    const options = {
      provider: route.provider,
      model: route.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: budget,
      temperature: temp,
    };
    const sys = typeof system === 'string' ? system.trim() : '';
    if (sys) options.system = sys;
    if (this._reasoningEffort) options.reasoningEffort = this._reasoningEffort;

    const controller = new AbortController();
    const streamOptions = { ...options, signal: controller.signal };
    const started = Date.now();
    let timer = null;

    const work = this._consume(llm, streamOptions);
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try {
          controller.abort();
        } catch {
          /* ignore */
        }
        reject(new Error(`llm timeout after ${ms}ms (${route.provider}/${route.model})`));
      }, ms);
    });

    try {
      const out = await Promise.race([work, timeout]);
      this._log({
        ev: 'llm-text',
        purpose: this.purpose,
        provider: route.provider,
        model: route.model,
        ms: Date.now() - started,
        chars: out.text.length,
        inTokens: out.usage.inputTokens,
        outTokens: out.usage.outputTokens,
      });
      return { text: out.text, usage: out.usage, provider: route.provider, model: route.model };
    } catch (e) {
      this._log({
        ev: 'llm-text-fail',
        purpose: this.purpose,
        provider: route.provider,
        model: route.model,
        ms: Date.now() - started,
        err: head(errText(e), 200),
      });
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * text() + 容错 JSON 解析。解析失败抛错，错误信息带原文前 300 字。
   * @returns {Promise<{value:any, text:string, usage:object, provider:string, model:string}>}
   */
  async json({ system, user, maxTokens, temperature = 0.1 } = {}) {
    const r = await this.text({ system, user, maxTokens, temperature });
    let value;
    try {
      value = parseJsonLoose(r.text);
    } catch (e) {
      throw new Error(`llm json parse failed: ${errText(e)}; raw=${head(r.text, 300)}`);
    }
    return { value, text: r.text, usage: r.usage, provider: r.provider, model: r.model };
  }
}

/**
 * 连通性自检：解析路由 -> 发一句短提示 -> 验证能拿到文本。
 * @returns {Promise<{ok:boolean, provider:string, model:string, sample:string,
 *                    usage?:object, reason?:string}>}
 */
export async function probeLlm(ctx, { log } = {}) {
  const route = await resolveRoute(ctx);
  if (!route.ok) return { ok: false, provider: '', model: '', sample: '', reason: route.reason };
  const llm = getService(ctx, 'llm');
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, provider: route.provider, model: route.model, sample: '', reason: 'llm service unavailable' };
  }
  const client = new LlmClient({
    ctx,
    log,
    provider: route.provider,
    model: route.model,
    reasoningEffort: route.reasoningEffort,
    timeoutMs: 30000,
    maxTokens: 32,
    purpose: 'probe',
  });
  try {
    const out = await client.text({
      system: '你是连通性自检程序：无论被问什么，都只回复 OK 两个字母。',
      user: '连通性自检，请只回复 OK。',
      maxTokens: 32,
      temperature: 0,
    });
    const sample = String(out.text || '').trim().slice(0, 80);
    if (!sample) {
      return { ok: false, provider: route.provider, model: route.model, sample: '', usage: out.usage, reason: 'empty response' };
    }
    return { ok: true, provider: route.provider, model: route.model, sample, usage: out.usage };
  } catch (e) {
    return { ok: false, provider: route.provider, model: route.model, sample: '', reason: errText(e) };
  }
}
