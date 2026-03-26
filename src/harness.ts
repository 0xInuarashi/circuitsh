import type {
  ExpansionContext,
  ExpansionResult,
  IterationResult,
} from "./types.ts";
import { OpenRouterClient } from "./client.ts";
import {
  parseExpandedPrompt,
  parseEngineerScratchpadUpdates,
} from "./verdict.ts";

// ── System Prompts ──

const RUN_EXPANSION_SYSTEM = `\
You are a prompt engineer inside the Circuit orchestration system. Your job is to expand \
a terse task description into a rich, detailed prompt that will be sent to an AI coding agent.

You will receive structured context including the goal, task description, iteration state, \
previous evaluation feedback, scratchpad state, working directory state, and execution history.

Your expanded prompt must:
1. Clearly state the task with enough detail for the agent to execute it
2. Incorporate any feedback from previous evaluation failures — be specific about what went wrong and what must change
3. Reference relevant files/state from the working directory context
4. Include the overall goal to prevent drift
5. Be specific about success criteria so the agent can self-verify
6. If this is a retry, emphasize what previously failed and direct the agent to take a different approach
7. If retries are running low, signal urgency and suggest more creative/radical approaches

If the context includes ALLOWED REQUEST CONDITIONS, you may request user input instead of \
generating an expanded prompt when the failure clearly matches one of the listed conditions. \
Only use this when the iteration would fail without information only the user can provide. Use:
<request_input key="descriptive_key" reason="matching condition">
Your message to the user explaining what you need and why
</request_input>
Do NOT use request_input if no ALLOWED REQUEST CONDITIONS are listed.

You may also update your own scratchpad to track meta-observations across iterations. \
Use these tags in your response (outside the expanded_prompt tags):
<engineer_scratchpad_set key="observation_name">your observation</engineer_scratchpad_set>

Output your expanded prompt inside these tags:
<expanded_prompt>
Your expanded prompt here.
</expanded_prompt>`;

const EVAL_EXPANSION_SYSTEM = `\
You are a prompt engineer inside the Circuit orchestration system. Your job is to expand \
a terse evaluation description into a rigorous, detailed evaluation prompt that will be \
sent to an AI evaluator agent.

You will receive structured context including the goal, evaluation criteria, iteration state, \
eval history, working directory state, and execution history.

Your expanded prompt must:
1. Clearly state the success criteria with specific, measurable checks
2. Instruct the agent to examine concrete artifacts (files, test output, logs, etc.)
3. Reference the working directory and what should have changed
4. Be strict but fair in what constitutes success
5. If previous evaluations found issues that were supposedly fixed, verify those specific fixes

If the context includes ALLOWED REQUEST CONDITIONS, you may request user input instead of \
generating an expanded prompt when the failure clearly matches one of the listed conditions. \
Only use this when evaluation cannot proceed without information only the user can provide. Use:
<request_input key="descriptive_key" reason="matching condition">
Your message to the user explaining what you need and why
</request_input>
Do NOT use request_input if no ALLOWED REQUEST CONDITIONS are listed.

The evaluation prompt MUST instruct the agent to end its response with exactly one of:
<verdict>SUCCESS</verdict>
<verdict>FAILURE</verdict>

If the verdict is FAILURE, the evaluator MUST explain in detail what needs to change, \
what specific criteria were not met, and provide actionable guidance.

You may also update your own scratchpad to track meta-observations across iterations. \
Use these tags in your response (outside the expanded_prompt tags):
<engineer_scratchpad_set key="observation_name">your observation</engineer_scratchpad_set>

Output your expanded prompt inside these tags:
<expanded_prompt>
Your expanded prompt here.
</expanded_prompt>`;

const FORMAT_REMINDER = `\
IMPORTANT: You must output your expanded prompt inside <expanded_prompt>...</expanded_prompt> tags. \
Please try again with the correct format.`;

// ── Temperature Constants ──

const TEMP_RUN_EXPANSION = 0.7;
const TEMP_EVAL_EXPANSION = 0.3;
const TEMP_FORMAT_RETRY = 0.2;

/**
 * The Harness expands terse user prompts into rich, context-aware prompts
 * using the Prompt Engineer Model.
 */
export type EngineerCallLogger = (log: {
  callType: "run_expand" | "eval_expand" | "timeout_diagnosis";
  model: string;
  temperature: number;
  messages: Array<{ role: string; content: string }>;
  rawOutput: string;
  parsedResult: Record<string, unknown>;
  durationMs: number;
  formatRetried: boolean;
}) => void;

export class Harness {
  private client: OpenRouterClient;
  private model: string;
  private onLog: EngineerCallLogger | null = null;

  constructor(client: OpenRouterClient, model: string) {
    this.client = client;
    this.model = model;
  }

  setLogger(logger: EngineerCallLogger): void {
    this.onLog = logger;
  }

  /**
   * Expand a RUN prompt with full context.
   * Optional model/focus override from EXPAND directive.
   */
  async expandRun(
    context: ExpansionContext,
    opts?: { modelOverride?: string; focus?: string },
    onChunk?: (text: string) => void,
  ): Promise<ExpansionResult> {
    const userMessage = this.buildContextMessage(context);
    const systemPrompt = opts?.focus
      ? `${RUN_EXPANSION_SYSTEM}\n\n## Domain Focus (from circuit author)\n\n${opts.focus}\n\nThe above focus directive reflects the circuit author's domain-specific priorities and constraints. Ensure your expanded prompt steers the agent toward these specific concerns. On retries, reinforce these priorities with increasing emphasis.`
      : RUN_EXPANSION_SYSTEM;
    return this.expand(
      "run_expand",
      systemPrompt,
      userMessage,
      TEMP_RUN_EXPANSION,
      onChunk,
      opts?.modelOverride,
    );
  }

  /**
   * Expand an EVAL prompt with full context.
   * Optional model/focus override from EXPAND directive.
   */
  async expandEval(
    context: ExpansionContext,
    opts?: { modelOverride?: string; focus?: string },
    onChunk?: (text: string) => void,
  ): Promise<ExpansionResult> {
    const userMessage = this.buildContextMessage(context);
    const systemPrompt = opts?.focus
      ? `${EVAL_EXPANSION_SYSTEM}\n\n## Domain Focus (from circuit author)\n\n${opts.focus}\n\nThe above focus directive reflects the circuit author's domain-specific evaluation priorities. Ensure your expanded evaluation prompt tests for these specific concerns. Be strict about these criteria.`
      : EVAL_EXPANSION_SYSTEM;
    return this.expand(
      "eval_expand",
      systemPrompt,
      userMessage,
      TEMP_EVAL_EXPANSION,
      onChunk,
      opts?.modelOverride,
    );
  }

  private async streamComplete(
    model: string,
    messages: { role: "system" | "user" | "assistant"; content: string }[],
    temperature: number,
    onChunk?: (text: string) => void,
  ): Promise<string> {
    const chunks: string[] = [];
    for await (const chunk of this.client.stream(model, messages, temperature)) {
      chunks.push(chunk.content);
      if (onChunk && chunk.content) onChunk(chunk.content);
    }
    return chunks.join("");
  }

  private async expand(
    callType: "run_expand" | "eval_expand",
    systemPrompt: string,
    userMessage: string,
    temperature: number,
    onChunk?: (text: string) => void,
    modelOverride?: string,
  ): Promise<ExpansionResult> {
    const model = modelOverride ?? this.model;
    const callStart = Date.now();
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    // First attempt
    const response = await this.streamComplete(model, messages, temperature, onChunk);

    let expandedPrompt = parseExpandedPrompt(response);

    if (expandedPrompt) {
      const result: ExpansionResult = {
        expandedPrompt,
        engineerScratchpadUpdates: parseEngineerScratchpadUpdates(response),
        rawResponse: response,
      };
      this.onLog?.({
        callType,
        model,
        temperature,
        messages,
        rawOutput: response,
        parsedResult: { expandedPrompt, engineerScratchpadUpdates: result.engineerScratchpadUpdates },
        durationMs: Date.now() - callStart,
        formatRetried: false,
      });
      return result;
    }

    // Format retry
    const retryMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      ...messages,
      { role: "assistant", content: response },
      { role: "user", content: FORMAT_REMINDER },
    ];
    const retryResponse = await this.streamComplete(model, retryMessages, TEMP_FORMAT_RETRY, onChunk);

    expandedPrompt = parseExpandedPrompt(retryResponse);
    const combinedRaw = response + "\n\n--- FORMAT RETRY ---\n\n" + retryResponse;

    if (expandedPrompt) {
      const result: ExpansionResult = {
        expandedPrompt,
        engineerScratchpadUpdates: parseEngineerScratchpadUpdates(retryResponse),
        rawResponse: combinedRaw,
      };
      this.onLog?.({
        callType,
        model,
        temperature,
        messages: retryMessages,
        rawOutput: combinedRaw,
        parsedResult: { expandedPrompt, engineerScratchpadUpdates: result.engineerScratchpadUpdates },
        durationMs: Date.now() - callStart,
        formatRetried: true,
      });
      return result;
    }

    // Graceful degradation: use raw response as prompt
    const degradedRaw = response + "\n\n--- FORMAT RETRY (degraded) ---\n\n" + retryResponse;
    this.onLog?.({
      callType,
      model,
      temperature,
      messages: retryMessages,
      rawOutput: degradedRaw,
      parsedResult: { degraded: true },
      durationMs: Date.now() - callStart,
      formatRetried: true,
    });
    return {
      expandedPrompt: retryResponse.trim() || response.trim(),
      engineerScratchpadUpdates: {},
      rawResponse: degradedRaw,
    };
  }

  /**
   * Build the full context message for the prompt engineer.
   */
  private buildContextMessage(context: ExpansionContext): string {
    const sections: string[] = [];

    // Goal (always first — prevent drift)
    sections.push(`GOAL: ${context.goal}`);

    // Role
    sections.push(`ROLE: ${context.role === "run" ? "Task Executor (RUN)" : "Evaluator (EVAL)"}`);

    // User prompt
    sections.push(
      `${context.role === "run" ? "TASK" : "EVALUATION CRITERIA"}: ${context.userPrompt}`,
    );

    // Iteration metadata
    sections.push(
      `ITERATION: ${context.iteration + 1} of ${context.maxRetries + 1}` +
        ` (${context.isFirst ? "first attempt" : `retry ${context.iteration}, ${context.maxRetries - context.iteration} retries remaining`})`,
    );

    // EVAL feedback (RUN retries only)
    if (context.evalFeedback) {
      sections.push(
        `PREVIOUS EVALUATION FEEDBACK:\n${context.evalFeedback}`,
      );
    }

    // Eval history (EVAL role only)
    if (context.evalHistory) {
      sections.push(`EVAL HISTORY:\n${context.evalHistory}`);
    }

    // Scratchpad (BIN's) — label circuit_context entries distinctly
    if (Object.keys(context.scratchpad).length > 0) {
      const entries = Object.entries(context.scratchpad)
        .map(([k, v]) =>
          k.startsWith("circuit_context_")
            ? `  [circuit_context] ${v}`
            : `  ${k}: ${v}`,
        )
        .join("\n");
      sections.push(`AGENT SCRATCHPAD:\n${entries}`);
    }

    // Engineer scratchpad
    if (Object.keys(context.engineerScratchpad).length > 0) {
      const entries = Object.entries(context.engineerScratchpad)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join("\n");
      sections.push(`YOUR SCRATCHPAD (from previous expansions):\n${entries}`);
    }

    // Working directory
    if (context.isFirst && context.workingDirSnapshot) {
      sections.push(
        `WORKING DIRECTORY (${context.environment.cwd}):\n${context.workingDirSnapshot}`,
      );
    }
    if (context.workingDirDiff) {
      sections.push(
        `WORKING DIRECTORY CHANGES (since last iteration):\n${context.workingDirDiff}`,
      );
    }

    // Step context (multi-step)
    if (context.stepContext) {
      sections.push(`PREVIOUS STEPS COMPLETED:\n${context.stepContext}`);
    }

    // ALLOW_REQUEST conditions
    if (context.allowRequests && context.allowRequests.length > 0) {
      const conditions = context.allowRequests.map((c) => `  - ${c}`).join("\n");
      sections.push(
        `ALLOWED REQUEST CONDITIONS (you may request user input for these):\n${conditions}`,
      );
    }

    // Environment + machine context
    const m = context.environment.machine;
    sections.push(
      `ENVIRONMENT:\n` +
        `  os: ${context.environment.os}\n` +
        `  shell: ${context.environment.shell}\n` +
        `  working_directory: ${context.environment.cwd}\n` +
        `  date: ${context.environment.date}\n` +
        `  cpu: ${m.cpuModel} (${m.cpuCores} cores)\n` +
        `  ram: ${m.ramFreeMB}MB free / ${m.ramTotalMB}MB total\n` +
        `  disk: ${m.diskFreeGB}GB free / ${m.diskTotalGB}GB total\n` +
        `  gpu: ${m.gpu ?? "none"}`,
    );

    // Execution history (compressed for context window, full available)
    if (context.executionHistory.length > 0) {
      const historyStr = compressExecutionHistory(context.executionHistory);
      sections.push(`EXECUTION HISTORY:\n${historyStr}`);
    }

    return sections.join("\n\n");
  }
}

/**
 * Compress execution history for the prompt engineer.
 * First 3 and last 3 iterations in full detail, middle compressed.
 */
function compressExecutionHistory(history: IterationResult[]): string {
  if (history.length === 0) return "No previous iterations.";

  const lines: string[] = [];

  const fullIndices = new Set<number>();
  for (let i = 0; i < Math.min(3, history.length); i++) fullIndices.add(i);
  for (let i = Math.max(0, history.length - 3); i < history.length; i++)
    fullIndices.add(i);

  for (let i = 0; i < history.length; i++) {
    const iter = history[i]!;
    const verdict = iter.verdict ?? "NO_EVAL";

    if (fullIndices.has(i)) {
      lines.push(`--- Iteration ${iter.iteration + 1} [${verdict}] ---`);
      lines.push(`RUN prompt: ${iter.expandedRunPrompt.slice(0, 200)}...`);
      lines.push(`RUN output (exit ${iter.runOutput.exitCode}): ${iter.runOutput.stdout.slice(0, 500)}`);
      if (iter.evalOutput) {
        lines.push(`EVAL output: ${iter.evalOutput.stdout.slice(0, 500)}`);
      }
      if (iter.feedback) {
        lines.push(`Feedback: ${iter.feedback.slice(0, 300)}`);
      }
      lines.push("");
    } else {
      lines.push(
        `[Iteration ${iter.iteration + 1}] ${verdict} — RUN exit ${iter.runOutput.exitCode}, ${iter.feedback.slice(0, 80)}...`,
      );
    }
  }

  return lines.join("\n");
}

// ── Timeout Diagnosis ──

export interface TimeoutDiagnosis {
  action: "resume" | "retry" | "increase_timeout" | "abort";
  reason: string;
  suggestedTimeoutMs?: number;
}

const TIMEOUT_DIAGNOSIS_SYSTEM = `\
You are the prompt engineer inside the Circuit orchestration system. A BIN command has timed out. \
You must analyze the partial output and decide what to do.

Analyze the situation and decide one of these actions:
- "resume": The work was progressing well but ran out of time. Resume the session to continue where it left off.
- "retry": The approach seems wrong or stuck. Retry from scratch with a different strategy.
- "increase_timeout": The work is correct and progressing but legitimately needs more time (e.g. compiling, downloading). Suggest a new timeout.
- "abort": The situation is unrecoverable (e.g. infinite loop, fundamental error).

Output your decision in these tags:
<timeout_action>resume|retry|increase_timeout|abort</timeout_action>
<timeout_reason>Brief explanation of why</timeout_reason>
<timeout_suggested_ms>number (only if action is increase_timeout)</timeout_suggested_ms>`;

export async function diagnoseTimeout(
  client: OpenRouterClient,
  model: string,
  opts: {
    binCommand: string;
    timeoutMs: number;
    partialStdout: string;
    partialStderr: string;
    role: "run" | "eval";
    iteration: number;
    maxRetries: number;
    goal: string;
    userPrompt: string;
  },
  onLog?: EngineerCallLogger,
): Promise<TimeoutDiagnosis> {
  const message = `\
A ${opts.role.toUpperCase()} BIN timed out after ${opts.timeoutMs / 1000}s.

GOAL: ${opts.goal}
TASK: ${opts.userPrompt}
BIN: ${opts.binCommand}
ITERATION: ${opts.iteration + 1} of ${opts.maxRetries + 1}

PARTIAL STDOUT (last 3000 chars):
${opts.partialStdout.slice(-3000)}

PARTIAL STDERR (last 1500 chars):
${opts.partialStderr.slice(-1500)}

What should we do?`;

  const callStart = Date.now();
  const messages: Array<{ role: "system" | "user"; content: string }> = [
    { role: "system", content: TIMEOUT_DIAGNOSIS_SYSTEM },
    { role: "user", content: message },
  ];

  try {
    const response = await client.complete(model, messages, 0.2);

    const actionMatch = response.match(/<timeout_action>(.*?)<\/timeout_action>/s);
    const reasonMatch = response.match(/<timeout_reason>(.*?)<\/timeout_reason>/s);
    const timeoutMatch = response.match(/<timeout_suggested_ms>(\d+)<\/timeout_suggested_ms>/s);

    const action = actionMatch?.[1]?.trim() as TimeoutDiagnosis["action"] ?? "retry";
    const reason = reasonMatch?.[1]?.trim() ?? "Could not determine reason";
    const suggestedTimeoutMs = timeoutMatch ? parseInt(timeoutMatch[1]!, 10) : undefined;

    // Validate action
    if (!["resume", "retry", "increase_timeout", "abort"].includes(action)) {
      onLog?.({
        callType: "timeout_diagnosis",
        model,
        temperature: 0.2,
        messages,
        rawOutput: response,
        parsedResult: { action, reason: `Unknown action "${action}", defaulting to retry` },
        durationMs: Date.now() - callStart,
        formatRetried: false,
      });
      return { action: "retry", reason: `Unknown action "${action}", defaulting to retry` };
    }

    onLog?.({
      callType: "timeout_diagnosis",
      model,
      temperature: 0.2,
      messages,
      rawOutput: response,
      parsedResult: { action, reason, suggestedTimeoutMs },
      durationMs: Date.now() - callStart,
      formatRetried: false,
    });

    return { action, reason, suggestedTimeoutMs };
  } catch {
    onLog?.({
      callType: "timeout_diagnosis",
      model,
      temperature: 0.2,
      messages,
      rawOutput: "(diagnosis failed)",
      parsedResult: { action: "resume", reason: "Diagnosis failed, defaulting to resume", error: true },
      durationMs: Date.now() - callStart,
      formatRetried: false,
    });
    // If diagnosis itself fails, default to resume (optimistic)
    return { action: "resume", reason: "Diagnosis failed, defaulting to resume" };
  }
}
