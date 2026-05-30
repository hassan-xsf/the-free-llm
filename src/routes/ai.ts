import { Router } from 'express';
import { route } from '../services/router';
import { requireToken } from '../middleware/auth';

const router = Router();

router.get('/ai', requireToken, async (req, res) => {
  const query = (req.query.query as string) || '';
  if (!query) {
    return res.status(400).json({ success: false, error: 'Missing required parameter: query' });
  }

  const responseFormat = (req.query.response as string) || 'json';
  const provider = req.query.provider as string | undefined;
  const model = req.query.model as string | undefined;
  const temperature = req.query.temperature
    ? parseFloat(req.query.temperature as string)
    : undefined;
  const maxTokens = req.query.max_tokens
    ? parseInt(req.query.max_tokens as string, 10)
    : undefined;
  const system = req.query.system as string | undefined;

  const result = await route({
    query,
    provider,
    options: { model, temperature, maxTokens, system },
  });

  if (responseFormat === 'text') {
    if (result.success) {
      res.type('text/plain').send(result.response || '');
    } else {
      res.status(503).type('text/plain').send(result.error || 'Error');
    }
    return;
  }

  if (result.success) {
    res.json({
      success: true,
      provider: result.provider,
      model: result.model,
      latency: result.latency,
      response: result.response,
    });
  } else {
    res.status(503).json({
      success: false,
      error: result.error || 'All providers unavailable',
      attempts: result.attempts,
    });
  }
});

export default router;
