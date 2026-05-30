import { registry } from '../providers/registry';
import { GenerateOptions, ProviderError } from '../providers/types';
import { healthService } from './health';
import { historyService } from './history';

export interface RouteRequest {
  query: string;
  provider?: string;
  options?: GenerateOptions;
}

export interface RouteResult {
  success: boolean;
  provider?: string;
  model?: string;
  latency?: number;
  response?: string;
  error?: string;
  attempts: Array<{ provider: string; success: boolean; error?: string; latency: number }>;
}

export async function route(req: RouteRequest): Promise<RouteResult> {
  const attempts: RouteResult['attempts'] = [];

  const tryProvider = async (name: string): Promise<RouteResult | null> => {
    const provider = registry.get(name);
    if (!provider) {
      attempts.push({ provider: name, success: false, error: 'unknown provider', latency: 0 });
      return null;
    }
    const start = Date.now();
    try {
      const res = await provider.generateResponse(req.query, req.options);
      const latency = Date.now() - start;
      healthService.recordSuccess(name, latency);
      historyService.add({
        timestamp: new Date().toISOString(),
        query: req.query,
        provider: name,
        model: res.model,
        success: true,
        latency,
        statusCode: 200,
      });
      attempts.push({ provider: name, success: true, latency });
      return {
        success: true,
        provider: name,
        model: res.model,
        latency,
        response: res.text,
        attempts,
      };
    } catch (err) {
      const latency = Date.now() - start;
      const pe = err instanceof ProviderError ? err : new ProviderError(String(err), 'error');
      healthService.recordFailure(name, pe.kind);
      historyService.add({
        timestamp: new Date().toISOString(),
        query: req.query,
        provider: name,
        model: req.options?.model || '',
        success: false,
        latency,
        statusCode: pe.statusCode || 0,
      });
      attempts.push({ provider: name, success: false, error: pe.message, latency });
      return null;
    }
  };

  if (req.provider) {
    const result = await tryProvider(req.provider);
    if (result) return result;
    return {
      success: false,
      error: `Provider ${req.provider} failed`,
      attempts,
    };
  }

  for (const name of registry.names()) {
    if (!healthService.isAvailable(name)) {
      attempts.push({
        provider: name,
        success: false,
        error: 'cooling down',
        latency: 0,
      });
      continue;
    }
    const result = await tryProvider(name);
    if (result) return result;
  }

  return {
    success: false,
    error: 'All providers unavailable',
    attempts,
  };
}
