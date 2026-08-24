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
      models: ['gemini-2.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash-lite'],
      defaultModel: 'gemini-2.5-flash',
      priority: 1,
      timeoutMs: 30000,
    } as ProviderConfig,
    groq: {
      name: 'groq',
      apiKey: process.env.GROQ_API_KEY || '',
      models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'groq/compound-mini'],
      defaultModel: 'openai/gpt-oss-120b',
      priority: 2,
      timeoutMs: 30000,
    } as ProviderConfig,
    openrouter: {
      name: 'openrouter',
      apiKey: process.env.OPENROUTER_API_KEY || '',
      models: [
        'nvidia/nemotron-3-super-120b-a12b:free',
        'z-ai/glm-5.2:free',
        'google/gemma-4-31b-it:free',
      ],
      defaultModel: 'nvidia/nemotron-3-super-120b-a12b:free',
      priority: 3,
      timeoutMs: 30000,
    } as ProviderConfig,
  },
};

export const providerOrder = ['gemini', 'groq', 'openrouter'] as const;
export type ProviderName = (typeof providerOrder)[number];
