import axios, { AxiosError } from 'axios';
import { config } from '../config';
import { GenerateOptions, GenerateResult, Provider, ProviderError } from './types';

export class GeminiProvider implements Provider {
  name = 'gemini';

  async generateResponse(prompt: string, options: GenerateOptions = {}): Promise<GenerateResult> {
    const cfg = config.providers.gemini;
    const model = options.model || cfg.defaultModel;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${cfg.apiKey}`;

    const body: any = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {},
    };
    if (options.temperature !== undefined) body.generationConfig.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.generationConfig.maxOutputTokens = options.maxTokens;
    if (options.system) {
      body.systemInstruction = { parts: [{ text: options.system }] };
    }

    try {
      const res = await axios.post(url, body, {
        timeout: options.timeoutMs || cfg.timeoutMs,
        headers: { 'Content-Type': 'application/json' },
      });
      const text =
        res.data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') || '';
      if (!text) {
        throw new ProviderError('Empty response from Gemini', 'error');
      }
      return { text, model, provider: this.name };
    } catch (err) {
      throw mapError(err);
    }
  }
}

function mapError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const ax = err as AxiosError;
  if (ax.code === 'ECONNABORTED' || ax.code === 'ETIMEDOUT') {
    return new ProviderError('Timeout', 'timeout');
  }
  if (!ax.response) {
    return new ProviderError(ax.message || 'Network error', 'network');
  }
  const status = ax.response.status;
  const data: any = ax.response.data;
  const msg = data?.error?.message || ax.message;
  if (status === 429 || /quota|rate limit/i.test(msg)) {
    return new ProviderError(msg || 'Rate limit', 'rate_limit', status);
  }
  if (status === 502 || status === 503 || status === 504) {
    return new ProviderError(msg || `HTTP ${status}`, 'network', status);
  }
  return new ProviderError(msg || `HTTP ${status}`, 'error', status);
}
