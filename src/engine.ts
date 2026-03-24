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

/**
 * Execute a parsed circuit.
 */
export async function executeCircuit(
  ast: CircuitAST,
  config: CircuitConfig,
  cliOptions: CLIOptions,
): Promise<boolean> {
  const circuit = ast.circuits[0]!;
  const client = new OpenRouterClient(config.apiKey, config.apiUrl);
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
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Step ${stepIndex + 1}/${circuit.steps.length}: RUN`);
    console.log(`${"─".repeat(60)}`);

    const state: StepState = {
      stepIndex,
      run: step.run,
      eval: step.eval,
      runSessionId: `circuit-${sanitizeId(circuit.name)}-step-${stepIndex}-run`,
      evalSessionId: `circuit-${sanitizeId(circuit.name)}-step-${stepIndex}-eval`,
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
        console.log(`\n  Retry ${iteration}/${maxRetries}...`);
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
          console.log(`  ✓ EVAL passed`);
          state.success = true;
          break;
        }

        console.log(
          `  ✗ EVAL failed${iteration < maxRetries ? " — retrying" : " — retries exhausted"}`,
        );
      } catch (err) {
        if (err instanceof AuthError) {
          console.error(`\n  AUTH ERROR: ${err.message}`);
          circuitSuccess = false;
          break;
        }
        if (err instanceof RateLimitError) {
          console.log(`  Rate limited — waiting 10s...`);
          await sleep(10000);
          iteration--; // don't count this as an attempt
          continue;
        }
        if (err instanceof BinTimeoutError) {
          console.log(`  BIN timed out — counting as failure`);
          // Continue to next retry
          continue;
        }
        // Unknown error
        console.error(`  Error: ${err instanceof Error ? err.message : err}`);
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
      console.log(`\n  Step ${stepIndex + 1} completed successfully`);
    } else {
      console.log(`\n  Step ${stepIndex + 1} FAILED — circuit aborted`);
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

  console.log(`\n${"═".repeat(60)}`);
  console.log(
    circuitSuccess
      ? `Circuit PASSED — ${stepsCompleted} step(s) completed`
      : `Circuit FAILED — ${stepsCompleted}/${circuit.steps.length} steps completed`,
  );
  console.log(`Total iterations: ${totalIterations}`);
  console.log(`Duration: ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`Log: ${logPath}`);
  console.log(`${"═".repeat(60)}`);

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

  console.log(`  Expanding RUN prompt...`);
  const runExpansion = await harness.expandRun(runContext);

  // Update engineer scratchpad
  Object.assign(state.engineerScratchpad, runExpansion.engineerScratchpadUpdates);

  if (cliOptions.verbose) {
    console.log(`  Expanded RUN prompt (${runExpansion.expandedPrompt.length} chars)`);
  }

  // ── Execute RUN_BIN ──
  console.log(`  Running ${config.runBin.split(" ")[0]}...`);
  const runOutput = await runBin({
    adapter: runAdapter,
    binCommand: config.runBin,
    prompt: runExpansion.expandedPrompt,
    sessionId: state.runSessionId,
    isFirst,
    workingDir: config.dir,
    timeoutMs: config.timeout * 1000,
    onStdout: cliOptions.verbose ? (c) => process.stdout.write(c) : undefined,
    onStderr: cliOptions.debug ? (c) => process.stderr.write(c) : undefined,
  });

  console.log(
    `  RUN completed (exit ${runOutput.exitCode}, ${(runOutput.durationMs / 1000).toFixed(1)}s)`,
  );

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

  console.log(`  Expanding EVAL prompt...`);
  const evalExpansion = await harness.expandEval(evalContext);
  Object.assign(state.engineerScratchpad, evalExpansion.engineerScratchpadUpdates);

  if (cliOptions.verbose) {
    console.log(`  Expanded EVAL prompt (${evalExpansion.expandedPrompt.length} chars)`);
  }

  // ── Execute EVAL_BIN ──
  console.log(`  Running EVAL...`);
  const evalOutput = await runBin({
    adapter: evalAdapter,
    binCommand: config.evalBin,
    prompt: evalExpansion.expandedPrompt,
    sessionId: state.evalSessionId,
    isFirst,
    workingDir: config.dir,
    timeoutMs: config.timeout * 1000,
    onStdout: cliOptions.verbose ? (c) => process.stdout.write(c) : undefined,
    onStderr: cliOptions.debug ? (c) => process.stderr.write(c) : undefined,
  });

  // Parse verdict
  const { success, feedback } = parseVerdict(evalOutput.stdout);
  const verdict = success ? "SUCCESS" : "FAILURE";

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

function sanitizeId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
