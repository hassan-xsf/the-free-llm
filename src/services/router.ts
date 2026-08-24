import { registry } from '../providers/registry';
import { GenerateOptions, ProviderError } from '../providers/types';
import { config } from '../config';
import { healthService } from './health';
import { historyService } from './history';

export interface RouteRequest {
  query: string;
  provider?: string;
  options?: GenerateOptions;
}

// Per-provider round-robin cursor. Advanced once per request so successive calls
// start on a different model (zero delay — just spreads load). Best-effort hint.
const rotation: Record<string, number> = {};

// This provider's models ordered from the current cursor, then advance the cursor.
function rotatedModels(providerName: string): string[] {
  const cfg = (config.providers as Record<string, { models?: string[]; defaultModel: string }>)[
    providerName
  ];
  const list = cfg?.models?.length ? cfg.models : [cfg?.defaultModel].filter(Boolean) as string[];
  if (list.length === 0) return [];
  const start = (rotation[providerName] || 0) % list.length;
  rotation[providerName] = (start + 1) % list.length;
  return [...list.slice(start), ...list.slice(0, start)];
}

export interface RouteResult {
  success: boolean;
  provider?: string;
  model?: string;
  latency?: number;
  response?: string;
  error?: string;
  attempts: Array<{ provider: string; model?: string; success: boolean; error?: string; latency: number }>;
}

export async function route(req: RouteRequest): Promise<RouteResult> {
  const attempts: RouteResult['attempts'] = [];

  // Try a single (provider, model) pair. Records health + history + attempt.
  const tryModel = async (
    name: string,
    provider: ReturnType<typeof registry.get>,
    model: string
  ): Promise<RouteResult | null> => {
    const start = Date.now();
    try {
      const res = await provider!.generateResponse(req.query, { ...req.options, model });
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
      attempts.push({ provider: name, model, success: true, latency });
      return { success: true, provider: name, model: res.model, latency, response: res.text, attempts };
    } catch (err) {
      const latency = Date.now() - start;
      const pe = err instanceof ProviderError ? err : new ProviderError(String(err), 'error');
      healthService.recordFailure(name, pe.kind);
      historyService.add({
        timestamp: new Date().toISOString(),
        query: req.query,
        provider: name,
        model,
        success: false,
        latency,
        statusCode: pe.statusCode || 0,
      });
      attempts.push({ provider: name, model, success: false, error: pe.message, latency });
      return null;
    }
  };

  // Try a provider across its models: caller-pinned model if given, else rotate
  // through the pool, falling back model-by-model on failure (zero delay).
  const tryProvider = async (name: string): Promise<RouteResult | null> => {
    const provider = registry.get(name);
    if (!provider) {
      attempts.push({ provider: name, success: false, error: 'unknown provider', latency: 0 });
      return null;
    }
    const models = req.options?.model ? [req.options.model] : rotatedModels(name);
    for (const model of models) {
      const result = await tryModel(name, provider, model);
      if (result) return result;
    }
    return null;
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
