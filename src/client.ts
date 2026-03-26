import type { StreamChunk } from "./types.ts";
import {
  AuthError,
  PromptEngineerError,
  ProviderError,
  RateLimitError,
} from "./errors.ts";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

interface CompletionOptions {
  model: string;
  messages: Message[];
  temperature: number;
  stream?: boolean;
}

export type RawLogger = (label: string, data: string) => void;

/**
 * OpenRouter API client with streaming SSE support.
 */
export class OpenRouterClient {
  private apiKey: string;
  private baseUrl: string;
  private rawLogger: RawLogger | null;
  private diskLogger: RawLogger | null;

  constructor(
    apiKey: string,
    baseUrl: string = OPENROUTER_BASE,
    rawLogger: RawLogger | null = null,
    diskLogger: RawLogger | null = null,
  ) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.rawLogger = rawLogger;
    this.diskLogger = diskLogger;
  }

  private raw(label: string, data: unknown): void {
    const str = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    if (this.rawLogger) {
      this.rawLogger(label, str);
    }
    if (this.diskLogger) {
      this.diskLogger(label, str);
    }
  }

  /**
   * Completion that uses streaming internally to avoid timeouts on long requests.
   * Collects all chunks and returns the full content string.
   */
  async complete(
    model: string,
    messages: Message[],
    temperature: number,
  ): Promise<string> {
    const chunks: string[] = [];
    for await (const chunk of this.stream(model, messages, temperature)) {
      chunks.push(chunk.content);
    }
    return chunks.join("");
  }

  /**
   * Streaming completion. Yields StreamChunk objects.
   * Optionally calls onResult when the result metadata event is received.
   */
  async *stream(
    model: string,
    messages: Message[],
    temperature: number,
    onResult?: (meta: { totalCostUsd: number | null; numTurns: number | null; durationMs: number | null; subtype: string | null }) => void,
  ): AsyncGenerator<StreamChunk> {
    const maxStreamRetries = 3;

    for (let attempt = 0; attempt <= maxStreamRetries; attempt++) {
      const resp = await this.request({ model, messages, temperature, stream: true });

      if (!resp.body) {
        throw new PromptEngineerError("No response body for streaming request");
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let gotData = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          gotData = true;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const dataStr = line.slice(6).trim();
            if (dataStr === "[DONE]") return;
            this.raw("SSE CHUNK", line);

            try {
              const data = JSON.parse(dataStr);
              // Result metadata event
              if (data.type === "result" && onResult) {
                onResult({
                  totalCostUsd: data.total_cost_usd ?? null,
                  numTurns: data.num_turns ?? null,
                  durationMs: data.duration_ms ?? null,
                  subtype: data.subtype ?? null,
                });
              }
              const delta = data.choices?.[0]?.delta ?? {};
              const content = delta.content ?? "";
              const reasoning = delta.reasoning ?? "";
              if (content || reasoning) {
                yield { content, reasoning };
              }
            } catch {
              // skip malformed JSON chunks
            }
          }
        }
        // Stream completed normally
        return;
      } catch (err) {
        reader.releaseLock();
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt >= maxStreamRetries) {
          throw new ProviderError(`Stream failed after ${maxStreamRetries} retries: ${msg}`, 0);
        }
        this.raw("STREAM ERROR", `${msg} — retry ${attempt + 1}/${maxStreamRetries}${gotData ? " (partial data received, restarting)" : ""}`);
        await sleep(1000 * (attempt + 1));
        // Retry the entire request — can't resume SSE mid-stream
        continue;
      } finally {
        try { reader.releaseLock(); } catch { /* already released */ }
      }
    }
  }

  private async request(options: CompletionOptions): Promise<Response> {
    const payload = {
      model: options.model,
      messages: options.messages,
      temperature: options.temperature,
      stream: options.stream ?? false,
    };

    const url = `${this.baseUrl}/chat/completions`;
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/circuitsh",
      "X-Title": "circuit",
    };

    this.raw("API REQUEST", {
      url,
      method: "POST",
      headers: { ...headers, Authorization: "Bearer ***" },
      body: payload,
    });

    const maxRetries429 = 3;
    const maxRetries5xx = 1;
    const maxRetriesNetwork = 3;
    let retries429 = 0;
    let retries5xx = 0;
    let retriesNetwork = 0;

    while (true) {
      let resp: Response;
      try {
        resp = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });
      } catch (err) {
        retriesNetwork++;
        const msg = err instanceof Error ? err.message : String(err);
        if (retriesNetwork > maxRetriesNetwork) {
          throw new ProviderError(`Network error after ${maxRetriesNetwork} retries: ${msg}`, 0);
        }
        this.raw("NETWORK ERROR", `${msg} — retry ${retriesNetwork}/${maxRetriesNetwork}, sleeping ${1000 * retriesNetwork}ms`);
        await sleep(1000 * retriesNetwork);
        continue;
      }

      this.raw("API RESPONSE STATUS", `${resp.status} ${resp.statusText}`);

      if (resp.ok) return resp;

      const body = await resp.text().catch(() => "(could not read body)");
      this.raw("API ERROR BODY", body);

      if (resp.status === 401 || resp.status === 402) {
        throw new AuthError(
          `Authentication failed (${resp.status}): ${body}`,
          resp.status,
        );
      }

      if (resp.status === 429) {
        retries429++;
        if (retries429 > maxRetries429) {
          throw new RateLimitError("Rate limit exceeded after retries");
        }
        this.raw("RATE LIMIT", `Retry ${retries429}/${maxRetries429}, sleeping ${2000 * retries429}ms`);
        await sleep(2000 * retries429);
        continue;
      }

      if (resp.status === 502 || resp.status === 503) {
        retries5xx++;
        if (retries5xx > maxRetries5xx) {
          throw new ProviderError(
            `Provider error (${resp.status}) after retry: ${body}`,
            resp.status,
          );
        }
        this.raw("PROVIDER ERROR", `Retry ${retries5xx}/${maxRetries5xx}`);
        await sleep(1000);
        continue;
      }

      throw new PromptEngineerError(
        `Unexpected status ${resp.status}: ${body}`,
        resp.status,
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
