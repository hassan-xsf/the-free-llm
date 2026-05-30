import express from 'express';
import { config } from './config';
import { registry } from './providers/registry';
import { healthService } from './services/health';
import { loadState, startPersistence } from './services/persistence';
import { requestLogger } from './middleware/logger';
import aiRouter from './routes/ai';
import statsRouter from './routes/stats';
import modelsRouter from './routes/models';

async function main() {
  healthService.init(registry.names());
  loadState();
  startPersistence();

  const app = express();
  app.use(express.json());
  app.use(requestLogger);

  app.get('/', (_req, res) => {
    res.json({
      name: 'TheFreeLLM',
      providers: registry.names(),
      endpoints: ['/ai?query=...', '/stats', '/stats.json'],
    });
  });

  app.use(aiRouter);
  app.use(statsRouter);
  app.use(modelsRouter);

  app.listen(config.port, () => {
    console.log(`[server] listening on http://localhost:${config.port}`);
    console.log(`[server] dashboard: http://localhost:${config.port}/stats`);
  });
}

main().catch((err) => {
  console.error('fatal', err);
  process.exit(1);
});
