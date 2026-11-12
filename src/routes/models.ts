import { Router } from 'express';
import axios from 'axios';
import { config } from '../config';

const router = Router();

export interface ModelInfo {
  id: string;
  label: string;
  contextK?: number;
  cost: 'free' | 'free-tier' | 'paid';
  promptPrice?: number;
  completionPrice?: number;
  family?: string;
  popular?: boolean;
  notes?: string;
}

// Hardcoded Gemini list — Google doesn't expose a clean public list endpoint
const geminiCatalog: ModelInfo[] = [
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', contextK: 1000, cost: 'free-tier', family: 'Gemini 2.5', popular: true, notes: 'Default — fastest & cheapest' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', contextK: 1000, cost: 'free-tier', family: 'Gemini 2.5', popular: true, notes: 'Balanced speed/quality' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', contextK: 2000, cost: 'free-tier', family: 'Gemini 2.5', popular: true, notes: 'Highest quality' },
  { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', contextK: 1000, cost: 'free-tier', family: 'Gemini 2.0' },
  { id: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash Lite', contextK: 1000, cost: 'free-tier', family: 'Gemini 2.0' },
];

// Cloudflare Workers AI — the pool the router rotates through, cheapest first.
// Prices are USD per million tokens, taken from the Workers AI model catalog.
const cloudflareCatalog: ModelInfo[] = [
  { id: '@cf/qwen/qwen3-30b-a3b-fp8', label: 'Qwen3 30B A3B (FP8)', cost: 'paid', promptPrice: 0.0509, completionPrice: 0.335, family: 'Qwen', popular: true, notes: 'Default — 30B MoE at 3B pricing' },
  { id: '@cf/zai-org/glm-4.7-flash', label: 'GLM 4.7 Flash', cost: 'paid', promptPrice: 0.0605, completionPrice: 0.4, family: 'GLM', popular: true },
  { id: '@cf/meta/llama-3.2-3b-instruct', label: 'Llama 3.2 3B Instruct', cost: 'paid', promptPrice: 0.0509, completionPrice: 0.335, family: 'Llama', popular: true },
  { id: '@cf/google/gemma-4-26b-a4b-it', label: 'Gemma 4 26B A4B', cost: 'paid', promptPrice: 0.1, completionPrice: 0.3, family: 'Gemma', popular: true },
  { id: '@cf/ibm-granite/granite-4.0-h-micro', label: 'Granite 4.0 H Micro', cost: 'paid', promptPrice: 0.017, completionPrice: 0.112, family: 'Granite', notes: 'Cheapest model on Workers AI' },
];

// Cohere — trial keys are free (rate-limited), so the pool leads with the
// flagship Command A rather than the smaller models.
const cohereCatalog: ModelInfo[] = [
  { id: 'command-a-03-2025', label: 'Command A', contextK: 288, cost: 'free-tier', family: 'Cohere', popular: true, notes: 'Default — flagship' },
  { id: 'command-r-08-2024', label: 'Command R', contextK: 128, cost: 'free-tier', family: 'Cohere', popular: true },
  { id: 'command-r7b-12-2024', label: 'Command R7B', contextK: 132, cost: 'free-tier', family: 'Cohere', notes: 'Smallest & fastest' },
  { id: 'c4ai-aya-expanse-32b', label: 'Aya Expanse 32B', contextK: 128, cost: 'free-tier', family: 'Cohere', notes: 'Multilingual' },
];

// Mistral — free-tier keys only serve the `ministral-*` family; the small and
// medium tiers return 429, so they're deliberately absent.
const mistralCatalog: ModelInfo[] = [
  { id: 'ministral-14b-latest', label: 'Ministral 14B', contextK: 256, cost: 'free-tier', family: 'Mistral', popular: true, notes: 'Default — largest on free tier' },
  { id: 'ministral-8b-latest', label: 'Ministral 8B', contextK: 256, cost: 'free-tier', family: 'Mistral', popular: true },
  { id: 'ministral-3b-latest', label: 'Ministral 3B', contextK: 128, cost: 'free-tier', family: 'Mistral', notes: 'Fastest' },
];

// LLM7 — only the free "turbo" tier is listed; other LLM7 models need a paid balance.
const llm7Catalog: ModelInfo[] = [
  { id: 'mistral-Nemo-Instruct-2407', label: 'Mistral Nemo 12B', contextK: 128, cost: 'free', family: 'Mistral', popular: true, notes: 'Default' },
  { id: 'codestral-latest', label: 'Codestral', contextK: 32, cost: 'free', family: 'Mistral', notes: 'Code-tuned' },
];

// AionLabs — roleplay/storytelling specialist. Paid; USD per million tokens.
const aionlabsCatalog: ModelInfo[] = [
  { id: 'aion-labs/aion-3.0-mini', label: 'Aion 3.0 Mini', contextK: 128, cost: 'paid', promptPrice: 0.7, completionPrice: 1.4, family: 'Aion', popular: true, notes: 'Default — cheapest' },
  { id: 'aion-labs/aion-2.0', label: 'Aion 2.0', contextK: 128, cost: 'paid', promptPrice: 0.8, completionPrice: 1.6, family: 'Aion', notes: 'DeepSeek V3.2 variant' },
  { id: 'aion-labs/aion-rp-llama-3.1-8b', label: 'Aion-RP 1.0 (8B)', contextK: 32, cost: 'paid', promptPrice: 0.8, completionPrice: 1.6, family: 'Aion' },
  { id: 'aion-labs/aion-3.0', label: 'Aion 3.0', contextK: 128, cost: 'paid', promptPrice: 3, completionPrice: 6, family: 'Aion', notes: 'Highest quality' },
];

const POPULAR_FAMILIES = new Set([
  'DeepSeek', 'Kimi', 'GPT-OSS', 'Llama', 'Qwen', 'Claude', 'Gemini', 'Mistral', 'Gemma', 'GLM',
]);

function detectFamily(id: string, name?: string): string {
  const s = (id + ' ' + (name || '')).toLowerCase();
  if (s.includes('deepseek')) return 'DeepSeek';
  if (s.includes('kimi') || s.includes('moonshot')) return 'Kimi';
  if (s.includes('gpt-oss')) return 'GPT-OSS';
  if (s.includes('llama')) return 'Llama';
  if (s.includes('qwen')) return 'Qwen';
  if (s.includes('claude')) return 'Claude';
  if (s.includes('gemini')) return 'Gemini';
  if (s.includes('mistral') || s.includes('mixtral') || s.includes('codestral')) return 'Mistral';
  if (s.includes('gemma')) return 'Gemma';
  if (s.includes('glm')) return 'GLM';
  if (s.includes('nemotron')) return 'Nemotron';
  if (s.includes('hermes') || s.includes('nous')) return 'Hermes';
  if (s.includes('grok')) return 'Grok';
  if (s.includes('command') || s.includes('cohere')) return 'Cohere';
  if (s.includes('phi')) return 'Phi';
  if (s.includes('yi-')) return 'Yi';
  if (s.includes('gpt-')) return 'GPT';
  if (s.includes('o1') || s.includes('o3')) return 'OpenAI Reasoning';
  if (s.includes('minimax')) return 'MiniMax';
  if (s.includes('granite')) return 'Granite';
  if (s.includes('aion')) return 'Aion';
  if (s.includes('aya')) return 'Cohere';
  if (s.includes('whisper')) return 'Whisper';
  if (s.includes('liquid') || s.includes('lfm')) return 'Liquid';
  return 'Other';
}

interface Cached<T> {
  at: number;
  data: T;
}
const CACHE_MS = 60 * 60 * 1000;
const cache: { groq?: Cached<ModelInfo[]>; openrouter?: Cached<ModelInfo[]> } = {};

async function fetchGroq(): Promise<ModelInfo[]> {
  if (cache.groq && Date.now() - cache.groq.at < CACHE_MS) return cache.groq.data;
  try {
    const res = await axios.get('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${config.providers.groq.apiKey}` },
      timeout: 10000,
    });
    const data: ModelInfo[] = (res.data?.data || [])
      .filter((m: any) => m.active !== false)
      // Filter out non-chat models (audio, guard models)
      .filter((m: any) => !/whisper|orpheus|prompt-guard/i.test(m.id))
      .map((m: any) => {
        const family = detectFamily(m.id, m.id);
        const popular = POPULAR_FAMILIES.has(family);
        return {
          id: m.id,
          label: m.id,
          contextK: m.context_window ? Math.round(m.context_window / 1024) : undefined,
          cost: 'free-tier' as const,
          family,
          popular,
        };
      });
    cache.groq = { at: Date.now(), data };
    return data;
  } catch (e) {
    console.error('[models] groq fetch failed', (e as Error).message);
    return cache.groq?.data || [];
  }
}

// Vendors/families that are paid-only on OpenRouter — drop them entirely
const PAID_ONLY_PREFIXES = [
  'anthropic/',       // Claude — always paid
  'openai/gpt-4',     // GPT-4 family — paid
  'openai/gpt-5',     // GPT-5 — paid
  'openai/o1',        // o1 reasoning — paid
  'openai/o3',        // o3 reasoning — paid
  'openai/o4',        // o4 reasoning — paid
  'openai/chatgpt',   // ChatGPT — paid
  'x-ai/',            // Grok — paid
  'cohere/',          // Cohere Command — paid
  'perplexity/',      // Perplexity — paid
  'mistralai/mistral-large', // Mistral Large tiers — paid
  'mistralai/mistral-medium',
  'mistralai/codestral',
  'amazon/',          // Amazon Nova — paid
  'inflection/',      // Inflection Pi — paid
  'ai21/',            // AI21 Jamba — paid
];

function isPaidOnlyVendor(id: string): boolean {
  const lower = id.toLowerCase();
  return PAID_ONLY_PREFIXES.some((p) => lower.startsWith(p));
}

async function fetchOpenRouter(): Promise<ModelInfo[]> {
  if (cache.openrouter && Date.now() - cache.openrouter.at < CACHE_MS) return cache.openrouter.data;
  try {
    const res = await axios.get('https://openrouter.ai/api/v1/models', { timeout: 15000 });
    const data: ModelInfo[] = (res.data?.data || [])
      // Drop non-text models
      .filter((m: any) => {
        const mods = m.architecture?.output_modalities || [];
        return mods.length === 0 || mods.includes('text');
      })
      // Drop paid-only vendors (Anthropic, GPT-4/5/o-series, Grok, etc.)
      .filter((m: any) => !isPaidOnlyVendor(m.id))
      .map((m: any) => {
        const prompt = parseFloat(m.pricing?.prompt || '0');
        const completion = parseFloat(m.pricing?.completion || '0');
        const isFree = m.id.endsWith(':free') || (prompt === 0 && completion === 0);
        const family = detectFamily(m.id, m.name);
        const popular = POPULAR_FAMILIES.has(family);
        return {
          id: m.id,
          label: m.name || m.id,
          contextK: m.context_length ? Math.round(m.context_length / 1024) : undefined,
          cost: (isFree ? 'free' : 'paid') as 'free' | 'paid',
          // Prices are per-token; convert to per-million for display
          promptPrice: prompt ? Number((prompt * 1_000_000).toFixed(4)) : 0,
          completionPrice: completion ? Number((completion * 1_000_000).toFixed(4)) : 0,
          family,
          popular,
        };
      });
    cache.openrouter = { at: Date.now(), data };
    return data;
  } catch (e) {
    console.error('[models] openrouter fetch failed', (e as Error).message);
    return cache.openrouter?.data || [];
  }
}

router.get('/models.json', async (_req, res) => {
  const [groq, openrouter] = await Promise.all([fetchGroq(), fetchOpenRouter()]);
  res.json({
    gemini: geminiCatalog,
    groq,
    openrouter,
    cohere: cohereCatalog,
    mistral: mistralCatalog,
    llm7: llm7Catalog,
    cloudflare: cloudflareCatalog,
    aionlabs: aionlabsCatalog,
  });
});

export default router;
