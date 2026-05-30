import { config } from '../config';
import { FailureKind } from '../providers/types';

export interface ProviderHealth {
  provider: string;
  healthy: boolean;
  cooldownUntil: number | null;
  successCount: number;
  failureCount: number;
  rateLimitCount: number;
  averageLatency: number;
  totalRequests: number;
  cooldownCount: number;
}

class HealthService {
  private state = new Map<string, ProviderHealth>();

  init(providers: string[]) {
    for (const p of providers) {
      if (!this.state.has(p)) {
        this.state.set(p, {
          provider: p,
          healthy: true,
          cooldownUntil: null,
          successCount: 0,
          failureCount: 0,
          rateLimitCount: 0,
          averageLatency: 0,
          totalRequests: 0,
          cooldownCount: 0,
        });
      }
    }
  }

  get(provider: string): ProviderHealth | undefined {
    return this.state.get(provider);
  }

  all(): ProviderHealth[] {
    return Array.from(this.state.values());
  }

  isAvailable(provider: string): boolean {
    const h = this.state.get(provider);
    if (!h) return false;
    if (h.cooldownUntil && h.cooldownUntil > Date.now()) return false;
    if (h.cooldownUntil && h.cooldownUntil <= Date.now()) {
      h.cooldownUntil = null;
      h.healthy = true;
    }
    return true;
  }

  recordSuccess(provider: string, latencyMs: number) {
    const h = this.state.get(provider);
    if (!h) return;
    h.successCount += 1;
    h.totalRequests += 1;
    h.healthy = true;
    h.cooldownUntil = null;
    const total = h.successCount;
    h.averageLatency = h.averageLatency + (latencyMs - h.averageLatency) / total;
  }

  recordFailure(provider: string, kind: FailureKind) {
    const h = this.state.get(provider);
    if (!h) return;
    h.failureCount += 1;
    h.totalRequests += 1;
    if (kind === 'rate_limit') {
      h.rateLimitCount += 1;
      h.cooldownUntil = Date.now() + config.rateLimitCooldownMs;
      h.cooldownCount += 1;
      h.healthy = false;
    } else if (kind === 'timeout' || kind === 'network') {
      h.cooldownUntil = Date.now() + config.errorCooldownMs;
      h.cooldownCount += 1;
      h.healthy = false;
    } else {
      h.healthy = true;
    }
  }

  serialize(): Record<string, ProviderHealth> {
    const out: Record<string, ProviderHealth> = {};
    for (const [k, v] of this.state) out[k] = v;
    return out;
  }

  load(data: Record<string, ProviderHealth>) {
    for (const k of Object.keys(data)) {
      this.state.set(k, data[k]);
    }
  }
}

export const healthService = new HealthService();
