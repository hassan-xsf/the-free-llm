import { healthService } from './health';
import { historyService } from './history';

class StatsService {
  startTime = Date.now();

  snapshot() {
    const health = healthService.all();
    const history = historyService.all();
    const totalRequests = history.length;
    const totalSuccess = history.filter((h) => h.success).length;
    const totalFailures = totalRequests - totalSuccess;
    const avgLatency =
      totalRequests > 0
        ? history.reduce((s, h) => s + h.latency, 0) / totalRequests
        : 0;

    const distribution: Record<string, number> = {};
    for (const h of history) {
      distribution[h.provider] = (distribution[h.provider] || 0) + 1;
    }

    const providers = health.map((h) => ({
      provider: h.provider,
      healthy: h.healthy,
      cooldownUntil: h.cooldownUntil,
      cooldownRemainingMs:
        h.cooldownUntil && h.cooldownUntil > Date.now() ? h.cooldownUntil - Date.now() : 0,
      totalRequests: h.totalRequests,
      successCount: h.successCount,
      failureCount: h.failureCount,
      rateLimitCount: h.rateLimitCount,
      cooldownCount: h.cooldownCount,
      averageLatency: Math.round(h.averageLatency),
      successRate:
        h.totalRequests > 0 ? Math.round((h.successCount / h.totalRequests) * 100) : 0,
    }));

    return {
      uptimeMs: Date.now() - this.startTime,
      global: {
        totalRequests,
        totalSuccess,
        totalFailures,
        averageLatency: Math.round(avgLatency),
        providerDistribution: distribution,
      },
      providers,
      recentRequests: historyService.list(100),
    };
  }
}

export const statsService = new StatsService();
