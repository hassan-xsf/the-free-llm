import { Provider } from './types';
import { GeminiProvider } from './gemini';
import { GroqProvider } from './groq';
import { OpenRouterProvider } from './openrouter';
import { CohereProvider } from './cohere';
import { MistralProvider } from './mistral';
import { CloudflareProvider } from './cloudflare';
import { AionLabsProvider } from './aionlabs';
import { LLM7Provider } from './llm7';

class ProviderRegistry {
  private providers = new Map<string, Provider>();
  private order: string[] = [];

  register(provider: Provider) {
    this.providers.set(provider.name, provider);
    if (!this.order.includes(provider.name)) {
      this.order.push(provider.name);
    }
  }

  get(name: string): Provider | undefined {
    return this.providers.get(name);
  }

  list(): Provider[] {
    return this.order.map((n) => this.providers.get(n)!).filter(Boolean);
  }

  names(): string[] {
    return [...this.order];
  }
}

export const registry = new ProviderRegistry();

// ============================================================
// To add a new provider: create a file in this folder that
// implements the Provider interface, then add ONE line here.
// Order = failover priority (first = highest priority).
// ============================================================
registry.register(new GroqProvider());
registry.register(new MistralProvider());
registry.register(new GeminiProvider());
registry.register(new CohereProvider());
registry.register(new OpenRouterProvider());
registry.register(new LLM7Provider());
registry.register(new CloudflareProvider());
registry.register(new AionLabsProvider());
