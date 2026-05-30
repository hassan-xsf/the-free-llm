import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { healthService } from './health';
import { historyService } from './history';

export function loadState() {
  try {
    if (!fs.existsSync(config.persistenceFile)) return;
    const raw = fs.readFileSync(config.persistenceFile, 'utf8');
    const data = JSON.parse(raw);
    if (data.health) healthService.load(data.health);
    if (data.history) historyService.load(data.history);
    console.log('[persistence] state loaded');
  } catch (err) {
    console.error('[persistence] failed to load state', err);
  }
}

export function saveState() {
  try {
    const dir = path.dirname(config.persistenceFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = {
      health: healthService.serialize(),
      history: historyService.all(),
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(config.persistenceFile, JSON.stringify(data));
  } catch (err) {
    console.error('[persistence] failed to save state', err);
  }
}

export function startPersistence() {
  setInterval(saveState, config.persistenceIntervalMs).unref();
  process.on('SIGINT', () => {
    saveState();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    saveState();
    process.exit(0);
  });
}
