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

/**
 * OpenRouter API client with streaming SSE support.
 */
export class OpenRouterClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl: string = OPENROUTER_BASE) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  /**
   * Non-streaming completion. Returns full content string.
   */
  async complete(
    model: string,
    messages: Message[],
    temperature: number,
  ): Promise<string> {
    const resp = await this.request({ model, messages, temperature, stream: false });
    const data = (await resp.json()) as Record<string, unknown>;
    const choices = data.choices as Array<{ message?: { content?: string } }> | undefined;
    return choices?.[0]?.message?.content ?? "";
  }

  /**
   * Streaming completion. Yields StreamChunk objects.
   */
  async *stream(
    model: string,
    messages: Message[],
    temperature: number,
  ): AsyncGenerator<StreamChunk> {
    const resp = await this.request({ model, messages, temperature, stream: true });

    if (!resp.body) {
      throw new PromptEngineerError("No response body for streaming request");
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const dataStr = line.slice(6).trim();
          if (dataStr === "[DONE]") return;

          try {
            const data = JSON.parse(dataStr);
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
    } finally {
      reader.releaseLock();
    }
  }

  private async request(options: CompletionOptions): Promise<Response> {
    const payload = {
      model: options.model,
      messages: options.messages,
      temperature: options.temperature,
      stream: options.stream ?? false,
    };

    const maxRetries429 = 3;
    const maxRetries5xx = 1;
    let retries429 = 0;
    let retries5xx = 0;

    while (true) {
      const resp = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/circuitsh",
          "X-Title": "circuit",
        },
        body: JSON.stringify(payload),
      });

      if (resp.ok) return resp;

      const body = await resp.text().catch(() => "(could not read body)");

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
        await sleep(2000 * retries429); // exponential-ish backoff
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
