# Circuit Language Reference

Formal specification for the `.circuit` file format.

## Grammar

A `.circuit` file consists of an optional **header** (defines and aliases) followed by one or more **CIRCUIT blocks**.

```
file        = header* circuit+
header      = define | alias
define      = KEYWORD value
alias       = "ALIAS" name command
circuit     = "CIRCUIT" name ":" step+
step        = run_part [eval_part]
run_part    = (run | raw_run | expand_into_run) run_mods*
eval_part   = (eval | raw_eval | expand_into_eval) eval_mods* ["RETRY" N]
run_mods    = "ALLOW_REQUEST" condition
            | "NOTIFY" command
            | "REQUEST_TIMEOUT" seconds
eval_mods   = "ALLOW_REQUEST" condition
            | "NOTIFY" command
            | "REQUEST_TIMEOUT" seconds
```

## Indentation Levels

| Level | Contains |
|---|---|
| 0 | Defines, aliases, `CIRCUIT` declarations |
| 1 | `RUN`, `RAW_RUN`, `EVAL`, `RAW_EVAL`, `EXPAND` |
| 2 | `RETRY`, `ALLOW_REQUEST`, `NOTIFY`, `REQUEST_TIMEOUT`, `INTO:` block targets |

Both 2-space and tab indentation are accepted. Mixed tabs and spaces on the same line is a parse error. Odd-numbered space indentation is a parse error.

## Keywords

### Level 0 — Defines

```
PROVIDER <value>
API_KEY <value>
API_URL <value>
PROMPT_ENGINEER_MODEL <value>
RUN_BIN <value>
EVAL_BIN <value>
DIR <value>
LOG_DIR <value>
CHECKPOINT <on|off>
TIMEOUT <seconds>
```

All defines are key-value pairs. Values support `${VAR}` interpolation from environment variables. Values may be quoted (`"value"`) or unquoted.

| Key | Required | Default | Description |
|---|---|---|---|
| `PROVIDER` | No | `openrouter` | API provider |
| `API_KEY` | Yes* | `$OPENROUTER_API_KEY` | API key |
| `API_URL` | No | `https://openrouter.ai/api/v1` | API base URL |
| `PROMPT_ENGINEER_MODEL` | No | `anthropic/claude-sonnet-4-6` | Expansion model |
| `RUN_BIN` | Yes | — | Command for RUN steps |
| `EVAL_BIN` | No | same as `RUN_BIN` | Command for EVAL steps |
| `DIR` | No | `.` | Working directory |
| `LOG_DIR` | No | `.circuit-runs` | Log output directory |
| `CHECKPOINT` | No | `off` | Git snapshot per iteration |
| `TIMEOUT` | No | `0` | Per-step timeout (0 = none) |

Config resolution: **CLI flags > .circuit defines > environment variables > defaults**

### Level 0 — ALIAS

```
ALIAS <name> <command>
```

Defines a named shortcut for a bin command. Referenced by `RUN_BIN`, `EVAL_BIN`, and `WITH` clauses. If a value matches an alias name, the alias command is substituted.

```circuit
ALIAS claude "claude --dangerously-skip-permissions"
ALIAS bench "./bench.sh"
RUN_BIN claude           # resolves to "claude --dangerously-skip-permissions"
```

### Level 0 — CIRCUIT

```
CIRCUIT <name>:
```

Declares a named circuit block. The colon is required. Contains one or more steps at indent level 1. Multiple CIRCUIT blocks are allowed per file.

### Level 1 — RUN

```
RUN <prompt>
RUN <prompt> WITH <bin>
```

Executes a task. Prompt is expanded by the prompt engineer model before being sent to the bin. `WITH` overrides the default `RUN_BIN` for this step.

### Level 1 — EVAL

```
EVAL <prompt>
EVAL <prompt> WITH <bin>
```

Evaluates the preceding RUN's output. Must follow a RUN. The bin must output a verdict tag:

```
<verdict>SUCCESS</verdict>
<verdict>FAILURE</verdict>
```

No verdict tag defaults to FAILURE. The full EVAL output becomes feedback for the next retry.

### Level 1 — RAW_RUN / RAW_EVAL

```
RAW_RUN <prompt>
RAW_RUN <prompt> WITH <bin>
RAW_EVAL <prompt>
RAW_EVAL <prompt> WITH <bin>
```

Same as RUN/EVAL but skips prompt expansion entirely. The prompt is passed verbatim to the bin.

### Level 1 — EXPAND

```
EXPAND AS <model> FOR <prompt> [FOCUS <guidance>] INTO:
```

Custom prompt expansion. Must be followed by an `INTO:` block at level 2 containing a target `RUN` or `EVAL`.

| Clause | Required | Description |
|---|---|---|
| `AS` | Yes | Model for expansion (overrides `PROMPT_ENGINEER_MODEL`) |
| `FOR` | Yes | The prompt to expand |
| `FOCUS` | No | Domain guidance injected into the expansion system prompt |
| `INTO:` | Yes | Opens the target block |

```circuit
EXPAND AS "anthropic/claude-sonnet-4-6" \
  FOR "build the indexer" \
  FOCUS "optimize for write throughput" \
  INTO:
  RUN WITH claude
```

EXPAND targets at level 2 have no prompt (it lives on `FOR`):

```
RUN [WITH <bin>]
EVAL [WITH <bin>]
```

### Level 2 — RETRY

```
RETRY <N>
```

Maximum retries for the RUN/EVAL loop. Total attempts = N + 1. Default is 3 if omitted. Must be nested under EVAL. Must come after all other modifiers.

### Level 2 — ALLOW_REQUEST

```
ALLOW_REQUEST <condition>
```

Permission gate for human-in-the-loop input. Declares a condition under which the prompt engineer may pause execution and request user input. Multiple allowed per step. Without ALLOW_REQUEST, the circuit is fully autonomous.

- Nested under RUN or EVAL
- Must come before NOTIFY, REQUEST_TIMEOUT, and RETRY
- User input is stored in the scratchpad
- Does not consume a retry

### Level 2 — NOTIFY

```
NOTIFY <command>
```

Fires a bin command when user input is requested. Fire-and-forget — exit code is ignored. **Requires** at least one ALLOW_REQUEST.

Environment variables injected into the notify process:

| Variable | Value |
|---|---|
| `CIRCUIT_REQUEST_REASON` | Matched ALLOW_REQUEST condition |
| `CIRCUIT_REQUEST_MESSAGE` | Prompt engineer's message to user |
| `CIRCUIT_REQUEST_KEY` | Scratchpad key for the response |
| `CIRCUIT_NAME` | Circuit name |
| `CIRCUIT_STEP` | Step number (1-indexed) |

### Level 2 — REQUEST_TIMEOUT

```
REQUEST_TIMEOUT <seconds>
```

How long to wait for user input. If exceeded, the request is abandoned and retrying resumes. Default is no timeout (wait forever). **Requires** at least one ALLOW_REQUEST.

## Modifier Ordering

Level 2 modifiers must follow this order:

```
ALLOW_REQUEST* → NOTIFY? → REQUEST_TIMEOUT? → RETRY?
```

`*` = zero or more, `?` = zero or one. The parser rejects violations.

## Expansion Modes

Only RUN steps are expanded by the prompt engineer. EVAL always receives the prompt verbatim — no engineer touch, no model call.

| Mode | Syntax | Behavior |
|---|---|---|
| auto | `RUN` | Expanded by `PROMPT_ENGINEER_MODEL` |
| raw | `RAW_RUN` | No expansion — verbatim |
| custom | `EXPAND ... INTO: RUN` | Expanded by specified model with optional FOCUS |
| — | `EVAL` / `RAW_EVAL` | No expansion — prompt goes verbatim to bin |
| — | `EXPAND ... INTO: EVAL` | Prompt goes verbatim (FOR/FOCUS/AS are accepted but ignored) |

## WITH Clause

```
RUN <prompt> WITH <bin>
EVAL <prompt> WITH <bin>
```

Overrides the default bin for a single step. The value is resolved against aliases first.

Resolution order: **WITH > RUN_BIN/EVAL_BIN > default**

Splits on the last ` WITH ` (uppercase, space-delimited) to avoid conflicts with lowercase "with" in prompts.

## Line Continuation

Backslash (`\`) at end of line joins with the next line:

```circuit
RUN Build a compression algorithm \
  that beats zstd on throughput
```

Becomes a single logical line. Leading whitespace on continuation lines is trimmed.

## Variable Interpolation

```
${VAR_NAME}
```

Replaced with the environment variable value. Unknown variables are left as-is with a warning.

## Comments

```circuit
# Full-line comment
PROVIDER Openrouter  # Inline comment
RUN "prints # symbols"  # Quoted # preserved
```

`#` outside of double quotes starts a comment. Everything after it on that line is ignored.

## Quoting

Double quotes are optional for values. When present, they are stripped. Quotes preserve `#` characters and `WITH` keywords inside prompts.

```circuit
RUN "deploy with care"           # WITH not treated as clause
RUN deploy with care             # "with care" is part of prompt (lowercase)
RUN "test it" WITH bench         # WITH is a clause (uppercase after quotes)
```

## Scratchpad

Key-value store persisted across iterations within a step.

**Agent writes** (in BIN output):
```
<scratchpad_set key="name">value</scratchpad_set>
```

**Engineer writes** (in expansion output):
```
<engineer_scratchpad_set key="name">value</engineer_scratchpad_set>
```

**User input** from ALLOW_REQUEST is stored under the key specified in the engineer's `<request_input>` tag.

## Verdict Protocol

EVAL bins must output exactly one verdict tag:

```
<verdict>SUCCESS</verdict>
<verdict>FAILURE</verdict>
```

- Case-insensitive matching
- No tag found = FAILURE (safe default)
- Full EVAL output becomes feedback for the next RUN retry

## Request Input Protocol

When ALLOW_REQUEST conditions are present, the prompt engineer may emit:

```
<request_input key="descriptive_key" reason="matching condition">
Message to the user explaining what is needed
</request_input>
```

The engine:
1. Validates that ALLOW_REQUEST conditions exist on the step
2. Fires NOTIFY bin if configured (fire-and-forget)
3. Prompts user on stdin
4. Stores response in scratchpad under the specified key
5. Re-expands the prompt with updated scratchpad context

## Session Persistence

RUN and EVAL sessions persist across retries within a step. For Claude CLI, this uses `--session-id`. For other bins, full context is included in each expanded prompt.

## Execution Model

1. Steps execute sequentially within a CIRCUIT block
2. Each step: expand RUN prompt → execute RUN bin → execute EVAL bin (no expansion) → parse verdict
3. On FAILURE: feed EVAL output back as feedback, retry (up to RETRY limit)
4. On SUCCESS: advance to next step
5. If retries exhausted: circuit aborts
6. RUN without EVAL: fire-and-forget (executes once, no evaluation)

## Error Tiers

| Tier | Examples | Behavior |
|---|---|---|
| Fatal | Auth failure, parse error, BIN not found | Abort immediately |
| Transient | Rate limit, BIN timeout | Backoff and retry (up to 3x) |
| Recoverable | Provider error, missing verdict | Graceful degradation |

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

## CLI

```
circuit <file> [options]

Options:
  --dry-run          Parse and validate without executing
  -v, --verbose      Show expanded prompts and BIN output
  --debug            Full tracebacks, raw API bodies, stream parsing
  --raw              Dump all raw request/response bodies
  --step <N>         Run only step N (1-indexed)
  --api-key <key>    Override API_KEY
  --log-dir <dir>    Override LOG_DIR
  --resume <runId>   Resume from JSONL log

Exit codes:
  0    All steps passed
  1    Step exhausted retries
  2    Parse error
  3    Config error
  4    BIN not found
  130  Interrupted (Ctrl-C)
```

## Linter Rules

Parse-time errors:

| Error | Cause |
|---|---|
| `EXPAND INTO: RAW_RUN` | Contradictory — EXPAND handles expansion |
| `EXPAND INTO: RAW_EVAL` | Contradictory — EXPAND handles expansion |
| `RETRY` without `EVAL` | RETRY must be nested under EVAL |
| `EVAL` without `RUN` | Every step starts with RUN |
| `EXPAND` missing `AS`/`FOR`/`INTO:` | Incomplete EXPAND clause |
| `ALLOW_REQUEST` after `RETRY` | Must come before |
| `ALLOW_REQUEST` without `RUN`/`EVAL` | No parent to attach to |
| `NOTIFY` without `ALLOW_REQUEST` | Requires permission gate |
| `NOTIFY` after `RETRY` | Must come before |
| `REQUEST_TIMEOUT` without `ALLOW_REQUEST` | Requires permission gate |
| `REQUEST_TIMEOUT` after `RETRY` | Must come before |
| Mixed tabs and spaces | Pick one per line |
| Odd space indentation | Must be multiples of 2 |
| Empty CIRCUIT block | At least one step required |

## JSONL Log Events

Every run produces a log in `LOG_DIR`:

| Event | Fields |
|---|---|
| `circuit_start` | config, step definitions |
| `step_start` | step index, prompts |
| `iteration` | expanded prompts, BIN output, verdict, feedback, scratchpad, diffs |
| `step_end` | success/failure, iteration count |
| `circuit_end` | overall result, duration, steps completed |
