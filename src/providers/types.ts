export interface GenerateOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  system?: string;
  timeoutMs?: number;
}

export interface GenerateResult {
  text: string;
  model: string;
  provider: string;
}

export type FailureKind = 'rate_limit' | 'error' | 'timeout' | 'network';

export class ProviderError extends Error {
  kind: FailureKind;
  statusCode?: number;
  constructor(message: string, kind: FailureKind, statusCode?: number) {
    super(message);
    this.kind = kind;
    this.statusCode = statusCode;
  }
}

export interface Provider {
  name: string;
  generateResponse(prompt: string, options?: GenerateOptions): Promise<GenerateResult>;
}
