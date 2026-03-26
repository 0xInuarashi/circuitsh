import { execSync, spawn as spawnProcess } from "child_process";
import { createInterface } from "readline";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { platform, release, cpus, totalmem, freemem } from "os";
import type {
  CircuitAST,
  CircuitConfig,
  CLIOptions,
  EnvironmentInfo,
  ExpansionContext,
  ExpansionResult,
  IterationResult,
  StepState,
} from "./types.ts";
import { OpenRouterClient } from "./client.ts";
import { Harness, diagnoseTimeout } from "./harness.ts";
import { detectAdapter } from "./session.ts";
import { runBin } from "./runner.ts";
import { parseVerdict, parseScratchpadUpdates, parseRequestInput } from "./verdict.ts";
import {
  logCircuitStart,
  logCircuitEnd,
  logStepStart,
  logStepEnd,
  logIteration,
  makeLogPaths,
  writeRawStreamLog,
  writeSessionRecoveryDoc,
  formatRecoveryContext,
  writeManifest,
  writeEngineerCallLog,
  appendApiTrafficLog,
} from "./storage.ts";
import type { SessionRecoveryDoc } from "./types.ts";
import { join } from "path";
import { AuthError, BinNotFoundError, BinTimeoutError, RateLimitError } from "./errors.ts";

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
  // Ensure working directory exists
  if (!existsSync(config.dir)) {
    mkdirSync(config.dir, { recursive: true });
    console.log(`Created directory: ${config.dir}`);
  }

  // Pre-flight: validate all bins exist before execution
  validateBins(circuit, config);

  const { jsonlPath: logPath, runDir } = makeLogPaths(circuit.name, config.logDir);

  // Disk logger — always active, writes all API traffic to engineer/api_traffic.jsonl
  const diskLogger = (label: string, data: string) => {
    appendApiTrafficLog(runDir, label, data);
  };

  const client = new OpenRouterClient(config.apiKey, config.apiUrl, rawLogger, diskLogger);
  const harness = new Harness(client, config.promptEngineerModel);
  const env = getEnvironment(config);

  // Engineer call logger — tracks step/iteration context for file naming
  let engineerLogContext = { stepIndex: 0, iteration: 0 };
  harness.setLogger((log) => {
    writeEngineerCallLog(runDir, {
      callType: log.callType,
      stepIndex: engineerLogContext.stepIndex,
      iteration: engineerLogContext.iteration,
      timestamp: new Date().toISOString(),
      durationMs: log.durationMs,
      model: log.model,
      temperature: log.temperature,
      messages: log.messages,
      rawOutput: log.rawOutput,
      parsedResult: log.parsedResult,
      formatRetried: log.formatRetried,
    });
  });

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

    // Resolve per-step bins: WITH > default
    const stepRunBin = resolveBin(step.run.bin ?? config.runBin, config.aliases);
    const stepEvalBin = step.eval
      ? resolveBin(step.eval.bin ?? config.evalBin, config.aliases)
      : config.evalBin;
    const runAdapter = detectAdapter(stepRunBin);
    const evalAdapter = detectAdapter(stepEvalBin);

    // Seed scratchpad with CIRCUIT_CONTEXT entries
    const initialScratchpad: Record<string, string> = {};
    if (ast.circuitContext.length > 0) {
      for (let ci = 0; ci < ast.circuitContext.length; ci++) {
        initialScratchpad[`circuit_context_${ci + 1}`] = ast.circuitContext[ci]!;
      }
    }

    const state: StepState = {
      stepIndex,
      run: step.run,
      eval: step.eval,
      runSessionId: crypto.randomUUID(),
      evalSessionId: crypto.randomUUID(),
      runSessionCreated: false,
      evalSessionCreated: false,
      scratchpad: initialScratchpad,
      engineerScratchpad: {},
      iterations: [],
      success: false,
      cachedRunExpansion: null,
      recoveryContext: null,
    };

    const maxRetries = step.eval?.retry ?? 0;
    const maxAttempts = maxRetries + 1;

    for (let iteration = 0; iteration < maxAttempts; iteration++) {
      engineerLogContext = { stepIndex, iteration };
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
          stepRunBin,
          stepEvalBin,
          runDir,
        });

        state.iterations.push(iterResult);

        // Update scratchpads from BIN output
        const scratchUpdates = parseScratchpadUpdates(
          iterResult.runOutput.stdout,
        );
        Object.assign(state.scratchpad, scratchUpdates);

        // Write raw stream logs
        const runRawLogRef = writeRawStreamLog(runDir, {
          role: "run",
          stepIndex: state.stepIndex,
          iteration,
          stdout: iterResult.runOutput.rawStdout,
          stderr: iterResult.runOutput.stderr,
        });
        writeSessionRecoveryDoc(runDir, {
          circuitName: circuit.name,
          role: "run",
          stepIndex: state.stepIndex,
          iteration,
          sessionId: state.runSessionId,
          rawStdout: iterResult.runOutput.rawStdout,
        });

        let evalRawLogRef: string | null = null;
        if (iterResult.evalOutput) {
          evalRawLogRef = writeRawStreamLog(runDir, {
            role: "eval",
            stepIndex: state.stepIndex,
            iteration,
            stdout: iterResult.evalOutput.rawStdout,
            stderr: iterResult.evalOutput.stderr,
          });
          writeSessionRecoveryDoc(runDir, {
            circuitName: circuit.name,
            role: "eval",
            stepIndex: state.stepIndex,
            iteration,
            sessionId: state.evalSessionId,
            rawStdout: iterResult.evalOutput.rawStdout,
          });
        }

        // Log iteration to JSONL
        logIteration(
          logPath,
          iterResult,
          iterResult.expandedRunPrompt,
          iterResult.expandedEvalPrompt,
          runRawLogRef,
          evalRawLogRef,
        );

        totalIterations++;

        // Iteration completed — clear RUN expansion cache (next retry needs fresh expansion with new feedback)
        state.cachedRunExpansion = null;

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
          console.log(`  ${c.yellow}BIN timed out after ${(err.timeoutMs / 1000).toFixed(0)}s${c.reset}`);

          // Write partial raw logs from the timed-out process
          if (err.partialRawStdout || err.partialStderr) {
            writeRawStreamLog(runDir, {
              role: "run",
              stepIndex: state.stepIndex,
              iteration,
              stdout: err.partialRawStdout,
              stderr: err.partialStderr,
            });
            if (err.partialRawStdout) {
              writeSessionRecoveryDoc(runDir, {
                circuitName: circuit.name,
                role: "run",
                stepIndex: state.stepIndex,
                iteration,
                sessionId: state.runSessionId,
                rawStdout: err.partialRawStdout,
              });
            }
          }

          console.log(`  ${c.dim}Consulting prompt engineer...${c.reset}`);

          const diagnosis = await diagnoseTimeout(client, config.promptEngineerModel, {
            binCommand: stepRunBin,
            timeoutMs: err.timeoutMs,
            partialStdout: err.partialStdout,
            partialStderr: err.partialStderr,
            role: "run",
            iteration,
            maxRetries,
            goal: circuit.name,
            userPrompt: step.run.prompt,
          }, (log) => {
            writeEngineerCallLog(runDir, {
              callType: "timeout_diagnosis",
              stepIndex: state.stepIndex,
              iteration,
              timestamp: new Date().toISOString(),
              durationMs: log.durationMs,
              model: log.model,
              temperature: log.temperature,
              messages: log.messages,
              rawOutput: log.rawOutput,
              parsedResult: log.parsedResult,
              formatRetried: false,
            });
          });

          console.log(`  ${c.cyan}Engineer decision: ${c.bold}${diagnosis.action}${c.reset}`);
          console.log(`  ${c.dim}${diagnosis.reason}${c.reset}`);

          if (diagnosis.action === "abort") {
            console.log(`  ${c.red}Aborting step per engineer recommendation${c.reset}`);
            break;
          }

          if (diagnosis.action === "increase_timeout" && diagnosis.suggestedTimeoutMs) {
            const newTimeout = Math.min(diagnosis.suggestedTimeoutMs, config.timeout * 1000 * 10 || 3600000);
            config.timeout = newTimeout / 1000;
            console.log(`  ${c.yellow}Timeout increased to ${config.timeout}s${c.reset}`);
          }

          if (diagnosis.action === "resume") {
            // Don't count as a retry — resume continues the session
            console.log(`  ${c.cyan}Resuming session...${c.reset}`);
            iteration--;
          }
          // BIN may have created sessions before being killed — mark as created
          // so next retry uses --resume to preserve context
          state.runSessionCreated = true;
          state.evalSessionCreated = true;

          // "retry" falls through to the next iteration naturally
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

  writeManifest(runDir, {
    circuitName: circuit.name,
    jsonlPath: logPath,
    startedAt: new Date(startTime).toISOString(),
    endedAt: new Date().toISOString(),
    success: circuitSuccess,
    totalSteps: circuit.steps.length,
    totalIterations,
    durationMs,
  });

  const summaryColor = circuitSuccess ? c.green : c.red;
  console.log(`\n${summaryColor}${"═".repeat(60)}${c.reset}`);
  console.log(
    circuitSuccess
      ? `${c.bold}${c.green}Circuit PASSED${c.reset} ${c.dim}— ${stepsCompleted} step(s) completed${c.reset}`
      : `${c.bold}${c.red}Circuit FAILED${c.reset} ${c.dim}— ${stepsCompleted}/${circuit.steps.length} steps completed${c.reset}`,
  );
  console.log(`${c.dim}Iterations: ${totalIterations} │ Duration: ${(durationMs / 1000).toFixed(1)}s${c.reset}`);
  console.log(`${c.dim}Log: ${logPath}${c.reset}`);
  console.log(`${c.dim}Logs: ${runDir}${c.reset}`);
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
  stepRunBin: string;
  stepEvalBin: string;
  runDir: string;
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
    stepRunBin,
    stepEvalBin,
    runDir,
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
    allowRequests: step.run.allowRequests,
  };

  const isDebug = cliOptions.debug || cliOptions.raw;
  const isVerbose = cliOptions.verbose || isDebug;
  const streamLevel = cliOptions.raw ? "raw" as const
    : cliOptions.debug ? "debug" as const
    : cliOptions.verbose ? "verbose" as const
    : null;

  // ── Expand RUN prompt (or skip for raw) ──
  let runExpansion: ExpansionResult;
  const runExpMode = step.run.expansion;

  if (runExpMode === "raw") {
    // RAW_RUN — no expansion, pass prompt directly
    runExpansion = {
      expandedPrompt: step.run.prompt,
      engineerScratchpadUpdates: {},
      rawResponse: "",
    };
    console.log(`  ${c.dim}RAW_RUN — skipping expansion (${step.run.prompt.length} chars)${c.reset}`);
  } else if (state.cachedRunExpansion) {
    runExpansion = state.cachedRunExpansion;
    state.cachedRunExpansion = null;
    console.log(`  ${c.dim}Reusing cached RUN expansion (${runExpansion.expandedPrompt.length} chars)${c.reset}`);
  } else {
    // auto or custom expansion — may loop if request_input is triggered
    runExpansion = await expandWithRequestLoop(
      harness,
      runContext,
      step.run.expansion,
      step.run.allowRequests,
      state,
      config,
      cliOptions,
      isDebug,
      isVerbose,
      step.run.prompt,
      { notify: step.run.notify, requestTimeout: step.run.requestTimeout, circuitName: circuit.name, stepIndex: state.stepIndex },
    );
  }

  // Cache expansion in case BIN fails and we need to retry
  state.cachedRunExpansion = runExpansion;

  // Update engineer scratchpad
  Object.assign(state.engineerScratchpad, runExpansion.engineerScratchpadUpdates);

  // ── Execute RUN_BIN ──
  // Inject recovery context if we had to abandon a previous session
  let runPrompt = runExpansion.expandedPrompt;
  if (state.recoveryContext && !state.runSessionCreated) {
    runPrompt = state.recoveryContext + "\n\n" + runPrompt;
    state.recoveryContext = null;
    console.log(`  ${c.cyan}Injected session recovery context into prompt${c.reset}`);
  }

  const runIsNewSession = !state.runSessionCreated;
  const runCommand = runAdapter.buildCommand(
    stepRunBin,
    runPrompt,
    state.runSessionId,
    runIsNewSession,
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

  console.log(`  ${c.cyan}Running ${stepRunBin.split(" ")[0]}...${c.reset}`);
  const runOutput = await runBin({
    adapter: runAdapter,
    binCommand: stepRunBin,
    prompt: runPrompt,
    sessionId: state.runSessionId,
    isFirst: runIsNewSession,
    workingDir: config.dir,
    timeoutMs: config.timeout * 1000,
    onStdout: streamLevel
      ? makeStreamHandler(runAdapter, streamLevel)
      : undefined,
    onStderr: isDebug ? (c) => process.stderr.write(c) : undefined,
  });

  // Track session creation — if BIN produced output, session exists
  if (runOutput.exitCode !== null && runOutput.rawStdout.length > 0) {
    state.runSessionCreated = true;
  }
  // Session recovery: resume first, reset only as last resort
  if (runOutput.rawStdout.includes('"subtype":"error_during_execution"') || runOutput.rawStdout.includes('"is_error":true')) {
    if (!runIsNewSession) {
      // --resume failed — session is corrupted, load recovery context and start fresh
      console.log(`  ${c.yellow}Session resume failed — loading recovery context for fresh session${c.reset}`);
      state.recoveryContext = loadRecoveryContext(runDir, state.stepIndex, "run");
      state.runSessionCreated = false;
      state.runSessionId = crypto.randomUUID();
    }
  } else if (runOutput.exitCode !== 0 && runOutput.rawStdout.length === 0) {
    // CLI failed before producing output — session may exist, try resume next
    console.log(`  ${c.yellow}BIN failed before producing output — will try resuming session${c.reset}`);
    state.runSessionCreated = true;
  }

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

  // ── EVAL: no expansion — prompt goes straight to BIN ──
  const evalExpMode = step.eval.expansion;
  const evalExpansion: ExpansionResult = {
    expandedPrompt: step.eval.prompt,
    engineerScratchpadUpdates: {},
    rawResponse: "",
  };
  console.log(
    `  ${c.dim}${evalExpMode === "raw" ? "RAW_" : ""}EVAL — no expansion (${step.eval.prompt.length} chars)${c.reset}`,
  );

  // ── Execute EVAL_BIN ──
  // Inject recovery context if we had to abandon a previous session
  let evalPrompt = evalExpansion.expandedPrompt;
  if (state.recoveryContext && !state.evalSessionCreated) {
    evalPrompt = state.recoveryContext + "\n\n" + evalPrompt;
    state.recoveryContext = null;
    console.log(`  ${c.cyan}Injected EVAL session recovery context into prompt${c.reset}`);
  }

  const evalIsNewSession = !state.evalSessionCreated;
  const evalCommand = evalAdapter.buildCommand(
    stepEvalBin,
    evalPrompt,
    state.evalSessionId,
    evalIsNewSession,
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
    binCommand: stepEvalBin,
    prompt: evalPrompt,
    sessionId: state.evalSessionId,
    isFirst: evalIsNewSession,
    workingDir: config.dir,
    timeoutMs: config.timeout * 1000,
    onStdout: streamLevel
      ? makeStreamHandler(evalAdapter, streamLevel)
      : undefined,
    onStderr: isDebug ? (c) => process.stderr.write(c) : undefined,
  });

  // Track session creation
  if (evalOutput.exitCode !== null && evalOutput.rawStdout.length > 0) {
    state.evalSessionCreated = true;
  }
  // Session recovery: resume first, reset only as last resort
  if (evalOutput.rawStdout.includes('"subtype":"error_during_execution"') || evalOutput.rawStdout.includes('"is_error":true')) {
    if (!evalIsNewSession) {
      // --resume failed — session is corrupted, load recovery context and start fresh
      console.log(`  ${c.yellow}EVAL session resume failed — loading recovery context for fresh session${c.reset}`);
      state.recoveryContext = loadRecoveryContext(runDir, state.stepIndex, "eval");
      state.evalSessionCreated = false;
      state.evalSessionId = crypto.randomUUID();
    }
  } else if (evalOutput.exitCode !== 0 && evalOutput.rawStdout.length === 0) {
    // CLI failed before producing output — session may exist, try resume next
    console.log(`  ${c.yellow}EVAL BIN failed before producing output — will try resuming session${c.reset}`);
    state.evalSessionCreated = true;
  }

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
    workingDirDiff,
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
    machine: getMachineInfo(),
  };
}

function getMachineInfo(): import("./types.ts").MachineInfo {
  const cpuList = cpus();
  const cpuModel = cpuList[0]?.model ?? "unknown";
  const cpuCores = cpuList.length;
  const ramTotalMB = Math.round(totalmem() / 1024 / 1024);
  const ramFreeMB = Math.round(freemem() / 1024 / 1024);

  // Disk: df on the root partition
  let diskTotalGB = 0;
  let diskFreeGB = 0;
  try {
    const df = execSync("df -BG / | tail -1", { encoding: "utf-8", timeout: 3000 });
    const parts = df.trim().split(/\s+/);
    diskTotalGB = parseInt(parts[1] ?? "0", 10);
    diskFreeGB = parseInt(parts[3] ?? "0", 10);
  } catch { /* non-fatal */ }

  // GPU: nvidia-smi first, then lspci fallback
  let gpu: string | null = null;
  try {
    gpu = execSync("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null", {
      encoding: "utf-8",
      timeout: 3000,
    }).trim() || null;
  } catch {
    try {
      const lspci = execSync("lspci 2>/dev/null | grep -i 'vga\\|3d\\|display'", {
        encoding: "utf-8",
        timeout: 3000,
      }).trim();
      if (lspci) gpu = lspci.split("\n")[0]!.replace(/^[^ ]+ /, "");
    } catch { /* no GPU */ }
  }

  return { cpuModel, cpuCores, ramTotalMB, ramFreeMB, diskTotalGB, diskFreeGB, gpu };
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

/**
 * Expand a RUN prompt with request_input loop support.
 * If the prompt engineer emits <request_input> and the step has ALLOW_REQUEST conditions,
 * prompt the user, store input in scratchpad, and re-expand.
 */
async function expandWithRequestLoop(
  harness: Harness,
  context: ExpansionContext,
  expansionMode: import("./types.ts").ExpansionMode,
  allowRequests: string[] | undefined,
  state: StepState,
  config: CircuitConfig,
  cliOptions: CLIOptions,
  isDebug: boolean,
  isVerbose: boolean,
  userPrompt: string,
  requestOpts?: { notify?: string; requestTimeout?: number; circuitName?: string; stepIndex?: number },
): Promise<ExpansionResult> {
  const expandOpts = typeof expansionMode === "object"
    ? { modelOverride: expansionMode.model, focus: expansionMode.focus }
    : undefined;
  const expandModel = expandOpts?.modelOverride ?? config.promptEngineerModel;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (isDebug) {
      console.log(`\n  ${c.magenta}┌─ USER PROMPT (RUN) ──${c.reset}`);
      console.log(`  ${c.magenta}│${c.reset} ${userPrompt}`);
      if (expandOpts?.focus) {
        console.log(`  ${c.magenta}│${c.reset} ${c.dim}FOCUS: ${expandOpts.focus.slice(0, 200)}${c.reset}`);
      }
      console.log(`  ${c.magenta}└──${c.reset}`);
    }
    console.log(`  ${c.dim}Expanding RUN prompt via ${expandModel}...${c.reset}`);
    if (isDebug) {
      process.stdout.write(`\n  ${c.blue}┌─ EXPANDED RUN PROMPT ──${c.reset}\n  ${c.blue}│${c.reset} `);
    }

    const expansion = await harness.expandRun(
      context,
      expandOpts,
      isDebug ? (chunk: string) => process.stdout.write(chunk.replaceAll("\n", `\n  ${c.blue}│${c.reset} `)) : undefined,
    );

    if (isDebug) {
      console.log(`\n  ${c.blue}└── ${c.dim}(${expansion.expandedPrompt.length} chars)${c.reset}`);
    } else if (isVerbose) {
      console.log(`  ${c.dim}Expanded RUN prompt (${expansion.expandedPrompt.length} chars)${c.reset}`);
    }
    if (cliOptions.raw) {
      rawLog("RAW ENGINEER RESPONSE (RUN)", expansion.rawResponse);
    }

    // Check for request_input in the engineer's response
    const gotInput = await handleRequestInput(
      expansion.rawResponse,
      allowRequests,
      state.scratchpad,
      requestOpts,
    );

    if (gotInput) {
      // Update context with new scratchpad and re-expand
      context.scratchpad = { ...state.scratchpad };
      console.log(`  ${c.dim}Re-expanding with user input...${c.reset}`);
      continue;
    }

    return expansion;
  }
}

function rawLog(label: string, data: string): void {
  console.log(`\n${c.gray}┌── RAW: ${label} ──${c.reset}`);
  console.log(`${c.gray}${data}${c.reset}`);
  console.log(`${c.gray}└── END: ${label} ──${c.reset}\n`);
}

/**
 * Resolve a bin reference through aliases.
 * If the value matches an alias name, return the alias command; otherwise return as-is.
 */
function resolveBin(bin: string, aliases: Record<string, string>): string {
  return aliases[bin] ?? bin;
}

/**
 * Pre-flight check: validate that all bins referenced in the circuit exist.
 * Checks RUN_BIN, EVAL_BIN, per-step WITH overrides, and NOTIFY commands.
 */
function validateBins(
  circuit: import("./types.ts").CircuitBlock,
  config: CircuitConfig,
): void {
  const bins = new Set<string>();

  // Default bins
  bins.add(resolveBin(config.runBin, config.aliases));
  if (config.evalBin) bins.add(resolveBin(config.evalBin, config.aliases));

  for (const step of circuit.steps) {
    // Per-step WITH overrides
    if (step.run.bin) bins.add(resolveBin(step.run.bin, config.aliases));
    if (step.eval?.bin) bins.add(resolveBin(step.eval.bin, config.aliases));

    // NOTIFY commands
    if (step.run.notify) bins.add(step.run.notify);
    if (step.eval?.notify) bins.add(step.eval.notify);
  }

  const missing: string[] = [];
  for (const bin of bins) {
    const cmd = bin.split(/\s+/)[0]!;
    try {
      execSync(`command -v ${cmd}`, { encoding: "utf-8", timeout: 3000, stdio: "pipe" });
    } catch {
      missing.push(bin);
    }
  }

  if (missing.length > 0) {
    throw new BinNotFoundError(
      missing.length === 1
        ? missing[0]!
        : `Multiple bins not found: ${missing.join(", ")}`,
    );
  }
}

/**
 * Load the most recent session recovery doc and format it as context for prompt injection.
 * Returns null if no recovery doc exists.
 */
function loadRecoveryContext(runDir: string, stepIndex: number, role: "run" | "eval"): string | null {
  const filename = `step${stepIndex}_${role}_session.json`;
  const docPath = join(runDir, "recovery", filename);
  try {
    const raw = readFileSync(docPath, "utf-8");
    const doc = JSON.parse(raw) as SessionRecoveryDoc;
    if (doc.conversationTrace.length === 0) return null;
    return formatRecoveryContext(doc);
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Prompt the user for input via stdin.
 * Returns the user's response, or null if stdin is closed (Ctrl-D) or timeout fires.
 * Timeout is handled internally so the readline interface is always cleaned up.
 */
function promptUser(message: string, timeoutMs?: number): Promise<string | null> {
  return new Promise((resolve) => {
    let resolved = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Write prompt manually — avoid readline echo doubling
    if (message) process.stdout.write(message + "\n");
    process.stdout.write(`${c.cyan}> ${c.reset}`);

    const rl = createInterface({
      input: process.stdin,
      terminal: false, // no readline echo — terminal handles it
    });

    const finish = (value: string | null) => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      rl.close();
      resolve(value);
    };

    if (timeoutMs) {
      timer = setTimeout(() => finish(null), timeoutMs);
    }

    rl.once("line", (line) => finish(line));
    rl.on("close", () => finish(null));
  });
}

/**
 * Handle a request_input from the prompt engineer.
 * Checks ALLOW_REQUEST conditions, fires NOTIFY bin, prompts user with optional timeout.
 * Returns true if input was collected, false if denied, timed out, or aborted.
 */
async function handleRequestInput(
  rawResponse: string,
  allowRequests: string[] | undefined,
  scratchpad: Record<string, string>,
  opts?: { notify?: string; requestTimeout?: number; circuitName?: string; stepIndex?: number },
): Promise<boolean> {
  const request = parseRequestInput(rawResponse);
  if (!request) return false;
  if (!allowRequests || allowRequests.length === 0) return false;

  console.log(`\n  ${c.yellow}${c.bold}INPUT REQUESTED${c.reset}`);
  console.log(`  ${c.dim}Reason: ${request.reason}${c.reset}`);
  console.log(`  ${c.white}${request.message}${c.reset}`);

  // Fire NOTIFY bin (fire-and-forget)
  if (opts?.notify) {
    fireNotify(opts.notify, {
      reason: request.reason,
      message: request.message,
      key: request.key,
      circuitName: opts.circuitName ?? "",
      stepIndex: opts.stepIndex ?? 0,
    });
  }

  // Prompt user, optionally with timeout
  const timeoutMs = opts?.requestTimeout && opts.requestTimeout > 0
    ? opts.requestTimeout * 1000
    : undefined;
  if (timeoutMs) {
    console.log(`  ${c.dim}Waiting for input (${opts!.requestTimeout}s timeout)...${c.reset}`);
  }

  const answer = await promptUser("", timeoutMs);

  if (answer === null) {
    console.log(
      timeoutMs
        ? `  ${c.yellow}Request timed out after ${opts!.requestTimeout}s — resuming${c.reset}`
        : `  ${c.dim}Input cancelled${c.reset}`,
    );
    return false;
  }

  scratchpad[request.key] = answer;
  console.log(`  ${c.green}Stored as scratchpad key: ${request.key}${c.reset}`);
  return true;
}

/**
 * Fire a NOTIFY bin command with request context as environment variables.
 * Fire-and-forget — exit code is ignored.
 */
function fireNotify(
  command: string,
  ctx: { reason: string; message: string; key: string; circuitName: string; stepIndex: number },
): void {
  const parts = command.split(/\s+/);
  const [cmd, ...args] = parts;
  if (!cmd) return;

  try {
    const proc = spawnProcess(cmd, args, {
      stdio: "ignore",
      detached: true,
      env: {
        ...process.env,
        CIRCUIT_REQUEST_REASON: ctx.reason,
        CIRCUIT_REQUEST_MESSAGE: ctx.message,
        CIRCUIT_REQUEST_KEY: ctx.key,
        CIRCUIT_NAME: ctx.circuitName,
        CIRCUIT_STEP: String(ctx.stepIndex + 1),
      },
    });
    proc.unref();
    console.log(`  ${c.dim}NOTIFY fired: ${command}${c.reset}`);
  } catch {
    console.log(`  ${c.yellow}NOTIFY failed to spawn: ${command}${c.reset}`);
  }
}
