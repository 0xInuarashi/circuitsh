# Circuit Language Guide

Circuit is a language for AI orchestration. It plugs AI agents together in eval-retry loops — you describe what to build, what success looks like, and Circuit handles the rest.

## How It Works

A `.circuit` file defines a **circuit**: a series of steps where an AI agent does work (`RUN`), another evaluates it (`EVAL`), and if evaluation fails, the loop retries with feedback until it passes or retries run out.

```
RUN → EVAL → pass? → next step
              ↓ fail
           feedback → RUN (retry)
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
| `DIR` | No | `.` | Working directory (created if it doesn't exist) |
| `LOG_DIR` | No | `.circuit-runs/` | Where JSONL run logs are saved |
| `CHECKPOINT` | No | `off` | Git snapshot before each iteration (`on`/`off`) |
| `TIMEOUT` | No | `0` | Per-step timeout in seconds (0 = no limit) |

Config priority: **CLI flags > .circuit defines > environment variables > defaults**

## Step Directives

### RUN

```circuit
  RUN <prompt>
```

Executes a task. The prompt is a terse, human-written description — the runtime's prompt engineer model expands it into a rich, context-aware prompt before sending it to `RUN_BIN`.

### EVAL

```circuit
  EVAL <prompt>
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

## Local Models

Point `API_URL` at a local endpoint for running with local models:

```circuit
API_URL http://localhost:11434/v1
PROMPT_ENGINEER_MODEL llama3.2
```

Any OpenRouter-compatible API works.
