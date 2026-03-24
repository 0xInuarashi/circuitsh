// ── AST Types ──

export interface Define {
  key: string;
  value: string;
  line: number;
}

export interface RunStep {
  prompt: string;
  line: number;
}

export interface EvalStep {
  prompt: string;
  retry: number;
  line: number;
}

export interface Step {
  run: RunStep;
  eval: EvalStep | null; // null for fire-and-forget RUNs
}

export interface CircuitBlock {
  name: string;
  steps: Step[];
  line: number;
}

export interface CircuitAST {
  defines: Define[];
  circuits: CircuitBlock[];
}

// ── Token Types ──

export type TokenType =
  | "DEFINE"
  | "CIRCUIT_DECL"
  | "RUN"
  | "EVAL"
  | "RETRY"
  | "COMMENT"
  | "BLANK";

export interface Token {
  type: TokenType;
  value: string;
  secondaryValue?: string; // for DEFINE: key in value, directive value in secondaryValue
  line: number;
}

// ── Config Types ──

export interface CircuitConfig {
  provider: string;
  apiKey: string;
  promptEngineerModel: string;
  runBin: string;
  evalBin: string;
  dir: string;
  logDir: string;
  checkpoint: boolean;
  timeout: number;
}

export const CONFIG_DEFAULTS: Partial<CircuitConfig> = {
  provider: "openrouter",
  promptEngineerModel: "anthropic/claude-haiku-4-5",
  dir: ".",
  logDir: ".circuit-runs",
  checkpoint: false,
  timeout: 0,
};

// Maps .circuit DEFINE keys to CircuitConfig fields
export const DEFINE_KEY_MAP: Record<string, keyof CircuitConfig> = {
  PROVIDER: "provider",
  API_KEY: "apiKey",
  PROMPT_ENGINEER_MODEL: "promptEngineerModel",
  RUN_BIN: "runBin",
  EVAL_BIN: "evalBin",
  DIR: "dir",
  LOG_DIR: "logDir",
  CHECKPOINT: "checkpoint",
  TIMEOUT: "timeout",
};

// Maps env var names to CircuitConfig fields
export const ENV_VAR_MAP: Record<string, keyof CircuitConfig> = {
  CIRCUIT_PROVIDER: "provider",
  CIRCUIT_API_KEY: "apiKey",
  OPENROUTER_API_KEY: "apiKey",
  CIRCUIT_PROMPT_ENGINEER_MODEL: "promptEngineerModel",
  CIRCUIT_RUN_BIN: "runBin",
  CIRCUIT_EVAL_BIN: "evalBin",
  CIRCUIT_DIR: "dir",
  CIRCUIT_LOG_DIR: "logDir",
  CIRCUIT_CHECKPOINT: "checkpoint",
  CIRCUIT_TIMEOUT: "timeout",
};

// ── Execution State Types ──

export interface IterationResult {
  stepIndex: number;
  iteration: number;
  maxRetries: number;
  expandedRunPrompt: string;
  runOutput: BinOutput;
  expandedEvalPrompt: string | null;
  evalOutput: BinOutput | null;
  verdict: "SUCCESS" | "FAILURE" | null;
  feedback: string;
  scratchpad: Record<string, string>;
  engineerScratchpad: Record<string, string>;
  workingDirDiff: string;
  durationMs: number;
  timestamp: string;
}

export interface BinOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  command: string[];
}

export interface StepState {
  stepIndex: number;
  run: RunStep;
  eval: EvalStep | null;
  runSessionId: string;
  evalSessionId: string;
  scratchpad: Record<string, string>;
  engineerScratchpad: Record<string, string>;
  iterations: IterationResult[];
  success: boolean;
}

export interface CircuitRunState {
  circuitName: string;
  config: CircuitConfig;
  steps: StepState[];
  success: boolean;
  startTime: string;
  endTime: string | null;
}

// ── Prompt Engineer Types ──

export interface ExpansionContext {
  role: "run" | "eval";
  goal: string;
  userPrompt: string;
  iteration: number;
  maxRetries: number;
  isFirst: boolean;
  evalFeedback: string | null;
  scratchpad: Record<string, string>;
  engineerScratchpad: Record<string, string>;
  workingDirSnapshot: string;
  workingDirDiff: string;
  environment: EnvironmentInfo;
  stepContext: string | null; // summary of previous steps for multi-step
  evalHistory: string | null; // compressed eval history for EVAL expansion
  executionHistory: IterationResult[]; // full history for prompt engineer
}

export interface EnvironmentInfo {
  os: string;
  shell: string;
  cwd: string;
  date: string;
}

export interface ExpansionResult {
  expandedPrompt: string;
  engineerScratchpadUpdates: Record<string, string>;
  rawResponse: string;
}

// ── OpenRouter Streaming Types ──

export interface StreamChunk {
  content: string;
  reasoning: string;
}

// ── Session Adapter Interface ──

export interface SessionAdapter {
  buildCommand(
    binCommand: string,
    prompt: string,
    sessionId: string,
    isFirst: boolean,
    workingDir: string,
  ): string[];
  parseOutput(stdout: string, stderr: string): string;
}

// ── CLI Options ──

export interface CLIOptions {
  dryRun: boolean;
  verbose: boolean;
  logDir?: string;
  apiKey?: string;
  step?: number;
  resume?: string;
  debug: boolean;
}

// ── JSONL Event Types ──

export interface CircuitStartEvent {
  event: "circuit_start";
  timestamp: string;
  circuitName: string;
  config: CircuitConfig;
  steps: Array<{
    runPrompt: string;
    evalPrompt: string | null;
    maxRetries: number;
  }>;
}

export interface StepStartEvent {
  event: "step_start";
  timestamp: string;
  stepIndex: number;
  runPrompt: string;
  evalPrompt: string | null;
}

export interface IterationEvent {
  event: "iteration";
  timestamp: string;
  stepIndex: number;
  iteration: number;
  maxRetries: number;
  expandRun: {
    context: Record<string, unknown>;
    expandedPrompt: string;
    rawEngineerResponse: string;
  };
  run: {
    command: string[];
    stdout: string;
    stderr: string;
    exitCode: number | null;
    durationMs: number;
  };
  expandEval: {
    context: Record<string, unknown>;
    expandedPrompt: string;
    rawEngineerResponse: string;
  } | null;
  eval: {
    command: string[];
    stdout: string;
    stderr: string;
    exitCode: number | null;
    durationMs: number;
  } | null;
  verdict: "SUCCESS" | "FAILURE" | null;
  feedback: string;
  scratchpad: Record<string, string>;
  engineerScratchpad: Record<string, string>;
  workingDirDiff: string;
}

export interface StepEndEvent {
  event: "step_end";
  timestamp: string;
  stepIndex: number;
  success: boolean;
  totalIterations: number;
}

export interface CircuitEndEvent {
  event: "circuit_end";
  timestamp: string;
  success: boolean;
  totalStepsCompleted: number;
  totalSteps: number;
  totalIterations: number;
  durationMs: number;
}

export type CircuitEvent =
  | CircuitStartEvent
  | StepStartEvent
  | IterationEvent
  | StepEndEvent
  | CircuitEndEvent;
