import type { SessionAdapter } from "./types.ts";

/**
 * Adapter for the Claude CLI.
 * Uses --session-id for persistent sessions and -p for prompt.
 */
export class ClaudeAdapter implements SessionAdapter {
  buildCommand(
    binCommand: string,
    prompt: string,
    sessionId: string,
    isFirst: boolean,
    workingDir: string,
  ): string[] {
    const parts = splitCommand(binCommand);
    const streamFlags = [
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
    ];

    if (isFirst) {
      return [...parts, "--session-id", sessionId, ...streamFlags, "-p", prompt];
    }

    // Resume existing session by ID
    return [...parts, "--resume", sessionId, ...streamFlags, "-p", prompt];
  }

  parseOutput(stdout: string, _stderr: string): string {
    // Parse stream-json output: extract the final result text
    const lines = stdout.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const data = JSON.parse(trimmed);
        if (data.type === "result" && typeof data.result === "string") {
          return data.result;
        }
      } catch {
        // not JSON, skip
      }
    }
    // Fallback: return raw stdout
    return stdout;
  }

  /**
   * Parse a stream-json line for live display.
   *   "verbose" — main text content only
   *   "debug"   — text content + tool calls + tool results
   */
  parseStreamChunk(line: string, level: "verbose" | "debug" = "verbose"): string | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    const dim = "\x1b[2m";
    const yellow = "\x1b[33m";
    const green = "\x1b[32m";
    const cyan = "\x1b[36m";
    const gray = "\x1b[90m";
    const reset = "\x1b[0m";

    try {
      const data = JSON.parse(trimmed);

      // Text deltas — shown at both levels
      if (data.type === "stream_event" && data.event?.type === "content_block_delta") {
        const delta = data.event.delta;
        if (delta?.type === "text_delta" && delta.text) return delta.text;
        // Tool input JSON (debug only)
        if (level === "debug" && delta?.type === "input_json_delta" && delta.partial_json) {
          return `${dim}${delta.partial_json}${reset}`;
        }
      }

      // Tool use start — shown at both levels
      if (data.type === "stream_event" && data.event?.type === "content_block_start") {
        const block = data.event.content_block;
        if (block?.type === "tool_use") {
          return level === "debug"
            ? `\n  ${yellow}── [${block.name}] ──${reset}\n`
            : `\n  ${dim}[${block.name}]${reset} `;
        }
      }

      // Tool block end
      if (level === "debug" && data.type === "stream_event" && data.event?.type === "content_block_stop") {
        return "\n";
      }

      // Tool result — comes as a "user" event with tool_use_result
      if (level === "debug" && data.type === "user") {
        const result = data.tool_use_result;
        if (result) {
          const stdout = result.stdout ?? "";
          const stderr = result.stderr ?? "";
          const output = stdout || stderr;
          if (output) {
            const lines = output.split("\n");
            const preview = lines.length > 20
              ? lines.slice(0, 20).join("\n") + `\n${dim}... (${lines.length - 20} more lines)${reset}`
              : output;
            return `${gray}${preview}${reset}\n`;
          }
          if (result.isImage) return `${dim}[image]${reset}\n`;
          return null;
        }
        // Fallback: check content array for tool_result blocks
        const content = data.message?.content;
        if (Array.isArray(content)) {
          const toolResults = content
            .filter((b: { type: string }) => b.type === "tool_result")
            .map((b: { content: string }) => b.content)
            .filter(Boolean);
          if (toolResults.length > 0) {
            return `${gray}${toolResults.join("\n")}${reset}\n`;
          }
        }
      }

      // Result event — debug only, show summary
      if (level === "debug" && data.type === "result") {
        const cost = data.total_cost_usd;
        const turns = data.num_turns;
        const duration = data.duration_ms;
        const statusColor = data.subtype === "success" ? green : "\x1b[31m";
        return `\n  ${cyan}── ${statusColor}${data.subtype}${reset} ${dim}│ ${turns} turn(s) │ ${(duration / 1000).toFixed(1)}s │ $${cost?.toFixed(4) ?? "?"}${reset} ${cyan}──${reset}\n`;
      }
    } catch {
      // not JSON
    }
    return null;
  }
}

/**
 * Generic adapter for unknown BINs.
 * Passes prompt via stdin. No session persistence — the expanded prompt
 * includes full context to compensate.
 */
export class GenericAdapter implements SessionAdapter {
  buildCommand(
    binCommand: string,
    prompt: string,
    _sessionId: string,
    _isFirst: boolean,
    _workingDir: string,
  ): string[] {
    // For generic bins, we pass the prompt as the last argument.
    // The prompt engineer will have figured out the right invocation.
    const parts = splitCommand(binCommand);
    return [...parts, prompt];
  }

  parseOutput(stdout: string, _stderr: string): string {
    return stdout;
  }
}

/**
 * Auto-detect the right adapter based on the BIN command.
 */
export function detectAdapter(binCommand: string): SessionAdapter {
  const cmd = binCommand.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

  if (cmd === "claude" || cmd.endsWith("/claude")) {
    return new ClaudeAdapter();
  }

  return new GenericAdapter();
}

/**
 * Split a command string into parts, respecting quoted strings.
 */
function splitCommand(cmd: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (const ch of cmd) {
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === " " || ch === "\t") {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }

  if (current) parts.push(current);
  return parts;
}
