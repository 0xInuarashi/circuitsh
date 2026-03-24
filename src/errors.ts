export class CircuitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircuitError";
  }
}

// ── Parse / Config errors (fatal) ──

export class ParseError extends CircuitError {
  line: number;

  constructor(message: string, line: number) {
    super(`Line ${line}: ${message}`);
    this.name = "ParseError";
    this.line = line;
  }
}

export class ConfigError extends CircuitError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// ── BIN errors ──

export class BinError extends CircuitError {
  constructor(message: string) {
    super(message);
    this.name = "BinError";
  }
}

export class BinNotFoundError extends BinError {
  constructor(bin: string) {
    super(`BIN not found or not executable: ${bin}`);
    this.name = "BinNotFoundError";
  }
}

export class BinTimeoutError extends BinError {
  timeoutMs: number;
  partialStdout: string;
  partialStderr: string;

  constructor(bin: string, timeoutMs: number, partialStdout = "", partialStderr = "") {
    super(`BIN timed out after ${timeoutMs}ms: ${bin}`);
    this.name = "BinTimeoutError";
    this.timeoutMs = timeoutMs;
    this.partialStdout = partialStdout;
    this.partialStderr = partialStderr;
  }
}

// ── Prompt Engineer / API errors ──

export class PromptEngineerError extends CircuitError {
  statusCode: number | null;

  constructor(message: string, statusCode: number | null = null) {
    super(message);
    this.name = "PromptEngineerError";
    this.statusCode = statusCode;
  }
}

export class AuthError extends PromptEngineerError {
  constructor(message: string, statusCode: number) {
    super(message, statusCode);
    this.name = "AuthError";
  }
}

export class RateLimitError extends PromptEngineerError {
  constructor(message: string = "Rate limit exceeded") {
    super(message, 429);
    this.name = "RateLimitError";
  }
}

export class ProviderError extends PromptEngineerError {
  constructor(message: string, statusCode: number) {
    super(message, statusCode);
    this.name = "ProviderError";
  }
}
