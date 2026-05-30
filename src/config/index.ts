import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export interface ProviderConfig {
  name: string;
  apiKey: string;
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
      defaultModel: 'gemini-2.5-flash-lite',
      priority: 1,
      timeoutMs: 30000,
    } as ProviderConfig,
    groq: {
      name: 'groq',
      apiKey: process.env.GROQ_API_KEY || '',
      defaultModel: 'llama-3.3-70b-versatile',
      priority: 2,
      timeoutMs: 30000,
    } as ProviderConfig,
    openrouter: {
      name: 'openrouter',
      apiKey: process.env.OPENROUTER_API_KEY || '',
      defaultModel: 'deepseek/deepseek-v4-flash:free',
      priority: 3,
      timeoutMs: 30000,
    } as ProviderConfig,
  },
};

export const providerOrder = ['gemini', 'groq', 'openrouter'] as const;
export type ProviderName = (typeof providerOrder)[number];
