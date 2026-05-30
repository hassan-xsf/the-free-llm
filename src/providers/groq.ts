import axios, { AxiosError } from 'axios';
import { config } from '../config';
import { GenerateOptions, GenerateResult, Provider, ProviderError } from './types';

export class GroqProvider implements Provider {
  name = 'groq';

  async generateResponse(prompt: string, options: GenerateOptions = {}): Promise<GenerateResult> {
    const cfg = config.providers.groq;
    const model = options.model || cfg.defaultModel;
    const url = 'https://api.groq.com/openai/v1/chat/completions';

    const messages: any[] = [];
    if (options.system) messages.push({ role: 'system', content: options.system });
    messages.push({ role: 'user', content: prompt });

    const body: any = { model, messages };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;

    try {
      const res = await axios.post(url, body, {
        timeout: options.timeoutMs || cfg.timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
      });
      const text = res.data?.choices?.[0]?.message?.content || '';
      if (!text) throw new ProviderError('Empty response from Groq', 'error');
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
