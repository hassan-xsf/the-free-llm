<p align="center">
  <img width="264" height="56" alt="FREE LLM" src="https://github.com/user-attachments/assets/97806c63-e210-4930-ae9e-80cc58feeeaf" />
</p>

<h2 align="center">One Free LLM API — Gemini + Groq + OpenRouter</h2>
<p align="center">Stacked free tiers behind a single endpoint. Auto-failover when one rate-limits you.</p>
<p align="center">Built with TypeScript, Express, and a vanilla dashboard.</p>

---

## Why this exists

Free-tier limits kill demos. You build something cool, three people try it, the quota is gone. THE FREE LLM stacks Gemini, Groq, and OpenRouter behind one endpoint — when one runs out, the next one's already answering. Drop your free API keys into `.env`, run one command, done.

---

## Screenshots

<p align="center">
  <img src="https://github.com/user-attachments/assets/ddb6a804-c39e-44c7-8f44-a04275e124ab" width="100%" alt="Dashboard statistics" />
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/db742ce8-bc1e-4bd5-927c-9dbe89849042" width="100%" alt="Playground with code export" />
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/4a6722af-e8f6-4f63-9f64-e4ec944f6ab9" width="100%" alt="Paginated request history" />
</p>

---

## Features

- Single `GET /ai` endpoint with automatic failover across providers
- Provider priority: Gemini -> Groq -> OpenRouter
- Cooldowns: 10 minutes after a rate limit, 2 minutes after a network error/timeout
- Live dashboard at `/stats` with charts, provider health, and paginated request history
- Built-in playground for trying requests and exporting the code (cURL / JS / Python)
- Model picker with grouped dropdown (DeepSeek, Kimi, Llama, Qwen, etc.) plus a custom field
- Secret token auth so randoms on the internet can't drain your keys
- State persisted to disk every 30 seconds so cooldowns survive restarts

---

## Setup

### 1. Get free API keys

All three providers have generous free tiers. Sign up and grab a key:

- **Gemini** — https://aistudio.google.com/apikey
- **Groq** — https://console.groq.com/keys
- **OpenRouter** — https://openrouter.ai/keys

You don't need all three. The router skips providers with missing keys, but the more you add the more headroom you get.

### 2. Clone and install

```
git clone https://github.com/hassan-xsf/the-free-llm
cd the-free-llm
npm install
```

### 3. Configure `.env`

Copy `.env.example` to `.env` and fill in your keys:

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

---

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

---

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

---

## License

MIT
