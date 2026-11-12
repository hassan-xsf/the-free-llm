import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export interface ProviderConfig {
  name: string;
  apiKey: string;
  // Rotation pool: the router cycles through these round-robin (zero delay) and
  // falls back model-by-model on a retryable failure before moving to the next
  // provider. `defaultModel` is kept as the first entry for backward compat.
  models: string[];
  defaultModel: string;
  priority: number;
  timeoutMs: number;
  // Only Cloudflare Workers AI needs this — its endpoint is account-scoped.
  accountId?: string;
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  secretToken: process.env.SECRET_TOKEN || '',
  requestTimeoutMs: 30000,
  rateLimitCooldownMs: 10 * 60 * 1000,
  errorCooldownMs: 2 * 60 * 1000,
  maxHistorySize: 5000,
  persistenceFile: path.join(process.cwd(), 'data', 'state.json'),
  persistenceIntervalMs: 30 * 1000,
  providers: {
    gemini: {
      name: 'gemini',
      apiKey: process.env.GEMINI_API_KEY || '',
      models: ['gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash-lite'],
      defaultModel: 'gemini-2.5-flash',
      priority: 3,
      timeoutMs: 30000,
    } as ProviderConfig,
    groq: {
      name: 'groq',
      apiKey: process.env.GROQ_API_KEY || '',
      // Groq's daily token cap is per model, so each extra model is extra headroom.
      // (Llama models are gone from Groq; only these three general chat models remain.)
      models: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'],
      defaultModel: 'openai/gpt-oss-120b',
      priority: 1,
      timeoutMs: 30000,
    } as ProviderConfig,
    openrouter: {
      name: 'openrouter',
      apiKey: process.env.OPENROUTER_API_KEY || '',
      models: [
        'nvidia/nemotron-3-super-120b-a12b:free',
        'minimax/minimax-m3:free',
        'google/gemma-4-31b-it:free',
        'google/gemma-4-26b-a4b-it:free',
        'nvidia/nemotron-3.5-lightning:free',
      ],
      defaultModel: 'nvidia/nemotron-3-super-120b-a12b:free',
      priority: 5,
      timeoutMs: 30000,
    } as ProviderConfig,
    cohere: {
      name: 'cohere',
      apiKey: process.env.COHERE_API_KEY || '',
      // Ordered strongest-first: Command A is Cohere's flagship, and trial keys
      // cost nothing, so quality beats size here. Aya is a multilingual fallback.
      models: [
        'command-a-03-2025',
        'command-r-08-2024',
        'command-r7b-12-2024',
        'c4ai-aya-expanse-32b',
      ],
      defaultModel: 'command-a-03-2025',
      priority: 4,
      timeoutMs: 30000,
    } as ProviderConfig,
    mistral: {
      name: 'mistral',
      apiKey: process.env.MISTRAL_API_KEY || '',
      // Free-tier keys only serve the `ministral-*` family — mistral-small and
      // -medium return 429 regardless of volume, so they're left out of the pool
      // rather than wasting a failover attempt on a guaranteed rejection.
      models: ['ministral-14b-latest', 'ministral-8b-latest', 'ministral-3b-latest'],
      defaultModel: 'ministral-14b-latest',
      priority: 2,
      timeoutMs: 30000,
    } as ProviderConfig,
    llm7: {
      name: 'llm7',
      apiKey: process.env.LLM7_API_KEY || '',
      // Free key only serves these two (the "turbo" tier); every other LLM7 model
      // returns 402 insufficient balance. Free: 120 RPM with a token, 30 without.
      models: ['mistral-Nemo-Instruct-2407', 'codestral-latest'],
      defaultModel: 'mistral-Nemo-Instruct-2407',
      priority: 6,
      timeoutMs: 30000,
    } as ProviderConfig,
    cloudflare: {
      name: 'cloudflare',
      apiKey: process.env.CLOUDFLARE_API_TOKEN || '',
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
      // Workers AI is paid-per-token (no free tier), so this pool is ordered
      // cheapest-first by blended price: qwen3-30b is a 30B MoE billed at the
      // 3B rate, and granite-micro is the cheapest model on the platform.
      models: [
        '@cf/qwen/qwen3-30b-a3b-fp8',
        '@cf/zai-org/glm-4.7-flash',
        '@cf/meta/llama-3.2-3b-instruct',
        '@cf/google/gemma-4-26b-a4b-it',
        '@cf/ibm-granite/granite-4.0-h-micro',
      ],
      defaultModel: '@cf/qwen/qwen3-30b-a3b-fp8',
      priority: 7,
      timeoutMs: 30000,
    } as ProviderConfig,
    aionlabs: {
      name: 'aionlabs',
      apiKey: process.env.AION_LABS_API_KEY || '',
      // AionLabs specialises in roleplay/storytelling and is the priciest option
      // here (~$0.70/M in), so it sits last. Ordered cheapest-first.
      models: [
        'aion-labs/aion-3.0-mini',
        'aion-labs/aion-2.0',
        'aion-labs/aion-rp-llama-3.1-8b',
        'aion-labs/aion-3.0',
      ],
      defaultModel: 'aion-labs/aion-3.0-mini',
      priority: 8,
      timeoutMs: 30000,
    } as ProviderConfig,
  },
};

// Failover order is measured, not assumed. Ranked by a liar-detector benchmark
// (2026-09-08): correctness first, then latency, then cost. Groq and Mistral are
// the fastest free tiers; OpenRouter drops below the other free providers while
// its daily quota is exhausted (it costs ~580ms failing through five models);
// Cloudflare trails the free tiers on both price and a wrong answer in testing.
export const providerOrder = [
  'groq',
  'mistral',
  'gemini',
  'cohere',
  'openrouter',
  'llm7',
  'cloudflare',
  'aionlabs',
] as const;
export type ProviderName = (typeof providerOrder)[number];
