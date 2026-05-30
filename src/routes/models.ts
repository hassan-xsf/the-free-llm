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
  });
});

export default router;
