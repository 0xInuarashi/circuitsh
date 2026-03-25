# Circuit Language Guide

Circuit is a language for AI orchestration. It plugs AI agents together in eval-retry loops — you describe what to build, what success looks like, and Circuit handles the rest.

## How It Works

A `.circuit` file defines a **circuit**: a series of steps where an AI agent does work (`RUN`), another evaluates it (`EVAL`), and if evaluation fails, the loop retries with feedback until it passes or retries run out.

```
RUN → EVAL → pass? → next step
              ↓ fail
           feedback → needs human input? → ALLOW_REQUEST? → pause → user input → RUN (retry)
                        ↓ no                                  ↓ not allowed
                      RUN (retry)                           RUN (retry)
```

Circuit is the wiring, not the components. The AI agents (Claude, aider, codex, etc.) improve independently — Circuit plugs them together.

## File Structure

A `.circuit` file has two sections: **defines** (configuration) at the top, followed by one or more **CIRCUIT blocks**.

```circuit
# Configuration
PROVIDER Openrouter
API_KEY ${OPENROUTER_API_KEY}
RUN_BIN claude --dangerously-skip-permissions
DIR ~/my-project

# The circuit
CIRCUIT Build a web scraper:
  RUN Build a web scraper in Python that handles rate limiting and retries
  EVAL Test the scraper against 3 different sites and verify it handles errors gracefully
    RETRY 5
```

## Defines

Top-level key-value pairs that configure the circuit runtime.

| Directive | Required | Default | Description |
|---|---|---|---|
| `PROVIDER` | No | `openrouter` | API provider for the prompt engineer model |
| `API_KEY` | Yes* | `$OPENROUTER_API_KEY` | API key for PROVIDER |
| `API_URL` | No | `https://openrouter.ai/api/v1` | API base URL (for local models, custom endpoints) |
| `PROMPT_ENGINEER_MODEL` | No | `anthropic/claude-sonnet-4-6` | Model that expands your prompts into rich context |
| `RUN_BIN` | Yes | — | Command to execute tasks (e.g., `claude`, `aider`) |
| `EVAL_BIN` | No | same as `RUN_BIN` | Command to evaluate tasks |
| `ALIAS` | No | — | Named alias for a bin command (see [Aliases](#aliases)) |
| `DIR` | No | `.` | Working directory (created if it doesn't exist) |
| `LOG_DIR` | No | `.circuit-runs/` | Where JSONL run logs are saved |
| `CHECKPOINT` | No | `off` | Git snapshot before each iteration (`on`/`off`) |
| `TIMEOUT` | No | `0` | Per-step timeout in seconds (0 = no limit) |

Config priority: **CLI flags > .circuit defines > environment variables > defaults**

## Aliases

Define named aliases for bin commands to keep circuit bodies readable:

```circuit
ALIAS claude "claude --dangerously-skip-permissions"
ALIAS aider "aider --model sonnet"
ALIAS bench "./bench.sh"
```

Aliases can be referenced in `RUN_BIN`, `EVAL_BIN`, and `WITH` clauses. If the value matches an alias name, the alias command is used; otherwise the value is treated as a literal command.

```circuit
ALIAS claude "claude --dangerously-skip-permissions"
RUN_BIN claude          # resolves to "claude --dangerously-skip-permissions"
EVAL_BIN claude         # same
```

## Step Directives

### RUN

```circuit
  RUN <prompt>
  RUN <prompt> WITH <bin>
```

Executes a task. The prompt is a terse, human-written description — the runtime's prompt engineer model expands it into a rich, context-aware prompt before sending it to `RUN_BIN` (or the bin specified by `WITH`).

### EVAL

```circuit
  EVAL <prompt>
    RETRY <N>
  EVAL <prompt> WITH <bin>
    RETRY <N>
```

Evaluates the preceding RUN's work. Must follow a RUN. The EVAL agent must output a verdict:

```
<verdict>SUCCESS</verdict>   — step passes, move to next step
<verdict>FAILURE</verdict>   — step fails, retry with feedback
```

If no `<verdict>` tag is found, it defaults to FAILURE (safe default). The entire EVAL output becomes the feedback for the next RUN retry.

### RETRY

```circuit
    RETRY 10
```

Max retries for the RUN/EVAL pair. Total attempts = RETRY + 1. Default is 3 if omitted. Nested under EVAL.

### ALLOW_REQUEST

```circuit
  RUN "build a cloudflare connector"
    ALLOW_REQUEST "an API key is required"
    ALLOW_REQUEST "the zone ID is needed"
  EVAL "does the connector work?"
    ALLOW_REQUEST "deployment credentials needed"
    RETRY 5
```

A permission gate that allows the prompt engineer to request user input during a step. Without `ALLOW_REQUEST`, the circuit is fully autonomous — if it gets stuck, it retries until exhaustion. No escape hatch.

With `ALLOW_REQUEST`, the circuit author declares specific conditions under which pausing for human input is acceptable. The prompt engineer sees these conditions, and when a failure matches one, it can request input instead of burning a retry.

**Rules:**
- Nested under `RUN` or `EVAL` at indent level 2
- Multiple `ALLOW_REQUEST` conditions are allowed per step
- Must come **before** `NOTIFY`, `REQUEST_TIMEOUT`, and `RETRY` — ordering is enforced by the parser
- The prompt engineer fuzzy-matches failure patterns against the declared conditions
- User input is stored in the scratchpad and available to subsequent expansions
- Requesting input does **not** consume a retry

```circuit
CIRCUIT deploy:
  RUN "deploy to production"
    ALLOW_REQUEST "cloud credentials are required"
    NOTIFY ./notify.sh
    REQUEST_TIMEOUT 600
  EVAL "verify deployment is live"
    ALLOW_REQUEST "manual DNS verification needed"
    NOTIFY ./notify.sh --channel ops
    REQUEST_TIMEOUT 300
    RETRY 3
```

### NOTIFY

```circuit
    NOTIFY ./notify.sh
    NOTIFY ./notify.sh --channel ops --priority high
```

Fires a bin command when the prompt engineer requests user input. Fire-and-forget — the engine doesn't wait for the script to finish or check its exit code. The user owns the notification logic.

**Requires** at least one `ALLOW_REQUEST` — the parser rejects `NOTIFY` without it.

The engine injects context as environment variables:

| Variable | Description |
|---|---|
| `CIRCUIT_REQUEST_REASON` | The matched condition from ALLOW_REQUEST |
| `CIRCUIT_REQUEST_MESSAGE` | The prompt engineer's message to the user |
| `CIRCUIT_REQUEST_KEY` | The scratchpad key being requested |
| `CIRCUIT_NAME` | The circuit name |
| `CIRCUIT_STEP` | Step number (1-indexed) |

Example notify script:

```bash
#!/bin/bash
curl -X POST "$SLACK_WEBHOOK" \
  -d "{\"text\": \"Circuit paused: $CIRCUIT_REQUEST_MESSAGE\"}"
```

### REQUEST_TIMEOUT

```circuit
    REQUEST_TIMEOUT 600
```

Seconds to wait for user input before giving up. If the timeout expires, the request is abandoned and the loop resumes retrying autonomously. Default is no timeout (wait forever).

**Requires** at least one `ALLOW_REQUEST` — the parser rejects `REQUEST_TIMEOUT` without it.

### Modifier Ordering

All step modifiers at indent level 2 must follow this order:

```
ALLOW_REQUEST* → NOTIFY? → REQUEST_TIMEOUT? → RETRY?
```

The parser enforces this ordering and rejects violations.

### WITH

Override the bin for a specific step:

```circuit
  RUN "implement feature" WITH claude
  EVAL "run benchmarks" WITH bench
    RETRY 5
```

The `WITH` value is resolved against aliases first — if it matches an alias name, the alias command is used. Otherwise it's treated as a literal command.

Resolution order: **WITH clause > RUN_BIN/EVAL_BIN default > hardcoded default**

```circuit
ALIAS claude "claude --dangerously-skip-permissions"
ALIAS aider "aider --model sonnet"
ALIAS eval_script "./eval.sh"
RUN_BIN claude

CIRCUIT mixed:
  RUN "scaffold the project"                # uses RUN_BIN (claude alias)
  RUN "optimize hot path" WITH aider        # uses aider alias
  EVAL "benchmark it" WITH eval_script      # uses eval_script alias
    RETRY 5
```

### RAW_RUN / RAW_EVAL

Skip prompt expansion entirely — pass the prompt verbatim to the bin:

```circuit
  RAW_RUN "exact command, no expansion" WITH claude
  RAW_EVAL "exact eval, no expansion" WITH verify
    RETRY 3
```

Useful for steps that call scripts or tools where the prompt engineer's expansion would be counterproductive.

### EXPAND

Take full control over prompt expansion with a custom model and optional domain focus:

```circuit
  EXPAND AS <model> FOR <prompt> [FOCUS <guidance>] INTO:
    RUN [WITH <bin>]
```

- **AS** — the model to use for expansion (overrides `PROMPT_ENGINEER_MODEL`)
- **FOR** — the prompt to expand
- **FOCUS** — optional domain-specific guidance injected into the expansion system prompt
- **INTO:** — opens a block containing the target RUN or EVAL

EXPAND works for both RUN and EVAL:

```circuit
  EXPAND AS "anthropic/claude-sonnet-4-6" \
    FOR "build the indexer" \
    FOCUS "optimize for write throughput, use memory-mapped files" \
    INTO:
    RUN WITH claude
  EXPAND AS "anthropic/claude-sonnet-4-6" \
    FOR "verify the indexer" \
    FOCUS "test with 1M documents, verify crash recovery" \
    INTO:
    EVAL WITH bench
    RETRY 8
```

FOCUS is optional — EXPAND without FOCUS just overrides the expansion model:

```circuit
  EXPAND AS "deepseek/deepseek-r1" FOR "build the query engine" INTO:
    RUN WITH claude
```

### Expansion Modes

Each step has one of three expansion modes:

| Mode | Syntax | Behavior |
|---|---|---|
| **auto** | `RUN` / `EVAL` | Default harness expansion via `PROMPT_ENGINEER_MODEL` |
| **raw** | `RAW_RUN` / `RAW_EVAL` | No expansion — prompt sent verbatim |
| **custom** | `EXPAND ... INTO:` | Custom model and optional FOCUS |

### FOCUS

FOCUS injects domain-specific priorities into the expansion system prompt as a structurally separate section. Unlike appending to the prompt, FOCUS:

- Sits at the system prompt level — won't get drowned out by iteration context
- Persists across retries with consistent authority
- Steers the expansion model's judgment, not just the content

```circuit
  EXPAND AS "anthropic/claude-sonnet-4-6" \
    FOR "optimize the compression algorithm" \
    FOCUS "target throughput over ratio, profile before changing, \
      use SIMD intrinsics where available, benchmark against zstd" \
    INTO:
    RUN WITH claude
```

FOCUS requires EXPAND. EXPAND does not require FOCUS.

### Linter Checks

The parser catches these errors at parse time:

- `EXPAND INTO: RAW_RUN` / `EXPAND INTO: RAW_EVAL` — contradictory (EXPAND already handles expansion)
- `RETRY` with no preceding `EVAL` at the same indent level
- `EXPAND` without `AS`, `FOR`, or `INTO:`
- `EVAL` without a preceding `RUN`
- `ALLOW_REQUEST` after `RETRY` — must come before
- `ALLOW_REQUEST` with no preceding `RUN` or `EVAL`
- `NOTIFY` without `ALLOW_REQUEST` — requires at least one
- `NOTIFY` after `RETRY` — must come before
- `REQUEST_TIMEOUT` without `ALLOW_REQUEST` — requires at least one
- `REQUEST_TIMEOUT` after `RETRY` — must come before

### RUN without EVAL

A RUN with no following EVAL is fire-and-forget — it executes once with no evaluation. Useful for setup:

```circuit
CIRCUIT with-setup:
  RUN Initialize the project with cargo init
  RUN Implement the algorithm
  EVAL Does it compile and pass tests?
    RETRY 5
```

## Multi-Step Circuits

Steps execute sequentially. If a step exhausts retries, the circuit aborts.

```circuit
CIRCUIT two-phase:
  RUN Build the feature
  EVAL Does it work correctly?
    RETRY 5
  RUN Optimize for performance
  EVAL Is it faster than the baseline?
    RETRY 10
```

## The Harness (Prompt Expansion)

This is what makes Circuit work. You write:

```circuit
  RUN Build a compression algorithm in rust
```

But what actually gets sent to `RUN_BIN` is a rich prompt expanded by the prompt engineer model, including:

- **Goal** — the CIRCUIT name, re-injected every iteration to prevent drift
- **Your prompt** — the task description you wrote
- **Iteration state** — "attempt 3 of 10, 7 retries remaining"
- **EVAL feedback** — what the evaluator said was wrong (on retries)
- **Scratchpad** — key-value store the agent can write to across iterations
- **Working directory state** — what files exist, what changed since last iteration
- **Environment** — OS, shell, working directory, date
- **Execution history** — compressed log of all previous iterations
- **Step context** — summary of previous steps (for multi-step circuits)
- **ALLOW_REQUEST conditions** — what the engineer is permitted to request user input for

The prompt engineer model weaves all of this into a single coherent prompt. It's not a rigid template — it adapts based on context, emphasizing different things on iteration 1 vs iteration 8.

## Scratchpad

Both the AI agents and the prompt engineer maintain scratchpads — key-value stores that persist across iterations.

**Agent scratchpad** — the RUN/EVAL bins can write to it:
```
<scratchpad_set key="best_ratio">94.2%</scratchpad_set>
```

**Engineer scratchpad** — the prompt engineer tracks its own observations:
```
<engineer_scratchpad_set key="note">agent responds better to structured prompts</engineer_scratchpad_set>
```

**User input via ALLOW_REQUEST** — when the prompt engineer requests user input, the response is stored in the agent scratchpad under the key specified in the request. Both the agent and the prompt engineer can see it on subsequent iterations.

## Line Continuation

Long prompts can span multiple lines with `\`:

```circuit
  RUN Build a compression algorithm in rust \
    and validate its compression ratios. \
    Our goal is ratio over 99%.
```

## Variable Interpolation

Use `${VAR}` to reference environment variables:

```circuit
API_KEY ${OPENROUTER_API_KEY}
DIR ${HOME}/projects/myproject
```

## Comments

```circuit
# Full-line comment
PROVIDER Openrouter # Inline comment
RUN "Make a program that prints # symbols" # Quoted strings preserve #
```

## Indentation

Both 2-space and tab indentation are accepted. Pick one and be consistent within a file.

```circuit
# 2-space style
CIRCUIT example:
  RUN do something
  EVAL check it
    RETRY 5

# Tab style
CIRCUIT example:
	RUN do something
	EVAL check it
		RETRY 5
```

## CLI Usage

```bash
# Run a circuit
circuit myfile.circuit

# Dry run — parse and validate without executing
circuit myfile.circuit --dry-run

# Verbose — show expanded prompts and BIN output
circuit myfile.circuit -v

# Run only step 2
circuit myfile.circuit --step 2

# Override API key
circuit myfile.circuit --api-key sk-or-xxx

# Debug mode
circuit myfile.circuit --debug
```

### Exit Codes

| Code | Meaning |
|---|---|
| 0 | Circuit completed, all steps passed |
| 1 | Circuit failed (a step exhausted retries) |
| 2 | Parse error in `.circuit` file |
| 3 | Configuration error |
| 4 | BIN not found |
| 130 | Interrupted (Ctrl-C) |

## Logs

Every circuit run produces a JSONL log file in `LOG_DIR` (default `.circuit-runs/`). Each line is a JSON event:

- `circuit_start` — config and step definitions
- `step_start` — which step is beginning
- `iteration` — full details: expanded prompts, BIN output, verdict, feedback, scratchpad, diffs
- `step_end` — success/failure and total iterations
- `circuit_end` — overall result and duration

The prompt engineer has read access to the full execution history, enabling it to identify patterns and craft better prompts over time.

## Environment Variables

| Variable | Maps to |
|---|---|
| `OPENROUTER_API_KEY` | `API_KEY` |
| `OPENROUTER_API_URL` | `API_URL` |
| `CIRCUIT_PROVIDER` | `PROVIDER` |
| `CIRCUIT_API_KEY` | `API_KEY` |
| `CIRCUIT_API_URL` | `API_URL` |
| `CIRCUIT_PROMPT_ENGINEER_MODEL` | `PROMPT_ENGINEER_MODEL` |
| `CIRCUIT_RUN_BIN` | `RUN_BIN` |
| `CIRCUIT_EVAL_BIN` | `EVAL_BIN` |
| `CIRCUIT_DIR` | `DIR` |
| `CIRCUIT_LOG_DIR` | `LOG_DIR` |
| `CIRCUIT_TIMEOUT` | `TIMEOUT` |

Environment variables are overridden by `.circuit` file defines, which are overridden by CLI flags.

## Error Handling

| Tier | What happens |
|---|---|
| **Fatal** (auth failure, parse error, BIN not found) | Circuit aborts immediately |
| **Transient** (rate limit, BIN timeout) | Exponential backoff, retry up to 3x |
| **Recoverable** (provider error, missing verdict tag) | Graceful degradation, continue |

## Session Persistence

RUN and EVAL sessions persist across retries within a step. The agent accumulates context — it remembers what it already tried. For the Claude CLI, this uses `--session-id`. For other BINs, the full context is included in each expanded prompt.

## Example: Sorting Algorithm

```circuit
PROVIDER Openrouter
API_KEY ${OPENROUTER_API_KEY}
PROMPT_ENGINEER_MODEL anthropic/claude-sonnet-4-6
RUN_BIN claude --dangerously-skip-permissions --effort max
DIR ~/circuitsort
CHECKPOINT on

CIRCUIT Build a sorting algorithm that beats std lib sort:
  RUN Create a novel sorting algorithm in Rust that outperforms \
    the standard library sort on real-world data distributions. \
    Build a comprehensive benchmark suite testing arrays of sizes \
    100, 10000, and 1000000 across multiple distributions. \
    The algorithm must be faster on at least 80% of cases.
  EVAL Run the benchmarks and verify the custom sort beats std sort \
    on 80%+ of cases. Verify correctness on edge cases.
    RETRY 10
```

## Example: Full-Featured Circuit

```circuit
PROVIDER Openrouter
API_KEY ${OPENROUTER_API_KEY}
PROMPT_ENGINEER_MODEL anthropic/claude-sonnet-4-6
ALIAS claude "claude --dangerously-skip-permissions"
ALIAS aider "aider --model sonnet"
ALIAS bench "./bench.sh"
RUN_BIN claude
EVAL_BIN claude
DIR ~/my-project
CHECKPOINT on
TIMEOUT 300

CIRCUIT Deploy a Cloudflare worker:
  # Step 1: scaffold (fire-and-forget)
  RUN Initialize the project with wrangler

  # Step 2: build with a different tool
  RUN "implement the API proxy logic" WITH aider
  EVAL "does it type-check and pass unit tests?"
    RETRY 5

  # Step 3: integration test with custom expansion
  EXPAND AS "deepseek/deepseek-r1" \
    FOR "write integration tests for the proxy" \
    FOCUS "test edge cases: timeouts, malformed headers, large payloads" \
    INTO:
    RUN WITH claude
  EVAL "all integration tests pass"
    RETRY 3

  # Step 4: deploy — may need credentials from user
  RUN Deploy the worker to Cloudflare
    ALLOW_REQUEST "an API token is required"
    ALLOW_REQUEST "the account ID is needed"
    NOTIFY ./notify.sh
    REQUEST_TIMEOUT 600
  EVAL Verify the worker is live and responding
    ALLOW_REQUEST "DNS verification requires manual input"
    RETRY 5

  # Step 5: benchmark with a script, no expansion needed
  RAW_RUN "wrk -t12 -c400 -d30s https://my-worker.dev" WITH bench
  RAW_EVAL "./check-latency.sh --p99 50ms" WITH bench
    RETRY 2
```

## Local Models

Point `API_URL` at a local endpoint for running with local models:

```circuit
API_URL http://localhost:11434/v1
PROMPT_ENGINEER_MODEL llama3.2
```

Any OpenRouter-compatible API works.
