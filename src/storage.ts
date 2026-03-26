import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type {
  CircuitConfig,
  CircuitEndEvent,
  CircuitEvent,
  CircuitStartEvent,
  ConversationTurn,
  IterationEvent,
  IterationResult,
  SessionRecoveryDoc,
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
 * Create log paths for a circuit run.
 * Returns both the JSONL path and a per-run directory for raw/recovery logs.
 */
export function makeLogPaths(circuitName: string, logDir: string): {
  jsonlPath: string;
  runDir: string;
} {
  mkdirSync(logDir, { recursive: true });
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "_")
    .slice(0, 15);
  const slug = sanitize(circuitName);
  const base = `circuit_${timestamp}_${slug}`;
  const runDir = join(logDir, base);
  mkdirSync(join(runDir, "raw"), { recursive: true });
  mkdirSync(join(runDir, "recovery"), { recursive: true });
  mkdirSync(join(runDir, "engineer"), { recursive: true });
  return {
    jsonlPath: join(logDir, `${base}.jsonl`),
    runDir,
  };
}

/** @deprecated Use makeLogPaths instead */
export function makeLogPath(circuitName: string, logDir: string): string {
  return makeLogPaths(circuitName, logDir).jsonlPath;
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
  runRawLogRef: string | null,
  evalRawLogRef: string | null,
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
      rawLogRef: runRawLogRef,
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
          rawLogRef: evalRawLogRef,
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

// ── Raw Stream Logs ──

/**
 * Write raw stdout/stderr from a BIN invocation to individual files.
 * Returns relative path to the stdout log for embedding in JSONL events.
 */
export function writeRawStreamLog(
  runDir: string,
  opts: {
    role: "run" | "eval";
    stepIndex: number;
    iteration: number;
    stdout: string;
    stderr: string;
  },
): string {
  const prefix = `step${opts.stepIndex}_iter${opts.iteration}_${opts.role}`;
  const stdoutPath = join(runDir, "raw", `${prefix}.stdout.log`);
  const stderrPath = join(runDir, "raw", `${prefix}.stderr.log`);
  writeFileSync(stdoutPath, opts.stdout, "utf-8");
  writeFileSync(stderrPath, opts.stderr, "utf-8");
  return `raw/${prefix}.stdout.log`;
}

// ── Session Recovery ──

/**
 * Parse raw stream-json output into a structured conversation trace.
 * Extracts tool calls, tool results, text content, and metadata.
 */
export function parseStreamJsonToTrace(rawStdout: string): {
  turns: ConversationTurn[];
  resultText: string | null;
  metadata: { totalCostUsd: number | null; numTurns: number | null; durationMs: number | null };
} {
  const turns: ConversationTurn[] = [];
  let resultText: string | null = null;
  let metadata = { totalCostUsd: null as number | null, numTurns: null as number | null, durationMs: null as number | null };
  let currentTextContent = "";
  let currentToolName: string | null = null;
  let currentToolInput = "";

  for (const line of rawStdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const data = JSON.parse(trimmed);

      // Text content deltas → accumulate
      if (data.type === "stream_event" && data.event?.type === "content_block_delta") {
        if (data.event.delta?.type === "text_delta") {
          currentTextContent += data.event.delta.text;
        } else if (data.event.delta?.type === "input_json_delta") {
          currentToolInput += data.event.delta.partial_json;
        }
      }

      // Tool use start
      if (data.type === "stream_event" && data.event?.type === "content_block_start") {
        if (currentTextContent) {
          turns.push({ role: "assistant", content: currentTextContent });
          currentTextContent = "";
        }
        if (data.event.content_block?.type === "tool_use") {
          currentToolName = data.event.content_block.name;
          currentToolInput = "";
        }
      }

      // Content block stop → finalize tool call
      if (data.type === "stream_event" && data.event?.type === "content_block_stop") {
        if (currentToolName) {
          turns.push({
            role: "tool_call",
            content: currentToolInput,
            toolName: currentToolName,
          });
          currentToolName = null;
          currentToolInput = "";
        }
      }

      // Tool results from user turns
      if (data.type === "user") {
        const result = data.tool_use_result;
        if (result) {
          turns.push({
            role: "tool_result",
            content: result.stdout || result.stderr || "",
          });
        }
        // Fallback: content array with tool_result blocks
        const content = data.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result" && block.content) {
              turns.push({ role: "tool_result", content: block.content });
            }
          }
        }
      }

      // Result event
      if (data.type === "result") {
        resultText = typeof data.result === "string" ? data.result : null;
        metadata = {
          totalCostUsd: data.total_cost_usd ?? null,
          numTurns: data.num_turns ?? null,
          durationMs: data.duration_ms ?? null,
        };
      }
    } catch {
      // not JSON line, skip
    }
  }

  // Flush remaining text
  if (currentTextContent) {
    turns.push({ role: "assistant", content: currentTextContent });
  }

  return { turns, resultText, metadata };
}

/**
 * Write a session recovery document from raw stream-json output.
 * This doc can be injected into a new session prompt when --resume fails.
 */
export function writeSessionRecoveryDoc(
  runDir: string,
  opts: {
    circuitName: string;
    role: "run" | "eval";
    stepIndex: number;
    iteration: number;
    sessionId: string;
    rawStdout: string;
  },
): string {
  const trace = parseStreamJsonToTrace(opts.rawStdout);
  const doc: SessionRecoveryDoc = {
    circuitName: opts.circuitName,
    stepIndex: opts.stepIndex,
    iteration: opts.iteration,
    sessionId: opts.sessionId,
    role: opts.role,
    conversationTrace: trace.turns,
    resultText: trace.resultText,
    metadata: trace.metadata,
  };
  const filename = `step${opts.stepIndex}_${opts.role}_session.json`;
  const docPath = join(runDir, "recovery", filename);
  writeFileSync(docPath, JSON.stringify(doc, null, 2), "utf-8");
  return `recovery/${filename}`;
}

/**
 * Format a session recovery document into a context block for prompt injection.
 */
export function formatRecoveryContext(doc: SessionRecoveryDoc): string {
  let context = "<session_recovery>\n";
  context += "The previous session encountered an error and could not be resumed. ";
  context += "Here is the full conversation history from that session. ";
  context += "Continue from where it left off — do not repeat completed work.\n\n";

  for (const turn of doc.conversationTrace) {
    if (turn.role === "tool_call") {
      context += `[Tool Call: ${turn.toolName}]\n${turn.content}\n\n`;
    } else if (turn.role === "tool_result") {
      context += `[Tool Result]\n${turn.content}\n\n`;
    } else {
      context += `[Assistant]\n${turn.content}\n\n`;
    }
  }

  if (doc.resultText) {
    context += `[Final Result]\n${doc.resultText}\n\n`;
  }

  context += "</session_recovery>\n";
  return context;
}

/**
 * Write a manifest.json summarizing all log files for a circuit run.
 */
export function writeManifest(runDir: string, manifest: {
  circuitName: string;
  jsonlPath: string;
  startedAt: string;
  endedAt: string;
  success: boolean;
  totalSteps: number;
  totalIterations: number;
  durationMs: number;
}): void {
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
}

// ── Prompt Engineer Logs ──

export interface EngineerCallLog {
  callType: "run_expand" | "timeout_diagnosis";
  stepIndex: number;
  iteration: number;
  timestamp: string;
  durationMs: number;
  model: string;
  temperature: number;
  messages: Array<{ role: string; content: string }>;
  rawOutput: string;
  parsedResult: Record<string, unknown>;
  formatRetried: boolean;
}

/**
 * Write a prompt engineer call log to the engineer/ directory.
 * Each call gets its own JSON file for full traceability.
 * Returns the relative path within the run directory.
 */
export function writeEngineerCallLog(
  runDir: string,
  log: EngineerCallLog,
): string {
  const filename = `step${log.stepIndex}_iter${log.iteration}_${log.callType}.json`;
  const filePath = join(runDir, "engineer", filename);

  // Avoid overwriting (e.g., re-expansion after request_input) — append sequence number
  let finalPath = filePath;
  let seq = 0;
  while (existsSync(finalPath)) {
    seq++;
    finalPath = join(runDir, "engineer", `step${log.stepIndex}_iter${log.iteration}_${log.callType}_${seq}.json`);
  }

  writeFileSync(finalPath, JSON.stringify(log, null, 2), "utf-8");
  return finalPath.slice(runDir.length + 1); // relative path
}

/**
 * Append a raw API traffic event to the engineer/api_traffic.jsonl file.
 * Captures all SSE chunks, HTTP status codes, retries, errors — everything
 * the OpenRouterClient sees at the wire level.
 */
export function appendApiTrafficLog(
  runDir: string,
  label: string,
  data: string,
): void {
  const event = {
    timestamp: new Date().toISOString(),
    label,
    data,
  };
  appendFileSync(
    join(runDir, "engineer", "api_traffic.jsonl"),
    JSON.stringify(event) + "\n",
    "utf-8",
  );
}
