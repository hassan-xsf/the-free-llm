import { Router } from 'express';
import path from 'path';
import { statsService } from '../services/stats';

const router = Router();

router.get('/stats.json', (_req, res) => {
  res.json(statsService.snapshot());
});

router.get('/stats', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'dashboard', 'index.html'));
});

export default router;
