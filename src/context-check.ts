import type { CircuitAST, CircuitConfig } from "./types.ts";

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  white: "\x1b[97m",
};

const CONTEXT_CHECK_SYSTEM = `\
You are a Circuit pre-flight diagnostic tool. Your job is to analyze a circuit's \
CIRCUIT_CONTEXT entries (information pre-supplied by the author) against its \
ALLOW_REQUEST conditions (points where the circuit may pause and ask the user for input).

Your analysis must identify:
1. ALLOW_REQUEST conditions that are NOT covered by any CIRCUIT_CONTEXT — these WILL cause \
   the circuit to pause and wait for user input during execution.
2. ALLOW_REQUEST conditions that ARE covered (fully or partially) by CIRCUIT_CONTEXT — \
   the prompt engineer may still fire a request if the context is insufficient, but it's less likely.
3. Any other potential request-breaks you can infer from the step prompts themselves — \
   situations where the agent will likely need information not provided in context \
   (e.g., credentials, environment-specific values, approval for destructive actions).

Be concise and actionable. For each gap, suggest what CIRCUIT_CONTEXT entry could prevent it.

Output format:
- Use ✓ for covered conditions
- Use ✗ for uncovered conditions (will cause request-breaks)
- Use ? for inferred risks from step prompts
- End with a summary: how many request-breaks are likely, and a recommended action.`;

/**
 * Analyze CIRCUIT_CONTEXT vs ALLOW_REQUEST conditions for gaps.
 */
export async function contextCheck(
  ast: CircuitAST,
  config: CircuitConfig,
): Promise<void> {
  const circuit = ast.circuits[0]!;

  // Collect all ALLOW_REQUEST conditions with step info
  const requests: { condition: string; step: number; role: "RUN" | "EVAL" }[] = [];
  for (let si = 0; si < circuit.steps.length; si++) {
    const step = circuit.steps[si]!;
    if (step.run.allowRequests) {
      for (const cond of step.run.allowRequests) {
        requests.push({ condition: cond, step: si + 1, role: "RUN" });
      }
    }
    if (step.eval?.allowRequests) {
      for (const cond of step.eval.allowRequests) {
        requests.push({ condition: cond, step: si + 1, role: "EVAL" });
      }
    }
  }

  console.log(`${c.bold}${c.cyan}Context Check:${c.reset} ${circuit.name}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}`);

  // Report raw counts
  console.log(`  CIRCUIT_CONTEXT entries: ${ast.circuitContext.length}`);
  console.log(`  ALLOW_REQUEST conditions: ${requests.length}`);

  if (requests.length === 0) {
    console.log(`\n  ${c.green}No ALLOW_REQUEST conditions — circuit is fully autonomous.${c.reset}`);
    console.log(`  ${c.dim}No request-breaks possible.${c.reset}`);
    return;
  }

  console.log(`${c.dim}${"─".repeat(50)}${c.reset}`);
  console.log(`${c.dim}Analyzing with ${config.promptEngineerModel}...${c.reset}\n`);

  // Build the analysis prompt
  const contextSection = ast.circuitContext.length > 0
    ? ast.circuitContext.map((ctx, i) => `  ${i + 1}. ${ctx}`).join("\n")
    : "  (none provided)";

  const requestSection = requests
    .map((r) => `  Step ${r.step} (${r.role}): "${r.condition}"`)
    .join("\n");

  const stepsSection = circuit.steps
    .map((s, i) => {
      let desc = `  Step ${i + 1} RUN: ${s.run.prompt.slice(0, 120)}`;
      if (s.eval) desc += `\n  Step ${i + 1} EVAL: ${s.eval.prompt.slice(0, 120)}`;
      return desc;
    })
    .join("\n");

  const userMessage = `\
CIRCUIT_CONTEXT (pre-supplied by author):
${contextSection}

ALLOW_REQUEST conditions (will pause for user input):
${requestSection}

STEP PROMPTS (for inferring additional risks):
${stepsSection}

Analyze the gaps.`;

  try {
    const response = await fetchCompletion(
      config.apiUrl,
      config.apiKey,
      config.promptEngineerModel,
      CONTEXT_CHECK_SYSTEM,
      userMessage,
    );

    if (response.trim()) {
      console.log(response);
    } else {
      console.log(`  ${c.yellow}Empty response from ${config.promptEngineerModel}.${c.reset}`);
      console.log(`  ${c.dim}Falling back to local analysis...${c.reset}\n`);
      localFallback(ast.circuitContext, requests, circuit.steps);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ${c.yellow}LLM analysis failed: ${msg}${c.reset}`);
    console.log(`  ${c.dim}Falling back to local analysis...${c.reset}\n`);
    localFallback(ast.circuitContext, requests, circuit.steps);
  }
  console.log(`\n${c.dim}${"─".repeat(50)}${c.reset}`);
}

/**
 * Direct non-streaming completion — bypasses OpenRouterClient to avoid
 * async generator issues in certain execution contexts.
 */
async function fetchCompletion(
  apiUrl: string,
  apiKey: string,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const resp = await fetch(`${apiUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      stream: false,
    }),
  });

  if (!resp.ok) {
    throw new Error(`API returned ${resp.status}: ${await resp.text()}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content ?? "";
}

/**
 * Deterministic fallback when LLM is unavailable.
 * Simple keyword overlap check between CIRCUIT_CONTEXT and ALLOW_REQUEST conditions.
 */
function localFallback(
  circuitContext: string[],
  requests: { condition: string; step: number; role: "RUN" | "EVAL" }[],
  steps: import("./types.ts").Step[],
): void {
  const contextLower = circuitContext.map((ctx) => ctx.toLowerCase());

  for (const req of requests) {
    const condWords = req.condition.toLowerCase().split(/\s+/);
    const covered = contextLower.some((ctx) =>
      condWords.some((w) => w.length > 3 && ctx.includes(w)),
    );

    if (covered) {
      console.log(`  ${c.green}✓${c.reset} Step ${req.step} (${req.role}): "${req.condition}"`);
      console.log(`    ${c.dim}Likely covered by CIRCUIT_CONTEXT${c.reset}`);
    } else {
      console.log(`  ${c.red}✗${c.reset} Step ${req.step} (${req.role}): "${req.condition}"`);
      console.log(`    ${c.yellow}No matching CIRCUIT_CONTEXT — will pause for input${c.reset}`);
    }
  }

  const uncovered = requests.filter((req) => {
    const condWords = req.condition.toLowerCase().split(/\s+/);
    return !contextLower.some((ctx) =>
      condWords.some((w) => w.length > 3 && ctx.includes(w)),
    );
  });

  console.log(
    `\n  ${c.bold}Summary:${c.reset} ${uncovered.length}/${requests.length} conditions uncovered — ` +
      (uncovered.length === 0
        ? `${c.green}no request-breaks expected${c.reset}`
        : `${c.yellow}${uncovered.length} potential request-break(s)${c.reset}`),
  );

  if (uncovered.length > 0) {
    console.log(`\n  ${c.dim}Suggested CIRCUIT_CONTEXT additions:${c.reset}`);
    for (const req of uncovered) {
      console.log(`    CIRCUIT_CONTEXT "${req.condition.replace(/"/g, '\\"')}"`);
    }
  }
}
