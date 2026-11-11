// aster-proxy — Anthropic Messages API ⇄ OpenAI-compatible Chat Completions.
//
// Claude Science (patched) talks the Anthropic wire protocol to this server;
// every request is translated to an OpenAI-compatible /chat/completions call.
// No third-party dependencies. Node >= 18 (global fetch).
//
// Environment (installer-provided; never committed):
//   ASTER_OPENAI_BASE_URL   default upstream base URL
//   ASTER_OPENAI_API_KEY    default upstream key
//   ASTER_OPENAI_MODEL      model for aliases without an explicit route
//   ASTER_MODEL_MAP         JSON { "<alias>": "<model>" | {"model","base_url?","api_key?"} }
//   ASTER_PROXY_PORT        default 8787
//   ASTER_PROXY_HOST        default 127.0.0.1
//
// Model routing:
//   - The app always asks for an alias (claude-opus-5, claude-sonnet-4-6, …).
//   - Each alias resolves to a route: {model, base, apiKey}.
//   - A map entry as a string reuses the default base/key.
//   - A map entry as an object can point at another endpoint/key.
//   - Aliases missing from the map fall back to ASTER_OPENAI_MODEL on the
//     default base/key, even if they are not advertised by /v1/models.
//   - If the map is non-empty, its keys are the advertised aliases; otherwise
//     the three defaults are advertised.

import http from 'node:http';

const PORT = Number(process.env.ASTER_PROXY_PORT || 8787);
const HOST = process.env.ASTER_PROXY_HOST || '127.0.0.1';
const BASE = (process.env.ASTER_OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const UPSTREAM_KEY = process.env.ASTER_OPENAI_API_KEY || '';
const DEFAULT_MODEL = process.env.ASTER_OPENAI_MODEL || 'gpt-4o';

const DEFAULT_ALIASES = ['claude-opus-5', 'claude-sonnet-4-6', 'claude-haiku-4-5'];
const DEFAULT_ROUTE = Object.freeze({ model: DEFAULT_MODEL, base: BASE, apiKey: UPSTREAM_KEY });

let MODEL_MAP = {};
try {
  if (process.env.ASTER_MODEL_MAP) MODEL_MAP = JSON.parse(process.env.ASTER_MODEL_MAP);
} catch (e) {
  console.error('[aster-proxy] ASTER_MODEL_MAP is not valid JSON; ignoring it:', e.message);
  MODEL_MAP = {};
}

const ROUTES = new Map();
for (const [alias, value] of Object.entries(MODEL_MAP)) {
  if (typeof value === 'string' && value.trim()) {
    ROUTES.set(alias, { model: value.trim(), base: BASE, apiKey: UPSTREAM_KEY });
    continue;
  }
  if (value && typeof value === 'object' && typeof value.model === 'string' && value.model.trim()) {
    const base = typeof value.base_url === 'string' && value.base_url.trim() ? value.base_url.trim() : BASE;
    try {
      new URL(base);
    } catch {
      console.error(`[aster-proxy] ASTER_MODEL_MAP["${alias}"].base_url is not a valid URL; entry ignored`);
      continue;
    }
    ROUTES.set(alias, {
      model: value.model.trim(),
      base: base.replace(/\/+$/, ''),
      apiKey: typeof value.api_key === 'string' && value.api_key ? value.api_key : UPSTREAM_KEY,
    });
    continue;
  }
  console.error(`[aster-proxy] ASTER_MODEL_MAP["${alias}"] must be a model id or {model, base_url?, api_key?}; entry ignored`);
}

const ALIASES = ROUTES.size ? [...ROUTES.keys()] : DEFAULT_ALIASES;
const routeFor = (alias) => ROUTES.get(alias) ?? DEFAULT_ROUTE;
const routeLabel = (route) => `${route.model} @ ${new URL(route.base).host}`;

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- request translation ----------

function systemText(system) {
  if (!system) return null;
  if (typeof system === 'string') return system;
  return system
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n\n');
}

function imageUrl(block) {
  const src = block?.source;
  if (!src) return null;
  if (src.type === 'base64') return `data:${src.media_type};base64,${src.data}`;
  if (src.type === 'url') return src.url;
  return null;
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (b?.type === 'text') parts.push(b.text);
    else if (b?.type === 'image') parts.push('[image omitted: upstream is text-only for tool results]');
    else if (b?.type === 'document') parts.push('[document omitted]');
  }
  return parts.join('\n');
}

function textJoin(blocks) {
  return blocks
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function toOpenAIMessages(body) {
  const out = [];
  const sys = systemText(body.system);
  if (sys) out.push({ role: 'system', content: sys });

  for (const m of body.messages || []) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];

    if (m.role === 'assistant') {
      const text = textJoin(blocks);
      const toolCalls = blocks
        .filter((b) => b?.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      const msg = { role: 'assistant' };
      msg.content = text || (toolCalls.length ? null : '');
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
      continue;
    }

    // user role: OpenAI requires tool results before any user content.
    const parts = [];
    for (const b of blocks) {
      if (b?.type === 'tool_result') {
        if (parts.length) {
          out.push({ role: 'user', content: parts.splice(0) });
        }
        out.push({
          role: 'tool',
          tool_call_id: b.tool_use_id,
          content: (b.is_error ? '[tool error] ' : '') + toolResultText(b.content),
        });
      } else if (b?.type === 'text') {
        parts.push({ type: 'text', text: b.text });
      } else if (b?.type === 'image') {
        const url = imageUrl(b);
        if (url) parts.push({ type: 'image_url', image_url: { url } });
      } else if (b?.type === 'document') {
        parts.push({ type: 'text', text: '[document omitted: not representable upstream]' });
      }
    }
    if (parts.length) {
      const onlyText = parts.every((p) => p.type === 'text');
      out.push({
        role: 'user',
        content: onlyText ? parts.map((p) => p.text).join('\n') : parts,
      });
    }
  }
  return out;
}

function toOpenAITools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools
    .filter((t) => t?.name)
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || undefined,
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
}

function toOpenAIToolChoice(choice) {
  if (!choice) return undefined;
  switch (choice.type) {
    case 'auto':
      return 'auto';
    case 'any':
      return 'required';
    case 'none':
      return 'none';
    case 'tool':
      return { type: 'function', function: { name: choice.name } };
    default:
      return undefined;
  }
}

function buildUpstreamRequest(body, route) {
  const req = {
    model: route.model,
    messages: toOpenAIMessages(body),
    max_tokens: body.max_tokens ?? 4096,
    stream: Boolean(body.stream),
  };
  const tools = toOpenAITools(body.tools);
  if (tools) {
    req.tools = tools;
    const tc = toOpenAIToolChoice(body.tool_choice);
    if (tc) req.tool_choice = tc;
  }
  if (typeof body.temperature === 'number') req.temperature = body.temperature;
  if (typeof body.top_p === 'number') req.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) req.stop = body.stop_sequences;
  if (req.stream) req.stream_options = { include_usage: true };
  return req;
}

// ---------- response translation ----------

function stopReason(finish) {
  switch (finish) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

function usageOf(usage) {
  const u = usage || {};
  return {
    input_tokens: u.prompt_tokens ?? 0,
    output_tokens: u.completion_tokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

function toAnthropicResponse(openai, requestedModel) {
  const choice = openai.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (typeof msg.content === 'string' && msg.content.length) content.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try {
      input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch {
      input = { _raw: tc.function?.arguments ?? '' };
    }
    content.push({
      type: 'tool_use',
      id: tc.id || `toolu_${Math.random().toString(36).slice(2, 12)}`,
      name: tc.function?.name || 'unknown',
      input,
    });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  return {
    id: `msg_${openai.id || Math.random().toString(36).slice(2, 12)}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: stopReason(choice.finish_reason),
    stop_sequence: null,
    usage: usageOf(openai.usage),
  };
}

// ---------- streaming ----------

async function* sseEvents(stream) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = raw
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (data) yield data;
    }
  }
  if (buf.trim()) {
    const data = buf
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (data) yield data;
  }
}

class AnthropicStream {
  constructor(res, requestedModel) {
    this.res = res;
    this.model = requestedModel;
    this.nextIndex = 0;
    this.textIndex = null;
    this.toolBlocks = new Map(); // upstream tool index -> { index, name }
    this.stop = null;
    this.usage = null;
    this.started = false;
  }

  send(type, data) {
    this.res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  }

  start(usage) {
    if (this.started) return;
    this.started = true;
    this.send('message_start', {
      message: {
        id: `msg_${Math.random().toString(36).slice(2, 12)}`,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: usageOf(usage),
      },
    });
  }

  closeText() {
    if (this.textIndex !== null) {
      this.send('content_block_stop', { index: this.textIndex });
      this.textIndex = null;
    }
  }

  textDelta(text) {
    if (!text) return;
    if (this.textIndex === null) {
      this.textIndex = this.nextIndex++;
      this.send('content_block_start', {
        index: this.textIndex,
        content_block: { type: 'text', text: '' },
      });
    }
    this.send('content_block_delta', {
      index: this.textIndex,
      delta: { type: 'text_delta', text },
    });
  }

  toolDelta(tc) {
    const key = tc.index ?? 0;
    let block = this.toolBlocks.get(key);
    if (!block) {
      this.closeText();
      block = { index: this.nextIndex++, name: tc.function?.name || '' };
      this.toolBlocks.set(key, block);
      this.send('content_block_start', {
        index: block.index,
        content_block: { type: 'tool_use', id: tc.id || `toolu_${key}_${Date.now()}`, name: block.name, input: {} },
      });
    }
    const args = tc.function?.arguments;
    if (args) {
      this.send('content_block_delta', {
        index: block.index,
        delta: { type: 'input_json_delta', partial_json: args },
      });
    }
  }

  chunk(obj) {
    this.start(obj.usage);
    const choice = obj.choices?.[0];
    if (obj.usage) this.usage = obj.usage;
    if (!choice) return;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string') this.textDelta(delta.content);
    for (const tc of delta.tool_calls || []) this.toolDelta(tc);
    if (choice.finish_reason) this.stop = choice.finish_reason;
  }

  finish() {
    this.start(this.usage);
    this.closeText();
    for (const block of this.toolBlocks.values()) {
      this.send('content_block_stop', { index: block.index });
    }
    this.toolBlocks.clear();
    this.send('message_delta', {
      delta: { stop_reason: stopReason(this.stop), stop_sequence: null },
      usage: { output_tokens: this.usage?.completion_tokens ?? 0 },
    });
    this.send('message_stop', {});
    this.res.end();
  }
}

// ---------- HTTP ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function error(res, status, type, message) {
  json(res, status, { type: 'error', error: { type, message } });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  try {
    if (req.method === 'GET' && path === '/health') {
      return json(res, 200, {
        ok: true,
        upstream: BASE,
        default_model: DEFAULT_MODEL,
        models: ALIASES,
        routes: ALIASES.map((alias) => {
          const route = routeFor(alias);
          return { alias, model: route.model, base: route.base, has_key: Boolean(route.apiKey) };
        }),
        fallback: { model: DEFAULT_MODEL, base: BASE, has_key: Boolean(UPSTREAM_KEY) },
      });
    }

    if (req.method === 'GET' && path === '/v1/models') {
      return json(res, 200, {
        data: ALIASES.map((id) => {
          const route = routeFor(id);
          const host = new URL(route.base).host;
          return {
            type: 'model',
            id,
            display_name: `${id} → ${route.model} @ ${host}`,
            created_at: '2025-01-01T00:00:00Z',
          };
        }),
        has_more: false,
        first_id: ALIASES[0] ?? null,
        last_id: ALIASES[ALIASES.length - 1] ?? null,
      });
    }

    if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const text = JSON.stringify(body);
      return json(res, 200, { input_tokens: Math.max(1, Math.ceil(text.length / 4)) });
    }

    if (req.method === 'POST' && path === '/v1/messages') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const route = routeFor(body.model);
      if (!route.apiKey) {
        const hint = route === DEFAULT_ROUTE
          ? 'set ASTER_OPENAI_API_KEY'
          : `set ASTER_MODEL_MAP["${body.model}"].api_key`;
        return error(res, 500, 'authentication_error', `no upstream API key for ${body.model} (${hint})`);
      }
      const upstreamReq = buildUpstreamRequest(body, route);
      const upstreamUrl = `${route.base}/chat/completions`;
      const startedAt = Date.now();

      let upstream;
      try {
        upstream = await fetch(upstreamUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${route.apiKey}`,
          },
          body: JSON.stringify(upstreamReq),
        });
      } catch (e) {
        log('upstream unreachable', e.message);
        return error(res, 502, 'api_error', `upstream unreachable: ${e.message}`);
      }

      if (!upstream.ok) {
        const text = await upstream.text();
        log('upstream error', body.model, '→', routeLabel(route), upstream.status, text.slice(0, 500));
        return error(res, upstream.status, 'api_error', text.slice(0, 4000));
      }

      if (!body.stream) {
        const data = await upstream.json();
        log('chat', body.model, '→', routeLabel(route), 'ms=', Date.now() - startedAt);
        return json(res, 200, toAnthropicResponse(data, body.model));
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.flushHeaders?.();
      const stream = new AnthropicStream(res, body.model);
      try {
        for await (const data of sseEvents(upstream.body)) {
          if (data === '[DONE]') break;
          let obj;
          try {
            obj = JSON.parse(data);
          } catch {
            continue;
          }
          if (obj.error) {
            stream.send('error', { error: obj.error });
            res.end();
            return;
          }
          stream.chunk(obj);
        }
        stream.finish();
        log('chat stream', body.model, '→', routeLabel(route), 'ms=', Date.now() - startedAt);
      } catch (e) {
        log('stream failed', e.message);
        try {
          stream.send('error', { error: { type: 'api_error', message: e.message } });
        } catch {}
        res.end();
      }
      return;
    }

    return error(res, 404, 'not_found_error', `no route for ${req.method} ${path}`);
  } catch (e) {
    log('handler failed', e?.stack || String(e));
    try {
      error(res, 500, 'api_error', e.message);
    } catch {}
  }
});

server.listen(PORT, HOST, () => {
  log(`listening on ${HOST}:${PORT} → default ${DEFAULT_MODEL} @ ${new URL(BASE).host}`);
  log(`aliases: ${ALIASES.map((a) => `${a} → ${routeLabel(routeFor(a))}`).join(', ')}`);
});
