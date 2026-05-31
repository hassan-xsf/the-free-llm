import { Router, Request, Response } from 'express';
import { route } from '../services/router';
import { requireToken } from '../middleware/auth';

const router = Router();

function parseParams(req: Request) {
  // GET: read from query string. POST: read from body, fallback to query.
  const q = req.body ?? {};
  const get = (key: string): string | undefined =>
    (q[key] as string) ?? (req.query[key] as string) ?? undefined;

  return {
    query: get('query') || '',
    responseFormat: get('response') || 'json',
    provider: get('provider'),
    model: get('model'),
    temperature: get('temperature') ? parseFloat(get('temperature')!) : undefined,
    maxTokens: get('max_tokens') ? parseInt(get('max_tokens')!, 10) : undefined,
    system: get('system'),
  };
}

async function handleAI(req: Request, res: Response) {
  const { query, responseFormat, provider, model, temperature, maxTokens, system } =
    parseParams(req);

  if (!query) {
    return res.status(400).json({ success: false, error: 'Missing required parameter: query' });
  }

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
}

router.get('/ai', requireToken, handleAI);
router.post('/ai', requireToken, handleAI);

export default router;
