import axios, { AxiosError } from 'axios';
import { config } from '../config';
import { GenerateOptions, GenerateResult, Provider, ProviderError } from './types';

export class CohereProvider implements Provider {
  name = 'cohere';

  async generateResponse(prompt: string, options: GenerateOptions = {}): Promise<GenerateResult> {
    const cfg = config.providers.cohere;
    const model = options.model || cfg.defaultModel;
    // Cohere v2 takes OpenAI-style messages but returns content as an array of
    // typed blocks rather than a single string.
    const url = 'https://api.cohere.com/v2/chat';

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
      const text: string = (res.data?.message?.content || [])
        .filter((b: any) => b?.type === 'text' || typeof b?.text === 'string')
        .map((b: any) => b.text)
        .join('');
      if (!text) throw new ProviderError('Empty response from Cohere', 'error');
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
  // Cohere reports errors as a bare { message } envelope.
  const msg = data?.message || data?.error?.message || ax.message;
  if (status === 429 || /quota|rate limit|trial/i.test(msg)) {
    return new ProviderError(msg || 'Rate limit', 'rate_limit', status);
  }
  if (status === 502 || status === 503 || status === 504) {
    return new ProviderError(msg || `HTTP ${status}`, 'network', status);
  }
  return new ProviderError(msg || `HTTP ${status}`, 'error', status);
}
