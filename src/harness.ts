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
export class Harness {
  private client: OpenRouterClient;
  private model: string;

  constructor(client: OpenRouterClient, model: string) {
    this.client = client;
    this.model = model;
  }

  /**
   * Expand a RUN prompt with full context.
   */
  async expandRun(context: ExpansionContext): Promise<ExpansionResult> {
    const userMessage = this.buildContextMessage(context);
    return this.expand(
      RUN_EXPANSION_SYSTEM,
      userMessage,
      TEMP_RUN_EXPANSION,
    );
  }

  /**
   * Expand an EVAL prompt with full context.
   */
  async expandEval(context: ExpansionContext): Promise<ExpansionResult> {
    const userMessage = this.buildContextMessage(context);
    return this.expand(
      EVAL_EXPANSION_SYSTEM,
      userMessage,
      TEMP_EVAL_EXPANSION,
    );
  }

  private async expand(
    systemPrompt: string,
    userMessage: string,
    temperature: number,
  ): Promise<ExpansionResult> {
    // First attempt
    const response = await this.client.complete(
      this.model,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature,
    );

    let expandedPrompt = parseExpandedPrompt(response);

    if (expandedPrompt) {
      return {
        expandedPrompt,
        engineerScratchpadUpdates: parseEngineerScratchpadUpdates(response),
        rawResponse: response,
      };
    }

    // Format retry
    const retryResponse = await this.client.complete(
      this.model,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
        { role: "assistant", content: response },
        { role: "user", content: FORMAT_REMINDER },
      ],
      TEMP_FORMAT_RETRY,
    );

    expandedPrompt = parseExpandedPrompt(retryResponse);

    if (expandedPrompt) {
      return {
        expandedPrompt,
        engineerScratchpadUpdates: parseEngineerScratchpadUpdates(retryResponse),
        rawResponse: response + "\n\n--- FORMAT RETRY ---\n\n" + retryResponse,
      };
    }

    // Graceful degradation: use raw response as prompt
    return {
      expandedPrompt: retryResponse.trim() || response.trim(),
      engineerScratchpadUpdates: {},
      rawResponse: response + "\n\n--- FORMAT RETRY (degraded) ---\n\n" + retryResponse,
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

    // Scratchpad (BIN's)
    if (Object.keys(context.scratchpad).length > 0) {
      const entries = Object.entries(context.scratchpad)
        .map(([k, v]) => `  ${k}: ${v}`)
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

    // Environment
    sections.push(
      `ENVIRONMENT:\n` +
        `  os: ${context.environment.os}\n` +
        `  shell: ${context.environment.shell}\n` +
        `  working_directory: ${context.environment.cwd}\n` +
        `  date: ${context.environment.date}`,
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
