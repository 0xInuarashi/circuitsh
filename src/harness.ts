import type {
  ExpansionContext,
  ExpansionResult,
  IterationResult,
  Verdict,
  VerdictSynthesisResult,
} from "./types.ts";
import { OpenRouterClient } from "./client.ts";
import {
  parseExpandedPrompt,
  parseEngineerScratchpadUpdates,
} from "./verdict.ts";

// ── System Prompts ──

export const RUN_EXPANSION_SYSTEM = `\
You are a mentor and guide inside the Circuit orchestration system. \
Your job is NOT to write a specification or give instructions. \
Your job is to help the agent understand the direction, the spirit of the \
work, and the landscape of the problem — then get out of the way.

A good mentor:
- Sets context and direction, never tasks and instructions
- Observes what happened and offers a perspective, never a prescription
- Trusts the agent to figure out the how
- On retries: frames the situation as a puzzle to explore, not a fix-list
- Knows when to say less — silence is not a failure

Your expanded prompt must be SHORT. Often just the original prompt \
with 1-2 sentences of directional framing. If the original is already \
clear, add nothing. The agent needs room to think and create.

You will receive structured context. Use only what is relevant to \
giving direction — do not dump everything into the prompt.

If the context includes ALLOWED REQUEST CONDITIONS, you may request \
user input instead of generating an expanded prompt when the failure \
clearly matches one of the listed conditions. Use:
<request_input key="descriptive_key" reason="matching condition">
Your message to the user explaining what you need and why
</request_input>
Do NOT use request_input if no ALLOWED REQUEST CONDITIONS are listed.

You may also update your own scratchpad to track observations:
<engineer_scratchpad_set key="observation_name">your observation</engineer_scratchpad_set>

Output your expanded prompt inside these tags:
<expanded_prompt>
Your expanded prompt here.
</expanded_prompt>`;

const FORMAT_REMINDER = `\
IMPORTANT: You must output your expanded prompt inside <expanded_prompt>...</expanded_prompt> tags. \
Please try again with the correct format.`;

// ── Temperature Constants ──

const TEMP_RUN_EXPANSION = 0.35;
const TEMP_FORMAT_RETRY = 0.2;
const TEMP_VERDICT = 0.1;

const VERDICT_SYNTHESIS_SYSTEM = `\
You are a quality assessor. Given the step goal, what the agent ran, \
and the evaluation summary, emit exactly one verdict.

<verdict>SUCCESS</verdict>  — the criteria are met, advance to the next step
<verdict>PROGRESS</verdict>  — working toward the goal, retry with forward momentum
<verdict>FAILURE</verdict>   — off track or broken, retry with feedback
`;

/**
 * The Harness expands terse user prompts into rich, context-aware prompts
 * using the Prompt Engineer Model.
 */
export type EngineerCallLogger = (log: {
  callType: "run_expand" | "verdict_synthesis";
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
    onReasoningChunk?: (text: string) => void,
    onResult?: (meta: { totalCostUsd: number | null; numTurns: number | null; durationMs: number | null }) => void,
  ): Promise<ExpansionResult> {
    const userMessage = this.buildContextMessage(context);
    const systemPrompt = opts?.focus
      ? `${RUN_EXPANSION_SYSTEM}\n\n## Domain Focus (from circuit author)\n\n${opts.focus}\n\nThe circuit author has flagged the above as a priority. Use it to inform your perspective, not to prescribe the agent's approach.`
      : RUN_EXPANSION_SYSTEM;
    return this.expand(
      "run_expand",
      systemPrompt,
      userMessage,
      TEMP_RUN_EXPANSION,
      onChunk,
      onReasoningChunk,
      onResult,
      opts?.modelOverride,
    );
  }

  /**
   * Synthesize a verdict from the eval summary and run output.
   * A lightweight LLM call that reads what the agent did and what the eval reported,
   * then produces a SUCCESS/PROGRESS/FAILURE verdict with reasoning.
   */
  async synthesizeVerdict(
    stepGoal: string,
    runOutput: string,
    evalSummary: string,
  ): Promise<VerdictSynthesisResult> {
    const callStart = Date.now();
    const trunc = (s: string, n: number) =>
      s.length <= n ? s : s.slice(0, n);

    const userMessage =
      `<step_goal>${stepGoal}</step_goal>\n\n` +
      `<run_output>\n${trunc(runOutput, 4000)}\n</run_output>\n\n` +
      `<eval_summary>\n${evalSummary}\n</eval_summary>`;

    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: VERDICT_SYNTHESIS_SYSTEM },
      { role: "user", content: userMessage },
    ];

    const response = await this.streamComplete(this.model, messages, TEMP_VERDICT);
    const verdict = parseVerdictTag(response);

    const result: VerdictSynthesisResult = { verdict, reasoning: response };

    this.onLog?.({
      callType: "verdict_synthesis",
      model: this.model,
      temperature: TEMP_VERDICT,
      messages,
      rawOutput: response,
      parsedResult: { verdict, reasoning: response },
      durationMs: Date.now() - callStart,
      formatRetried: false,
    });

    return result;
  }

  private async streamComplete(
    model: string,
    messages: { role: "system" | "user" | "assistant"; content: string }[],
    temperature: number,
    onChunk?: (text: string) => void,
    onReasoningChunk?: (text: string) => void,
    onResult?: (meta: { totalCostUsd: number | null; numTurns: number | null; durationMs: number | null }) => void,
  ): Promise<string> {
    const chunks: string[] = [];
    for await (const chunk of this.client.stream(model, messages, temperature, onResult)) {
      chunks.push(chunk.content);
      if (onChunk && chunk.content) onChunk(chunk.content);
      if (onReasoningChunk && chunk.reasoning) onReasoningChunk(chunk.reasoning);
    }
    return chunks.join("");
  }

  private async expand(
    callType: "run_expand",
    systemPrompt: string,
    userMessage: string,
    temperature: number,
    onChunk?: (text: string) => void,
    onReasoningChunk?: (text: string) => void,
    onResult?: (meta: { totalCostUsd: number | null; numTurns: number | null; durationMs: number | null }) => void,
    modelOverride?: string,
  ): Promise<ExpansionResult> {
    const model = modelOverride ?? this.model;
    const callStart = Date.now();
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    // First attempt
    const response = await this.streamComplete(model, messages, temperature, onChunk, onReasoningChunk, onResult);

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
    const retryResponse = await this.streamComplete(model, retryMessages, TEMP_FORMAT_RETRY, onChunk, onReasoningChunk, onResult);

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
  buildContextMessage(context: ExpansionContext): string {
    const sections: string[] = [];

    sections.push(`GOAL: ${context.goal}`);
    sections.push(`ROLE: ${context.role === "run" ? "Task Executor (RUN)" : "Evaluator (EVAL)"}`);
    sections.push(
      `${context.role === "run" ? "TASK" : "EVALUATION CRITERIA"}: ${context.userPrompt}`,
    );
    sections.push(
      `ITERATION: ${context.iteration + 1} of ${context.maxRetries + 1}` +
        ` (${context.isFirst ? "first attempt" : `retry ${context.iteration}, ${context.maxRetries - context.iteration} retries remaining`})`,
    );

    const engEntries = Object.entries(context.engineerScratchpad);
    if (engEntries.length > 0) {
      sections.push(
        `YOUR OBSERVATIONS (from previous expansions):\n${engEntries.map(([k, v]) => `  ${k}: ${v}`).join("\n")}`,
      );
    }

    if (context.workingDirDiff) {
      sections.push(`WORKING DIRECTORY CHANGES (since last iteration):\n${context.workingDirDiff}`);
    }

    if (context.stepContext) {
      sections.push(`PREVIOUS STEPS:\n${context.stepContext}`);
    }

    if (context.allowRequests?.length) {
      sections.push(
        `ALLOWED REQUEST CONDITIONS:\n${context.allowRequests.map((c) => `  - ${c}`).join("\n")}`,
      );
    }

    const m = context.environment.machine;
    sections.push(
      `ENVIRONMENT:\n` +
        `  os: ${context.environment.os}, shell: ${context.environment.shell}\n` +
        `  cwd: ${context.environment.cwd}\n` +
        `  cpu: ${m.cpuModel} (${m.cpuCores} cores), ram: ${m.ramFreeMB}MB free\n` +
        `  gpu: ${m.gpu ?? "none"}`,
    );

    if (context.executionHistory.length > 0) {
      sections.push(`EXECUTION HISTORY:\n${compressExecutionHistory(context.executionHistory)}`);
    }

    return sections.join("\n\n");
  }
}

/**
 * Compress execution history for the prompt engineer.
 * First 2 and last 2 iterations in full detail, middle as one-liners.
 */
function compressExecutionHistory(history: IterationResult[]): string {
  if (history.length === 0) return "No previous iterations.";

  const trunc = (s: string, n: number) =>
    s.length <= n ? s : s.slice(0, n);

  const lines: string[] = [];

  const fullIndices = new Set<number>();
  for (let i = 0; i < Math.min(2, history.length); i++) fullIndices.add(i);
  for (let i = Math.max(0, history.length - 2); i < history.length; i++)
    fullIndices.add(i);

  for (let i = 0; i < history.length; i++) {
    const iter = history[i]!;
    const verdict = iter.verdict ?? "NO_EVAL";

    if (fullIndices.has(i)) {
      lines.push(`--- Iteration ${iter.iteration + 1} [${verdict}] ---`);
      lines.push(`RUN: ${trunc(iter.expandedRunPrompt, 2000)}`);
      lines.push(`RUN output (exit ${iter.runOutput.exitCode}): ${trunc(iter.runOutput.stdout, 3000)}`);
      if (iter.evalOutput) {
        lines.push(`EVAL: ${trunc(iter.evalOutput.stdout, 3000)}`);
      }
      if (iter.feedback) {
        lines.push(`Feedback: ${trunc(iter.feedback, 2000)}`);
      }
      lines.push("");
    } else {
      lines.push(
        `[Iteration ${iter.iteration + 1}] ${verdict} — exit ${iter.runOutput.exitCode}`,
      );
    }
  }

  return lines.join("\n");
}

/**
 * Extract verdict from a verdict synthesis LLM response.
 * Falls back to FAILURE if no tag found.
 */
function parseVerdictTag(response: string): Verdict {
  const match = response.match(/<verdict>(.*?)<\/verdict>/is);
  if (!match) return "FAILURE";
  const text = match[1]!.trim().toUpperCase();
  if (text === "SUCCESS" || text === "PROGRESS" || text === "FAILURE") {
    return text;
  }
  return "FAILURE";
}
