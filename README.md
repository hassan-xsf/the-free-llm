# THE FREE LLM

A smart AI failover gateway that routes a single endpoint across multiple free-tier LLM providers, so you can build, demo, and ship without constantly tripping over rate limits.

## Why this exists

As a student, I got tired of hitting API limits on every provider I tried. You spin up something cool, run a few test prompts, and suddenly you can't even demo it to anyone because the free tier is exhausted. Switching providers manually every time is annoying. Sharing a project that breaks the moment three people try it is worse.

THE FREE LLM solves this by stacking free tiers. One endpoint, multiple providers behind it (Gemini, Groq, OpenRouter), automatic failover when any one of them rate-limits you, and a cooldown system so the router stops hammering a provider that's already said no. Drop your free API keys into `.env`, run one command, and you have a personal LLM gateway with a usable amount of headroom.

## Features

- Single `GET /ai` endpoint with automatic failover across providers
- Provider priority: Gemini -> Groq -> OpenRouter
- Cooldowns: 10 minutes after a rate limit, 2 minutes after a network error/timeout
- Live dashboard at `/stats` with charts, provider health, and paginated request history
- Built-in playground for trying requests and exporting the code (cURL / JS / Python)
- Model picker with grouped dropdown (DeepSeek, Kimi, Llama, Qwen, etc.) plus a custom field
- Secret token auth so randoms on the internet can't drain your keys
- State persisted to disk every 30 seconds so cooldowns survive restarts

## Setup

### 1. Get free API keys

All three providers have generous free tiers. Sign up and grab a key:

- **Gemini** — https://aistudio.google.com/apikey
- **Groq** — https://console.groq.com/keys
- **OpenRouter** — https://openrouter.ai/keys

You don't need all three. The router skips providers with missing keys, but the more you add the more headroom you get.

### 2. Clone and install

```
git clone <your-repo-url> the-free-llm
cd the-free-llm
npm install
```

### 3. Configure `.env`

Create a `.env` file in the project root:

```
GEMINI_API_KEY=your_gemini_key
GROQ_API_KEY=your_groq_key
OPENROUTER_API_KEY=your_openrouter_key
PORT=3000
SECRET_TOKEN=pick_any_random_string
```

The `SECRET_TOKEN` is required on every `/ai` call — without it the endpoint returns `401`. Pick anything (a UUID, a long random string). If you leave it blank, auth is disabled (fine for local dev, not for hosting).

### 4. Run

Dev mode (auto-reload on changes):

```
npm run dev
```

Production:

```
npm run build
npm start
```

Server starts on `http://localhost:3000`.

## Usage

### Make a request

```
GET /ai?query=hello
```

With the auth header:

```
curl -H "x-secret-token: your_secret_token" \
  "http://localhost:3000/ai?query=write+a+haiku"
```

Response:

```
{
  "success": true,
  "provider": "gemini",
  "model": "gemini-2.5-flash-lite",
  "latency": 412,
  "response": "..."
}
```

### Query parameters

| Param | Description |
|---|---|
| `query` | The prompt (required) |
| `provider` | Force `gemini`, `groq`, or `openrouter` (disables failover) |
| `model` | Override the default model |
| `response` | `json` (default) or `text` |
| `temperature` | Float |
| `max_tokens` | Integer |
| `system` | System instruction |

### Dashboard, stats, and history

Open `http://localhost:3000/stats` in a browser. You get a live view of everything happening through the gateway:

- **Overview** — uptime, total requests, success/failure counts, average latency
- **Provider health** — which providers are healthy, which are cooling down and for how long, success rates, request counts, average latency per provider
- **Charts** — requests over time, provider distribution, success vs failures, latency trends (auto-refresh every 10 seconds)
- **Request history** — every request the gateway has handled, paginated 10 per page, newest first
- **Playground** — expand the panel at the top to send test prompts, pick a model from grouped dropdowns, see the response live, and export the code as cURL, JavaScript, or Python

You can also hit `/stats.json` for the raw data and `/models.json` for the live model catalog from all providers.

## Adding a new provider

This was designed to be easy. To plug in a new provider (say, Together AI or Mistral), you do two things.

### 1. Create a provider file

Drop a new file in `src/providers/` that implements the `Provider` interface:

```ts
// src/providers/myprovider.ts
import { Provider, GenerateOptions, GenerateResult, ProviderError } from './types';

export class MyProvider implements Provider {
  name = 'myprovider';

  async generateResponse(prompt: string, options: GenerateOptions = {}): Promise<GenerateResult> {
    // Call your provider's API here.
    // Throw `new ProviderError(msg, 'rate_limit' | 'timeout' | 'network' | 'error', statusCode)`
    // on failure — the router uses the kind to decide cooldown length.
    return { text: '...', model: '...', provider: this.name };
  }
}
```

### 2. Register it (one line)

Open `src/providers/registry.ts` and add one line:

```ts
registry.register(new MyProvider());
```

That's it. Failover, health tracking, cooldowns, dashboard cards, history, stats — all of it just starts working. The order of `registry.register` calls is the failover priority (first = highest).

## License

MIT
