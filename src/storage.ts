import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import type {
  CircuitConfig,
  CircuitEndEvent,
  CircuitEvent,
  CircuitStartEvent,
  IterationEvent,
  IterationResult,
  Step,
  StepEndEvent,
  StepStartEvent,
} from "./types.ts";

/**
 * Sanitize text for use in filenames.
 */
function sanitize(text: string, maxLen: number = 40): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "_")
    .trim()
    .slice(0, maxLen);
}

/**
 * Create a JSONL log file path for a circuit run.
 */
export function makeLogPath(circuitName: string, logDir: string): string {
  mkdirSync(logDir, { recursive: true });
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "_")
    .slice(0, 15);
  const slug = sanitize(circuitName);
  return join(logDir, `circuit_${timestamp}_${slug}.jsonl`);
}

/**
 * Append a single event to the JSONL log file.
 */
function appendEvent(path: string, event: CircuitEvent): void {
  appendFileSync(path, JSON.stringify(event) + "\n", "utf-8");
}

export function logCircuitStart(
  path: string,
  circuitName: string,
  config: CircuitConfig,
  steps: Step[],
): void {
  const event: CircuitStartEvent = {
    event: "circuit_start",
    timestamp: new Date().toISOString(),
    circuitName,
    config,
    steps: steps.map((s) => ({
      runPrompt: s.run.prompt,
      evalPrompt: s.eval?.prompt ?? null,
      maxRetries: s.eval?.retry ?? 0,
    })),
  };
  appendEvent(path, event);
}

export function logStepStart(
  path: string,
  stepIndex: number,
  runPrompt: string,
  evalPrompt: string | null,
): void {
  const event: StepStartEvent = {
    event: "step_start",
    timestamp: new Date().toISOString(),
    stepIndex,
    runPrompt,
    evalPrompt,
  };
  appendEvent(path, event);
}

export function logIteration(
  path: string,
  result: IterationResult,
  expandRunRaw: string,
  expandEvalRaw: string | null,
): void {
  const event: IterationEvent = {
    event: "iteration",
    timestamp: result.timestamp,
    stepIndex: result.stepIndex,
    iteration: result.iteration,
    maxRetries: result.maxRetries,
    expandRun: {
      context: {},
      expandedPrompt: result.expandedRunPrompt,
      rawEngineerResponse: expandRunRaw,
    },
    run: {
      command: result.runOutput.command,
      stdout: result.runOutput.stdout,
      stderr: result.runOutput.stderr,
      exitCode: result.runOutput.exitCode,
      durationMs: result.runOutput.durationMs,
    },
    expandEval: expandEvalRaw
      ? {
          context: {},
          expandedPrompt: result.expandedEvalPrompt ?? "",
          rawEngineerResponse: expandEvalRaw,
        }
      : null,
    eval: result.evalOutput
      ? {
          command: result.evalOutput.command,
          stdout: result.evalOutput.stdout,
          stderr: result.evalOutput.stderr,
          exitCode: result.evalOutput.exitCode,
          durationMs: result.evalOutput.durationMs,
        }
      : null,
    verdict: result.verdict,
    feedback: result.feedback,
    scratchpad: result.scratchpad,
    engineerScratchpad: result.engineerScratchpad,
    workingDirDiff: result.workingDirDiff,
  };
  appendEvent(path, event);
}

export function logStepEnd(
  path: string,
  stepIndex: number,
  success: boolean,
  totalIterations: number,
): void {
  const event: StepEndEvent = {
    event: "step_end",
    timestamp: new Date().toISOString(),
    stepIndex,
    success,
    totalIterations,
  };
  appendEvent(path, event);
}

export function logCircuitEnd(
  path: string,
  success: boolean,
  totalStepsCompleted: number,
  totalSteps: number,
  totalIterations: number,
  durationMs: number,
): void {
  const event: CircuitEndEvent = {
    event: "circuit_end",
    timestamp: new Date().toISOString(),
    success,
    totalStepsCompleted,
    totalSteps,
    totalIterations,
    durationMs,
  };
  appendEvent(path, event);
}
