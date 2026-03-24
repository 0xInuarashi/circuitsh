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

    if (isFirst) {
      return [...parts, "--session-id", sessionId, "-p", prompt];
    }

    // Continue existing session
    return [...parts, "--session-id", sessionId, "--continue", "-p", prompt];
  }

  parseOutput(stdout: string, _stderr: string): string {
    return stdout;
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
