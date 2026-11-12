/**
 * TheFreeLLM — Cloudflare Worker edition.
 *
 * A dependency-free port of the Express app: one free LLM endpoint that fails
 * over Groq -> Mistral -> Gemini -> Cohere -> OpenRouter -> LLM7 -> Cloudflare ->
 * AionLabs (free tiers first, then cheapest paid). Uses native fetch only (no axios, no
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
  COHERE_API_KEY?: string;
  MISTRAL_API_KEY?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  AION_LABS_API_KEY?: string;
  LLM7_API_KEY?: string;
  SECRET_TOKEN?: string;
}

type FailureKind = 'rate_limit' | 'timeout' | 'network' | 'error';

class ProviderError extends Error {
  constructor(
    message: string,
    public kind: FailureKind,
    public statusCode?: number,
    public retryAfterSec?: number
  ) {
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
  gemini: ['gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash-lite'],
  // Groq's daily token cap is per model, so each extra model is extra headroom.
  // (Llama models are gone from Groq; only these three general chat models remain.)
  groq: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'],
  openrouter: [
    'nvidia/nemotron-3-super-120b-a12b:free',
    'minimax/minimax-m3:free',
    'google/gemma-4-31b-it:free',
    'google/gemma-4-26b-a4b-it:free',
    'nvidia/nemotron-3.5-lightning:free',
  ],
  // Trial keys cost nothing, so this pool is ordered strongest-first.
  cohere: [
    'command-a-03-2025',
    'command-r-08-2024',
    'command-r7b-12-2024',
    'c4ai-aya-expanse-32b',
  ],
  // Free-tier keys only serve the `ministral-*` family — mistral-small and
  // -medium return 429 regardless of volume, so they're left out of the pool
  // rather than wasting a failover attempt on a guaranteed rejection.
  mistral: ['ministral-14b-latest', 'ministral-8b-latest', 'ministral-3b-latest'],
  // Free key only serves these two (the "turbo" tier); every other LLM7 model
  // returns 402 insufficient balance.
  llm7: ['mistral-Nemo-Instruct-2407', 'codestral-latest'],
  // Workers AI is paid-per-token (no free tier), so this pool is ordered
  // cheapest-first by blended price: qwen3-30b is a 30B MoE billed at the 3B
  // rate, and granite-micro is the cheapest model on the platform.
  cloudflare: [
    '@cf/qwen/qwen3-30b-a3b-fp8',
    '@cf/zai-org/glm-4.7-flash',
    '@cf/meta/llama-3.2-3b-instruct',
    '@cf/google/gemma-4-26b-a4b-it',
    '@cf/ibm-granite/granite-4.0-h-micro',
  ],
  // Roleplay/storytelling specialist and the priciest option here (~$0.70/M in),
  // so it sits last in the chain. Ordered cheapest-first.
  aionlabs: [
    'aion-labs/aion-3.0-mini',
    'aion-labs/aion-2.0',
    'aion-labs/aion-rp-llama-3.1-8b',
    'aion-labs/aion-3.0',
  ],
};

// Per-provider rotation cursor. Advanced once per request so load spreads across
// models. Module-level state is fine: it's a best-effort hint, not correctness.
const rotation: Record<string, number> = {
  gemini: 0,
  groq: 0,
  openrouter: 0,
  cohere: 0,
  mistral: 0,
  llm7: 0,
  cloudflare: 0,
  aionlabs: 0,
};

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
    // Error envelopes differ by provider: { error: { message } } for the
    // OpenAI-compatible ones, { errors: [{ message }] } for Cloudflare v4, and
    // a bare { message } for Cohere.
    const msg =
      data?.error?.message || data?.errors?.[0]?.message || data?.message || `HTTP ${res.status}`;
    if (res.status === 429 || /quota|rate limit|capacity|trial/i.test(msg)) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '', 10);
      throw new ProviderError(msg, 'rate_limit', res.status, retryAfter > 0 ? retryAfter : undefined);
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
    // gpt-oss burns hidden reasoning tokens against the daily cap; keep it short.
    if (model.startsWith('openai/gpt-oss')) body.reasoning_effort = 'low';
    // Free-tier qwen rejects any request whose max_tokens exceeds its 1000 output-tokens/min cap.
    if (model.startsWith('qwen/')) body.max_tokens = Math.min(body.max_tokens ?? 1000, 1000);

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

const cohere: Provider = {
  name: 'cohere',
  models: MODELS.cohere,
  isConfigured: (env) => Boolean(env.COHERE_API_KEY),
  async generate(prompt, model, options, env) {
    const messages: any[] = [];
    if (options.system) messages.push({ role: 'system', content: options.system });
    messages.push({ role: 'user', content: prompt });
    const body: any = { model, messages };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;

    // Cohere v2 takes OpenAI-style messages but returns content as an array of
    // typed blocks rather than a single string.
    const data = await postJSON(
      'https://api.cohere.com/v2/chat',
      body,
      { Authorization: `Bearer ${env.COHERE_API_KEY}` },
      options.timeoutMs || TIMEOUT_MS
    );
    const text: string = (data?.message?.content || [])
      .filter((b: any) => b?.type === 'text' || typeof b?.text === 'string')
      .map((b: any) => b.text)
      .join('');
    if (!text) throw new ProviderError('Empty response from Cohere', 'error');
    return { text, model, provider: 'cohere' };
  },
};

const mistral: Provider = {
  name: 'mistral',
  models: MODELS.mistral,
  isConfigured: (env) => Boolean(env.MISTRAL_API_KEY),
  async generate(prompt, model, options, env) {
    const messages: any[] = [];
    if (options.system) messages.push({ role: 'system', content: options.system });
    messages.push({ role: 'user', content: prompt });
    const body: any = { model, messages };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;

    const data = await postJSON(
      'https://api.mistral.ai/v1/chat/completions',
      body,
      { Authorization: `Bearer ${env.MISTRAL_API_KEY}` },
      options.timeoutMs || TIMEOUT_MS
    );
    const text: string = data?.choices?.[0]?.message?.content || '';
    if (!text) throw new ProviderError('Empty response from Mistral', 'error');
    return { text, model, provider: 'mistral' };
  },
};

const aionlabs: Provider = {
  name: 'aionlabs',
  models: MODELS.aionlabs,
  isConfigured: (env) => Boolean(env.AION_LABS_API_KEY),
  async generate(prompt, model, options, env) {
    const messages: any[] = [];
    if (options.system) messages.push({ role: 'system', content: options.system });
    messages.push({ role: 'user', content: prompt });
    const body: any = { model, messages };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;

    const data = await postJSON(
      'https://api.aionlabs.ai/v1/chat/completions',
      body,
      { Authorization: `Bearer ${env.AION_LABS_API_KEY}` },
      options.timeoutMs || TIMEOUT_MS
    );
    const text: string = data?.choices?.[0]?.message?.content || '';
    if (!text) throw new ProviderError('Empty response from AionLabs', 'error');
    return { text, model, provider: 'aionlabs' };
  },
};

const llm7: Provider = {
  name: 'llm7',
  models: MODELS.llm7,
  isConfigured: (env) => Boolean(env.LLM7_API_KEY),
  async generate(prompt, model, options, env) {
    const messages: any[] = [];
    if (options.system) messages.push({ role: 'system', content: options.system });
    messages.push({ role: 'user', content: prompt });
    const body: any = { model, messages };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;

    const data = await postJSON(
      'https://api.llm7.io/v1/chat/completions',
      body,
      { Authorization: `Bearer ${env.LLM7_API_KEY}` },
      options.timeoutMs || TIMEOUT_MS
    );
    const text: string = data?.choices?.[0]?.message?.content || '';
    if (!text) throw new ProviderError('Empty response from LLM7', 'error');
    return { text, model, provider: 'llm7' };
  },
};

const cloudflare: Provider = {
  name: 'cloudflare',
  models: MODELS.cloudflare,
  isConfigured: (env) => Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN),
  async generate(prompt, model, options, env) {
    const messages: any[] = [];
    if (options.system) messages.push({ role: 'system', content: options.system });
    messages.push({ role: 'user', content: prompt });
    const body: any = { model, messages };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;

    // Workers AI exposes an OpenAI-compatible chat endpoint, so the body shape
    // matches Groq/OpenRouter — only the URL and auth differ.
    const data = await postJSON(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`,
      body,
      { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
      options.timeoutMs || TIMEOUT_MS
    );
    const text: string = data?.choices?.[0]?.message?.content || '';
    if (!text) throw new ProviderError('Empty response from Cloudflare', 'error');
    return { text, model, provider: 'cloudflare' };
  },
};

// Failover priority: first = highest priority. Free tiers run first; the
// paid-per-token providers trail them, cheapest first (Cloudflare ~$0.05/M in,
// AionLabs ~$0.70/M and roleplay-tuned rather than general purpose).
const PROVIDERS: Provider[] = [groq, mistral, gemini, cohere, openrouter, llm7, cloudflare, aionlabs];

// --- cooldowns ----------------------------------------------------------------

// Rate-limited models are skipped until their cooldown expires. Per model, since
// limits are per model (Groq, Mistral): one model 429ing doesn't bench its siblings.
// ponytail: in-memory, so each isolate learns on its own and forgets on recycle;
// costs nothing, unlike KV's daily op cap.
const cooldowns: Record<string, number> = {}; // "provider/model" -> expiresAtMs
const DEFAULT_COOLDOWN_SEC = 10 * 60;

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
      if (pe.kind === 'rate_limit') {
        cooldowns[`${p.name}/${model}`] = Date.now() + (pe.retryAfterSec || DEFAULT_COOLDOWN_SEC) * 1000;
      }
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
      if ((cooldowns[`${p.name}/${model}`] || 0) > Date.now()) {
        attempts.push({ provider: p.name, model, success: false, error: 'cooling down', latency: 0 });
        continue;
      }
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
