import { config } from '../config';

export interface RequestLog {
  timestamp: string;
  query: string;
  provider: string;
  model: string;
  success: boolean;
  latency: number;
  statusCode: number;
}

class HistoryService {
  private entries: RequestLog[] = [];

  add(entry: RequestLog) {
    this.entries.push(entry);
    if (this.entries.length > config.maxHistorySize) {
      this.entries.splice(0, this.entries.length - config.maxHistorySize);
    }
  }

  list(limit?: number): RequestLog[] {
    const data = [...this.entries].reverse();
    return limit ? data.slice(0, limit) : data;
  }

  all(): RequestLog[] {
    return [...this.entries];
  }

  load(data: RequestLog[]) {
    this.entries = data.slice(-config.maxHistorySize);
  }
}

export const historyService = new HistoryService();
