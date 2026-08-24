/**
 * TheFreeLLM — Cloudflare Worker edition.
 *
 * A dependency-free port of the Express app: one free LLM endpoint that fails
 * over Gemini -> Groq -> OpenRouter. Uses native fetch only (no axios, no
 * Express, no filesystem), so it runs on the Workers runtime as-is.
 *
 * Endpoints:
 *   GET  /                      -> service info
 *   GET  /ai?query=...          -> generate (params via query string)
 *   POST /ai  { "query": ... }  -> generate (params via JSON body)
 */

interface Env {
  GEMINI_API_KEY?: string;
  GROQ_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  SECRET_TOKEN?: string;
}

type FailureKind = 'rate_limit' | 'timeout' | 'network' | 'error';

class ProviderError extends Error {
  constructor(message: string, public kind: FailureKind, public statusCode?: number) {
    super(message);
  }
}

interface GenerateOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  system?: string;
  timeoutMs?: number;
}

interface GenerateResult {
  text: string;
  model: string;
  provider: string;
}

interface Provider {
  name: string;
  models: string[];
  isConfigured(env: Env): boolean;
  // `model` is always resolved by the router (rotation or caller override).
  generate(prompt: string, model: string, options: GenerateOptions, env: Env): Promise<GenerateResult>;
}

const TIMEOUT_MS = 30000;

// Each provider carries 2-3 models. The router rotates through them (round-robin,
// zero delay) and, on a retryable failure, immediately tries the next model in the
// same provider before failing over to the next provider.
const MODELS = {
  gemini: ['gemini-2.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash-lite'],
  groq: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'groq/compound-mini'],
  openrouter: [
    'nvidia/nemotron-3-super-120b-a12b:free',
    'z-ai/glm-5.2:free',
    'google/gemma-4-31b-it:free',
  ],
};

// Per-provider rotation cursor. Advanced once per request so load spreads across
// models. Module-level state is fine: it's a best-effort hint, not correctness.
const rotation: Record<string, number> = { gemini: 0, groq: 0, openrouter: 0 };

// Return this provider's models ordered starting at the current rotation cursor,
// then advance the cursor by one. Caller tries them in order until one succeeds.
function rotatedModels(name: keyof typeof MODELS): string[] {
  const list = MODELS[name];
  const start = rotation[name] % list.length;
  rotation[name] = (rotation[name] + 1) % list.length;
  return [...list.slice(start), ...list.slice(0, start)];
}

// --- shared HTTP helper: fetch with a timeout, mapped into ProviderError -----

async function postJSON(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new ProviderError('Timeout', 'timeout');
    }
    throw new ProviderError((err as Error).message || 'Network error', 'network');
  } finally {
    clearTimeout(timer);
  }

  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    if (res.status === 429 || /quota|rate limit/i.test(msg)) {
      throw new ProviderError(msg, 'rate_limit', res.status);
    }
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new ProviderError(msg, 'network', res.status);
    }
    throw new ProviderError(msg, 'error', res.status);
  }
  return data;
}

// --- providers ----------------------------------------------------------------

const gemini: Provider = {
  name: 'gemini',
  models: MODELS.gemini,
  isConfigured: (env) => Boolean(env.GEMINI_API_KEY),
  async generate(prompt, model, options, env) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
    const body: any = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: {} };
    if (options.temperature !== undefined) body.generationConfig.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.generationConfig.maxOutputTokens = options.maxTokens;
    if (options.system) body.systemInstruction = { parts: [{ text: options.system }] };

    const data = await postJSON(url, body, {}, options.timeoutMs || TIMEOUT_MS);
    const text: string =
      data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') || '';
    if (!text) throw new ProviderError('Empty response from Gemini', 'error');
    return { text, model, provider: 'gemini' };
  },
};

const groq: Provider = {
  name: 'groq',
  models: MODELS.groq,
  isConfigured: (env) => Boolean(env.GROQ_API_KEY),
  async generate(prompt, model, options, env) {
    const messages: any[] = [];
    if (options.system) messages.push({ role: 'system', content: options.system });
    messages.push({ role: 'user', content: prompt });
    const body: any = { model, messages };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;

    const data = await postJSON(
      'https://api.groq.com/openai/v1/chat/completions',
      body,
      { Authorization: `Bearer ${env.GROQ_API_KEY}` },
      options.timeoutMs || TIMEOUT_MS
    );
    const text: string = data?.choices?.[0]?.message?.content || '';
    if (!text) throw new ProviderError('Empty response from Groq', 'error');
    return { text, model, provider: 'groq' };
  },
};

const openrouter: Provider = {
  name: 'openrouter',
  models: MODELS.openrouter,
  isConfigured: (env) => Boolean(env.OPENROUTER_API_KEY),
  async generate(prompt, model, options, env) {
    const messages: any[] = [];
    if (options.system) messages.push({ role: 'system', content: options.system });
    messages.push({ role: 'user', content: prompt });
    const body: any = { model, messages };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;

    const data = await postJSON(
      'https://openrouter.ai/api/v1/chat/completions',
      body,
      {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://thefreellm.workers.dev',
        'X-Title': 'TheFreeLLM',
      },
      options.timeoutMs || TIMEOUT_MS
    );
    const text: string = data?.choices?.[0]?.message?.content || '';
    if (!text) throw new ProviderError('Empty response from OpenRouter', 'error');
    return { text, model, provider: 'openrouter' };
  },
};

// Failover priority: first = highest priority.
const PROVIDERS: Provider[] = [gemini, groq, openrouter];

// --- routing / failover -------------------------------------------------------

interface RouteResult {
  success: boolean;
  provider?: string;
  model?: string;
  latency?: number;
  response?: string;
  error?: string;
  attempts: Array<{ provider: string; model?: string; success: boolean; error?: string; latency: number }>;
}

async function route(
  query: string,
  requestedProvider: string | undefined,
  options: GenerateOptions,
  env: Env
): Promise<RouteResult> {
  const attempts: RouteResult['attempts'] = [];

  // Try one model. Returns a success result, or null (with the error recorded).
  const tryModel = async (p: Provider, model: string): Promise<RouteResult | null> => {
    const start = Date.now();
    try {
      const res = await p.generate(query, model, options, env);
      const latency = Date.now() - start;
      attempts.push({ provider: p.name, model, success: true, latency });
      return { success: true, provider: p.name, model: res.model, latency, response: res.text, attempts };
    } catch (err) {
      const latency = Date.now() - start;
      const pe = err instanceof ProviderError ? err : new ProviderError(String(err), 'error');
      attempts.push({ provider: p.name, model, success: false, error: pe.message, latency });
      return null;
    }
  };

  // Try a provider across its models. If the caller pinned a model, use only that.
  // Otherwise rotate (round-robin, zero delay) and fall back model-by-model on
  // any failure until one succeeds or the provider's models are exhausted.
  const tryProvider = async (p: Provider): Promise<RouteResult | null> => {
    const models = options.model
      ? [options.model]
      : rotatedModels(p.name as keyof typeof MODELS);
    for (const model of models) {
      const result = await tryModel(p, model);
      if (result) return result;
    }
    return null;
  };

  if (requestedProvider) {
    const p = PROVIDERS.find((x) => x.name === requestedProvider);
    if (!p) return { success: false, error: `Unknown provider ${requestedProvider}`, attempts };
    if (!p.isConfigured(env)) {
      attempts.push({ provider: p.name, success: false, error: 'not configured', latency: 0 });
      return { success: false, error: `Provider ${requestedProvider} not configured`, attempts };
    }
    const result = await tryProvider(p);
    return result || { success: false, error: `Provider ${requestedProvider} failed`, attempts };
  }

  for (const p of PROVIDERS) {
    if (!p.isConfigured(env)) {
      attempts.push({ provider: p.name, success: false, error: 'not configured', latency: 0 });
      continue;
    }
    const result = await tryProvider(p);
    if (result) return result;
  }

  return { success: false, error: 'All providers unavailable', attempts };
}

// --- request parsing / handlers -----------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function checkToken(req: Request, url: URL, env: Env): boolean {
  if (!env.SECRET_TOKEN) return true;
  const header =
    req.headers.get('x-secret-token') ||
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ||
    undefined;
  const token = url.searchParams.get('token') || header;
  return token === env.SECRET_TOKEN;
}

async function handleAI(req: Request, url: URL, env: Env): Promise<Response> {
  if (!checkToken(req, url, env)) {
    return json({ success: false, error: 'Invalid or missing token' }, 401);
  }

  // GET: query string. POST: JSON body, falling back to query string.
  let bodyParams: Record<string, any> = {};
  if (req.method === 'POST') {
    bodyParams = (await req.json().catch(() => ({}))) as Record<string, any>;
  }
  const get = (key: string): string | undefined =>
    (bodyParams[key] as string) ?? url.searchParams.get(key) ?? undefined;

  const query = get('query') || '';
  const responseFormat = get('response') || 'json';
  const provider = get('provider');

  if (!query) {
    return json({ success: false, error: 'Missing required parameter: query' }, 400);
  }

  const options: GenerateOptions = {
    model: get('model'),
    temperature: get('temperature') ? parseFloat(get('temperature')!) : undefined,
    maxTokens: get('max_tokens') ? parseInt(get('max_tokens')!, 10) : undefined,
    system: get('system'),
  };

  const result = await route(query, provider, options, env);

  if (responseFormat === 'text') {
    return result.success
      ? new Response(result.response || '', { headers: { 'Content-Type': 'text/plain' } })
      : new Response(result.error || 'Error', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }

  if (result.success) {
    return json({
      success: true,
      provider: result.provider,
      model: result.model,
      latency: result.latency,
      response: result.response,
    });
  }
  return json({ success: false, error: result.error || 'All providers unavailable', attempts: result.attempts }, 503);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/' && req.method === 'GET') {
      return json({
        name: 'TheFreeLLM',
        edition: 'cloudflare-worker',
        providers: PROVIDERS.filter((p) => p.isConfigured(env)).map((p) => p.name),
        endpoints: ['/ai?query=...'],
      });
    }

    if (url.pathname === '/ai' && (req.method === 'GET' || req.method === 'POST')) {
      return handleAI(req, url, env);
    }

    return json({ success: false, error: 'Not found' }, 404);
  },
};
