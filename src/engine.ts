import { execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { platform, release } from "os";
import type {
  CircuitAST,
  CircuitConfig,
  CLIOptions,
  EnvironmentInfo,
  ExpansionContext,
  IterationResult,
  StepState,
} from "./types.ts";
import { OpenRouterClient } from "./client.ts";
import { Harness } from "./harness.ts";
import { detectAdapter } from "./session.ts";
import { runBin } from "./runner.ts";
import { parseVerdict, parseScratchpadUpdates } from "./verdict.ts";
import {
  logCircuitStart,
  logCircuitEnd,
  logStepStart,
  logStepEnd,
  logIteration,
  makeLogPath,
} from "./storage.ts";
import { AuthError, BinTimeoutError, RateLimitError } from "./errors.ts";

// ── ANSI Colors ──
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
  bgGreen: "\x1b[42m",
  bgRed: "\x1b[41m",
};

/**
 * Execute a parsed circuit.
 */
export async function executeCircuit(
  ast: CircuitAST,
  config: CircuitConfig,
  cliOptions: CLIOptions,
): Promise<boolean> {
  const circuit = ast.circuits[0]!;
  const rawLogger = cliOptions.raw
    ? (label: string, data: string) => {
        console.log(`\n${c.gray}┌── RAW: ${label} ──${c.reset}`);
        console.log(`${c.gray}${data}${c.reset}`);
        console.log(`${c.gray}└── END: ${label} ──${c.reset}\n`);
      }
    : null;
  const client = new OpenRouterClient(config.apiKey, config.apiUrl, rawLogger);
  const harness = new Harness(client, config.promptEngineerModel);
  const runAdapter = detectAdapter(config.runBin);
  const evalAdapter = detectAdapter(config.evalBin);
  const env = getEnvironment(config);

  // Ensure working directory exists
  if (!existsSync(config.dir)) {
    mkdirSync(config.dir, { recursive: true });
    console.log(`Created directory: ${config.dir}`);
  }

  const logPath = makeLogPath(circuit.name, config.logDir);
  logCircuitStart(logPath, circuit.name, config, circuit.steps);

  const startTime = Date.now();
  let totalIterations = 0;
  let stepsCompleted = 0;
  let circuitSuccess = true;

  // Filter to specific step if --step was provided
  const stepsToRun = cliOptions.step !== undefined
    ? [{ step: circuit.steps[cliOptions.step - 1]!, index: cliOptions.step - 1 }]
    : circuit.steps.map((step, index) => ({ step, index }));

  const completedStepSummaries: string[] = [];

  for (const { step, index: stepIndex } of stepsToRun) {
    if (!step) {
      console.error(`Step ${stepIndex + 1} does not exist`);
      circuitSuccess = false;
      break;
    }

    logStepStart(logPath, stepIndex, step.run.prompt, step.eval?.prompt ?? null);
    console.log(`\n${c.cyan}${"─".repeat(60)}${c.reset}`);
    console.log(`${c.bold}${c.cyan}Step ${stepIndex + 1}/${circuit.steps.length}${c.reset} ${c.dim}│${c.reset} ${c.white}RUN${c.reset}`);
    console.log(`${c.cyan}${"─".repeat(60)}${c.reset}`);

    const state: StepState = {
      stepIndex,
      run: step.run,
      eval: step.eval,
      runSessionId: crypto.randomUUID(),
      evalSessionId: crypto.randomUUID(),
      scratchpad: {},
      engineerScratchpad: {},
      iterations: [],
      success: false,
    };

    const maxRetries = step.eval?.retry ?? 0;
    const maxAttempts = maxRetries + 1;

    for (let iteration = 0; iteration < maxAttempts; iteration++) {
      const isFirst = iteration === 0;

      if (!isFirst) {
        console.log(`\n  ${c.yellow}↻ Retry ${iteration}/${maxRetries}${c.reset}`);
      }

      try {
        const iterResult = await runIteration({
          harness,
          runAdapter,
          evalAdapter,
          config,
          env,
          state,
          step,
          circuit,
          iteration,
          maxRetries,
          isFirst,
          completedStepSummaries,
          cliOptions,
        });

        state.iterations.push(iterResult);

        // Update scratchpads from BIN output
        const scratchUpdates = parseScratchpadUpdates(
          iterResult.runOutput.stdout,
        );
        Object.assign(state.scratchpad, scratchUpdates);

        // Log iteration
        logIteration(
          logPath,
          iterResult,
          iterResult.expandedRunPrompt,
          iterResult.expandedEvalPrompt,
        );

        totalIterations++;

        // No EVAL — fire and forget
        if (!step.eval) {
          state.success = true;
          break;
        }

        // Check verdict
        if (iterResult.verdict === "SUCCESS") {
          console.log(`  ${c.green}✓ EVAL passed${c.reset}`);
          state.success = true;
          break;
        }

        console.log(
          `  ${c.red}✗ EVAL failed${iteration < maxRetries ? ` ${c.yellow}— retrying` : ` ${c.dim}— retries exhausted`}${c.reset}`,
        );
      } catch (err) {
        if (err instanceof AuthError) {
          console.error(`\n  ${c.red}${c.bold}AUTH ERROR:${c.reset} ${c.red}${err.message}${c.reset}`);
          circuitSuccess = false;
          break;
        }
        if (err instanceof RateLimitError) {
          console.log(`  ${c.yellow}Rate limited — waiting 10s...${c.reset}`);
          await sleep(10000);
          iteration--; // don't count this as an attempt
          continue;
        }
        if (err instanceof BinTimeoutError) {
          console.log(`  ${c.yellow}BIN timed out — counting as failure${c.reset}`);
          // Continue to next retry
          continue;
        }
        // Unknown error
        console.error(`  ${c.red}Error: ${err instanceof Error ? err.message : err}${c.reset}`);
        if (cliOptions.debug) {
          console.error(err);
        }
      }
    }

    logStepEnd(logPath, stepIndex, state.success, state.iterations.length);

    if (state.success) {
      stepsCompleted++;
      completedStepSummaries.push(
        `Step ${stepIndex + 1} (${step.run.prompt.slice(0, 60)}): COMPLETED in ${state.iterations.length} iteration(s)`,
      );
      console.log(`\n  ${c.green}${c.bold}Step ${stepIndex + 1} completed successfully${c.reset}`);
    } else {
      console.log(`\n  ${c.red}${c.bold}Step ${stepIndex + 1} FAILED${c.reset} ${c.dim}— circuit aborted${c.reset}`);
      circuitSuccess = false;
      break;
    }
  }

  const durationMs = Date.now() - startTime;
  logCircuitEnd(
    logPath,
    circuitSuccess,
    stepsCompleted,
    circuit.steps.length,
    totalIterations,
    durationMs,
  );

  const summaryColor = circuitSuccess ? c.green : c.red;
  console.log(`\n${summaryColor}${"═".repeat(60)}${c.reset}`);
  console.log(
    circuitSuccess
      ? `${c.bold}${c.green}Circuit PASSED${c.reset} ${c.dim}— ${stepsCompleted} step(s) completed${c.reset}`
      : `${c.bold}${c.red}Circuit FAILED${c.reset} ${c.dim}— ${stepsCompleted}/${circuit.steps.length} steps completed${c.reset}`,
  );
  console.log(`${c.dim}Iterations: ${totalIterations} │ Duration: ${(durationMs / 1000).toFixed(1)}s${c.reset}`);
  console.log(`${c.dim}Log: ${logPath}${c.reset}`);
  console.log(`${summaryColor}${"═".repeat(60)}${c.reset}`);

  return circuitSuccess;
}

// ── Internal ──

interface RunIterationOpts {
  harness: Harness;
  runAdapter: import("./types.ts").SessionAdapter;
  evalAdapter: import("./types.ts").SessionAdapter;
  config: CircuitConfig;
  env: EnvironmentInfo;
  state: StepState;
  step: import("./types.ts").Step;
  circuit: import("./types.ts").CircuitBlock;
  iteration: number;
  maxRetries: number;
  isFirst: boolean;
  completedStepSummaries: string[];
  cliOptions: CLIOptions;
}

async function runIteration(opts: RunIterationOpts): Promise<IterationResult> {
  const {
    harness,
    runAdapter,
    evalAdapter,
    config,
    env,
    state,
    step,
    circuit,
    iteration,
    maxRetries,
    isFirst,
    completedStepSummaries,
    cliOptions,
  } = opts;

  const iterStart = Date.now();

  // Get working directory state
  const workingDirSnapshot = isFirst ? getDirectorySnapshot(config.dir) : "";
  const workingDirDiff =
    !isFirst ? getDirectoryDiff(config.dir) : "";

  // Get eval feedback from previous iteration
  const lastIteration =
    state.iterations.length > 0
      ? state.iterations[state.iterations.length - 1]!
      : null;
  const evalFeedback = lastIteration?.feedback ?? null;

  // Build eval history for EVAL expansion
  const evalHistory =
    state.iterations.length > 0
      ? state.iterations
          .map(
            (it) =>
              `Iteration ${it.iteration + 1}: ${it.verdict ?? "NO_EVAL"} — ${it.feedback.slice(0, 100)}`,
          )
          .join("\n")
      : null;

  // ── Expand RUN prompt ──
  const runContext: ExpansionContext = {
    role: "run",
    goal: circuit.name,
    userPrompt: step.run.prompt,
    iteration,
    maxRetries,
    isFirst,
    evalFeedback,
    scratchpad: { ...state.scratchpad },
    engineerScratchpad: { ...state.engineerScratchpad },
    workingDirSnapshot,
    workingDirDiff,
    environment: env,
    stepContext:
      completedStepSummaries.length > 0
        ? completedStepSummaries.join("\n")
        : null,
    evalHistory: null,
    executionHistory: state.iterations,
  };

  const isDebug = cliOptions.debug || cliOptions.raw;
  const isVerbose = cliOptions.verbose || isDebug;
  const streamLevel = cliOptions.raw ? "raw" as const
    : cliOptions.debug ? "debug" as const
    : cliOptions.verbose ? "verbose" as const
    : null;

  // ── Expand RUN prompt ──
  if (isDebug) {
    console.log(`\n  ${c.magenta}┌─ USER PROMPT (RUN) ──${c.reset}`);
    console.log(`  ${c.magenta}│${c.reset} ${step.run.prompt}`);
    console.log(`  ${c.magenta}└──${c.reset}`);
  }
  console.log(`  ${c.dim}Expanding RUN prompt via ${config.promptEngineerModel}...${c.reset}`);
  const runExpansion = await harness.expandRun(runContext);

  // Update engineer scratchpad
  Object.assign(state.engineerScratchpad, runExpansion.engineerScratchpadUpdates);

  if (isDebug) {
    console.log(`\n  ${c.blue}┌─ EXPANDED PROMPT ${c.dim}(${runExpansion.expandedPrompt.length} chars)${c.reset} ${c.blue}──${c.reset}`);
    console.log(indent(runExpansion.expandedPrompt, `  ${c.blue}│${c.reset} `));
    console.log(`  ${c.blue}└──${c.reset}`);
  } else if (isVerbose) {
    console.log(`  ${c.dim}Expanded RUN prompt (${runExpansion.expandedPrompt.length} chars)${c.reset}`);
  }
  if (cliOptions.raw) {
    rawLog("RAW ENGINEER RESPONSE (RUN)", runExpansion.rawResponse);
  }

  // ── Execute RUN_BIN ──
  const runCommand = runAdapter.buildCommand(
    config.runBin,
    runExpansion.expandedPrompt,
    state.runSessionId,
    isFirst,
    config.dir,
  );
  if (isDebug) {
    const displayCmd = runCommand.map((a, i) =>
      i === runCommand.length - 1 && a.length > 200 ? `"${a.slice(0, 100)}..."` : a
    ).join(" ");
    console.log(`\n  ${c.gray}┌─ BIN COMMAND ──${c.reset}`);
    console.log(`  ${c.gray}│${c.reset} ${c.dim}${displayCmd}${c.reset}`);
    console.log(`  ${c.gray}└──${c.reset}`);
  }

  console.log(`  ${c.cyan}Running ${config.runBin.split(" ")[0]}...${c.reset}`);
  const runOutput = await runBin({
    adapter: runAdapter,
    binCommand: config.runBin,
    prompt: runExpansion.expandedPrompt,
    sessionId: state.runSessionId,
    isFirst,
    workingDir: config.dir,
    timeoutMs: config.timeout * 1000,
    onStdout: streamLevel
      ? makeStreamHandler(runAdapter, streamLevel)
      : undefined,
    onStderr: isDebug ? (c) => process.stderr.write(c) : undefined,
  });

  const runExitColor = runOutput.exitCode === 0 ? c.green : c.red;
  console.log(
    `\n  ${runExitColor}RUN completed${c.reset} ${c.dim}(exit ${runOutput.exitCode}, ${(runOutput.durationMs / 1000).toFixed(1)}s)${c.reset}`,
  );
  if (cliOptions.raw) {
    rawLog("RUN STDOUT", runOutput.stdout);
    rawLog("RUN STDERR", runOutput.stderr);
  }

  // ── If no EVAL, we're done ──
  if (!step.eval) {
    return {
      stepIndex: state.stepIndex,
      iteration,
      maxRetries,
      expandedRunPrompt: runExpansion.expandedPrompt,
      runOutput,
      expandedEvalPrompt: null,
      evalOutput: null,
      verdict: null,
      feedback: "",
      scratchpad: { ...state.scratchpad },
      engineerScratchpad: { ...state.engineerScratchpad },
      workingDirDiff,
      durationMs: Date.now() - iterStart,
      timestamp: new Date().toISOString(),
    };
  }

  // ── Expand EVAL prompt ──
  const evalDiff = getDirectoryDiff(config.dir);

  const evalContext: ExpansionContext = {
    role: "eval",
    goal: circuit.name,
    userPrompt: step.eval.prompt,
    iteration,
    maxRetries,
    isFirst,
    evalFeedback: null,
    scratchpad: { ...state.scratchpad },
    engineerScratchpad: { ...state.engineerScratchpad },
    workingDirSnapshot: "",
    workingDirDiff: evalDiff,
    environment: env,
    stepContext:
      completedStepSummaries.length > 0
        ? completedStepSummaries.join("\n")
        : null,
    evalHistory,
    executionHistory: state.iterations,
  };

  if (isDebug) {
    console.log(`\n  ${c.magenta}┌─ USER PROMPT (EVAL) ──${c.reset}`);
    console.log(`  ${c.magenta}│${c.reset} ${step.eval.prompt}`);
    console.log(`  ${c.magenta}└──${c.reset}`);
  }
  console.log(`  ${c.dim}Expanding EVAL prompt via ${config.promptEngineerModel}...${c.reset}`);
  const evalExpansion = await harness.expandEval(evalContext);
  Object.assign(state.engineerScratchpad, evalExpansion.engineerScratchpadUpdates);

  if (isDebug) {
    console.log(`\n  ${c.blue}┌─ EXPANDED EVAL PROMPT ${c.dim}(${evalExpansion.expandedPrompt.length} chars)${c.reset} ${c.blue}──${c.reset}`);
    console.log(indent(evalExpansion.expandedPrompt, `  ${c.blue}│${c.reset} `));
    console.log(`  ${c.blue}└──${c.reset}`);
  } else if (isVerbose) {
    console.log(`  ${c.dim}Expanded EVAL prompt (${evalExpansion.expandedPrompt.length} chars)${c.reset}`);
  }
  if (cliOptions.raw) {
    rawLog("RAW ENGINEER RESPONSE (EVAL)", evalExpansion.rawResponse);
  }

  // ── Execute EVAL_BIN ──
  const evalCommand = evalAdapter.buildCommand(
    config.evalBin,
    evalExpansion.expandedPrompt,
    state.evalSessionId,
    isFirst,
    config.dir,
  );
  if (isDebug) {
    const displayCmd = evalCommand.map((a, i) =>
      i === evalCommand.length - 1 && a.length > 200 ? `"${a.slice(0, 100)}..."` : a
    ).join(" ");
    console.log(`\n  ${c.gray}┌─ EVAL BIN COMMAND ──${c.reset}`);
    console.log(`  ${c.gray}│${c.reset} ${c.dim}${displayCmd}${c.reset}`);
    console.log(`  ${c.gray}└──${c.reset}`);
  }

  console.log(`  ${c.cyan}Running EVAL...${c.reset}`);
  const evalOutput = await runBin({
    adapter: evalAdapter,
    binCommand: config.evalBin,
    prompt: evalExpansion.expandedPrompt,
    sessionId: state.evalSessionId,
    isFirst,
    workingDir: config.dir,
    timeoutMs: config.timeout * 1000,
    onStdout: streamLevel
      ? makeStreamHandler(evalAdapter, streamLevel)
      : undefined,
    onStderr: isDebug ? (c) => process.stderr.write(c) : undefined,
  });

  if (cliOptions.raw) {
    rawLog("EVAL STDOUT", evalOutput.stdout);
    rawLog("EVAL STDERR", evalOutput.stderr);
  }

  // Parse verdict
  const { success, feedback } = parseVerdict(evalOutput.stdout);
  const verdict = success ? "SUCCESS" : "FAILURE";

  if (isDebug) {
    const verdictColor = verdict === "SUCCESS" ? c.green : c.red;
    console.log(`\n  ${verdictColor}┌─ VERDICT: ${verdict} ──${c.reset}`);
    if (feedback) {
      console.log(indent(feedback.slice(0, 500), `  ${verdictColor}│${c.reset} `));
    }
    console.log(`  ${verdictColor}└──${c.reset}`);
  }
  if (cliOptions.raw) {
    rawLog("VERDICT", verdict);
    rawLog("FEEDBACK", feedback);
  }

  return {
    stepIndex: state.stepIndex,
    iteration,
    maxRetries,
    expandedRunPrompt: runExpansion.expandedPrompt,
    runOutput,
    expandedEvalPrompt: evalExpansion.expandedPrompt,
    evalOutput,
    verdict,
    feedback,
    scratchpad: { ...state.scratchpad },
    engineerScratchpad: { ...state.engineerScratchpad },
    workingDirDiff: evalDiff,
    durationMs: Date.now() - iterStart,
    timestamp: new Date().toISOString(),
  };
}

function getEnvironment(config: CircuitConfig): EnvironmentInfo {
  return {
    os: `${platform()} ${release()}`,
    shell: process.env.SHELL ?? "/bin/sh",
    cwd: config.dir,
    date: new Date().toISOString(),
  };
}

function getDirectorySnapshot(dir: string): string {
  try {
    return execSync("tree -L 2 --noreport 2>/dev/null || ls -la", {
      cwd: dir,
      encoding: "utf-8",
      timeout: 5000,
    }).slice(0, 4000);
  } catch {
    return "(could not snapshot directory)";
  }
}

function getDirectoryDiff(dir: string): string {
  if (!existsSync(dir)) return "";
  try {
    // Try git diff first
    const diff = execSync("git diff --stat 2>/dev/null", {
      cwd: dir,
      encoding: "utf-8",
      timeout: 5000,
    });
    if (diff.trim()) {
      const fullDiff = execSync("git diff 2>/dev/null", {
        cwd: dir,
        encoding: "utf-8",
        timeout: 5000,
      });
      return fullDiff.slice(0, 8000);
    }
    return "";
  } catch {
    return "";
  }
}

function indent(text: string, prefix: string): string {
  return text.split("\n").map((l) => `${prefix}${l}`).join("\n");
}

function sanitizeId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40);
}

/**
 * Create a stdout handler that parses stream-json for live display.
 *   "raw"     — dump raw JSON lines (everything)
 *   "debug"   — parsed: text + tool calls + tool results + summary
 *   "verbose" — parsed: main text content only
 */
function makeStreamHandler(
  adapter: import("./types.ts").SessionAdapter,
  level: "raw" | "debug" | "verbose",
): (chunk: string) => void {
  if (level === "raw" || !adapter.parseStreamChunk) {
    return (c) => process.stdout.write(c);
  }
  const parseLevel = level === "debug" ? "debug" : "verbose";
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const display = adapter.parseStreamChunk!(line, parseLevel);
      if (display) process.stdout.write(display);
    }
  };
}

function rawLog(label: string, data: string): void {
  console.log(`\n${c.gray}┌── RAW: ${label} ──${c.reset}`);
  console.log(`${c.gray}${data}${c.reset}`);
  console.log(`${c.gray}└── END: ${label} ──${c.reset}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
