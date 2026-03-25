import type {
  Alias,
  CircuitAST,
  CircuitBlock,
  Define,
  EvalStep,
  ExpansionMode,
  RunStep,
  Step,
  Token,
} from "./types.ts";
import { ParseError } from "./errors.ts";
import { tokenize } from "./lexer.ts";

/** Token types that start the "run" part of a step. */
const RUN_STARTERS = new Set(["RUN", "RAW_RUN"]);

/** Token types that start the "eval" part of a step. */
const EVAL_STARTERS = new Set(["EVAL", "RAW_EVAL"]);

/**
 * Parse a .circuit source string into a CircuitAST.
 */
export function parse(source: string): CircuitAST {
  const tokens = tokenize(source);
  const ast: CircuitAST = { defines: [], aliases: [], circuits: [] };
  let i = 0;

  // Parse defines and aliases (all DEFINE/ALIAS tokens before first CIRCUIT_DECL)
  while (
    i < tokens.length &&
    (tokens[i]!.type === "DEFINE" || tokens[i]!.type === "ALIAS")
  ) {
    const tok = tokens[i]!;
    if (tok.type === "ALIAS") {
      ast.aliases.push({
        name: tok.value,
        command: tok.secondaryValue ?? "",
        line: tok.line,
      });
    } else {
      ast.defines.push({
        key: tok.value,
        value: tok.secondaryValue ?? "",
        line: tok.line,
      });
    }
    i++;
  }

  // Parse circuit blocks
  while (i < tokens.length) {
    if (tokens[i]!.type !== "CIRCUIT_DECL") {
      throw new ParseError(
        `Expected CIRCUIT declaration, got ${tokens[i]!.type}: ${tokens[i]!.value}`,
        tokens[i]!.line,
      );
    }

    const circuitTok = tokens[i]!;
    const circuit: CircuitBlock = {
      name: circuitTok.value,
      steps: [],
      line: circuitTok.line,
    };
    i++;

    // Parse steps inside this circuit
    while (i < tokens.length && tokens[i]!.type !== "CIRCUIT_DECL") {
      // ── Parse run-like part ──
      let run: RunStep;
      const tok = tokens[i]!;

      if (RUN_STARTERS.has(tok.type)) {
        // Plain RUN or RAW_RUN
        run = {
          prompt: tok.value,
          ...(tok.secondaryValue ? { bin: tok.secondaryValue } : {}),
          expansion: tok.type === "RAW_RUN" ? "raw" : "auto",
          line: tok.line,
        };
        i++;
      } else if (tok.type === "EXPAND") {
        // EXPAND ... INTO: <target>
        const { run: expandRun, newI } = parseExpandIntoRun(tokens, i);
        run = expandRun;
        i = newI;
      } else if (tok.type === "RETRY") {
        throw new ParseError(
          "RETRY has no preceding EVAL at the same indentation level",
          tok.line,
        );
      } else if (tok.type === "ALLOW_REQUEST") {
        throw new ParseError(
          "ALLOW_REQUEST has no preceding RUN or EVAL",
          tok.line,
        );
      } else if (EVAL_STARTERS.has(tok.type)) {
        throw new ParseError(
          `${tok.type} without preceding RUN — every step must start with a RUN`,
          tok.line,
        );
      } else {
        throw new ParseError(
          `Expected RUN, RAW_RUN, or EXPAND inside CIRCUIT, got ${tok.type}: ${tok.value}`,
          tok.line,
        );
      }

      // ── Consume RUN modifiers: ALLOW_REQUEST* → NOTIFY? → REQUEST_TIMEOUT? ──
      const runMods = consumeRequestModifiers(tokens, i);
      if (runMods.allowRequests.length > 0) {
        run.allowRequests = runMods.allowRequests;
      }
      if (runMods.notify) run.notify = runMods.notify;
      if (runMods.requestTimeout) run.requestTimeout = runMods.requestTimeout;
      i = runMods.newI;

      // ── Parse eval-like part (optional) ──
      let evalStep: EvalStep | null = null;

      if (i < tokens.length) {
        const nextTok = tokens[i]!;

        if (EVAL_STARTERS.has(nextTok.type)) {
          // Plain EVAL or RAW_EVAL
          const result = parseEvalWithRetry(tokens, i, nextTok.type === "RAW_EVAL" ? "raw" : "auto");
          evalStep = result.eval;
          i = result.newI;
        } else if (nextTok.type === "EXPAND" && isExpandTargetingEval(tokens, i)) {
          // EXPAND ... INTO: <eval target>
          const result = parseExpandIntoEval(tokens, i);
          evalStep = result.eval;
          i = result.newI;
        }
      }

      circuit.steps.push({ run, eval: evalStep });
    }

    if (circuit.steps.length === 0) {
      throw new ParseError(
        `CIRCUIT '${circuit.name}' has no steps`,
        circuit.line,
      );
    }

    ast.circuits.push(circuit);
  }

  // Validation
  if (ast.circuits.length === 0) {
    throw new ParseError(
      "No CIRCUIT blocks found",
      tokens.length > 0 ? tokens[tokens.length - 1]!.line : 1,
    );
  }

  return ast;
}

// ── Helpers ──

/**
 * Parse EXPAND token followed by INTO: block targeting RUN.
 * Validates linter rules (no RAW_RUN inside EXPAND).
 */
function parseExpandIntoRun(
  tokens: Token[],
  i: number,
): { run: RunStep; newI: number } {
  const expandTok = tokens[i]!;
  const targetTok = tokens[i + 1];

  if (!targetTok) {
    throw new ParseError(
      "EXPAND INTO: block is empty — expected RUN or EVAL",
      expandTok.line,
    );
  }

  // Check if target is actually an eval — this EXPAND isn't starting a step
  if (EVAL_STARTERS.has(targetTok.type)) {
    throw new ParseError(
      `Expected RUN after EXPAND INTO:, got ${targetTok.type} — EVAL must follow a RUN step`,
      targetTok.line,
    );
  }

  if (targetTok.type === "RAW_RUN") {
    throw new ParseError(
      "Cannot use RAW_RUN inside EXPAND INTO: block — EXPAND already handles expansion",
      targetTok.line,
    );
  }

  if (targetTok.type !== "RUN" || targetTok.value !== "") {
    throw new ParseError(
      `Expected RUN [WITH <bin>] in INTO: block (no prompt), got ${targetTok.type}: ${targetTok.value}`,
      targetTok.line,
    );
  }

  const expansion: ExpansionMode = {
    model: expandTok.expandModel!,
    ...(expandTok.expandFocus ? { focus: expandTok.expandFocus } : {}),
  };

  return {
    run: {
      prompt: expandTok.value, // FOR prompt
      ...(targetTok.secondaryValue ? { bin: targetTok.secondaryValue } : {}),
      expansion,
      line: expandTok.line,
    },
    newI: i + 2,
  };
}

/**
 * Parse EXPAND token followed by INTO: block targeting EVAL.
 * Validates linter rules (no RAW_EVAL inside EXPAND).
 */
function parseExpandIntoEval(
  tokens: Token[],
  i: number,
): { eval: EvalStep; newI: number } {
  const expandTok = tokens[i]!;
  const targetTok = tokens[i + 1];

  if (!targetTok) {
    throw new ParseError(
      "EXPAND INTO: block is empty — expected RUN or EVAL",
      expandTok.line,
    );
  }

  if (RUN_STARTERS.has(targetTok.type)) {
    // This EXPAND targets RUN, not EVAL — shouldn't be called here.
    // The caller should have used parseExpandIntoRun instead.
    throw new ParseError(
      "Expected EVAL in EXPAND INTO: block, got RUN — this EXPAND starts a new step",
      targetTok.line,
    );
  }

  if (targetTok.type === "RAW_EVAL") {
    throw new ParseError(
      "Cannot use RAW_EVAL inside EXPAND INTO: block — EXPAND already handles expansion",
      targetTok.line,
    );
  }

  if (targetTok.type !== "EVAL" || targetTok.value !== "") {
    throw new ParseError(
      `Expected EVAL [WITH <bin>] in INTO: block (no prompt), got ${targetTok.type}: ${targetTok.value}`,
      targetTok.line,
    );
  }

  const expansion: ExpansionMode = {
    model: expandTok.expandModel!,
    ...(expandTok.expandFocus ? { focus: expandTok.expandFocus } : {}),
  };

  let newI = i + 2;

  // Consume modifiers: ALLOW_REQUEST* → NOTIFY? → REQUEST_TIMEOUT?
  const mods = consumeRequestModifiers(tokens, newI);
  newI = mods.newI;

  let retry = 3;
  if (newI < tokens.length && tokens[newI]!.type === "RETRY") {
    retry = parseInt(tokens[newI]!.value, 10);
    newI++;
  }

  // Enforce: no modifiers after RETRY
  enforceNoModifiersAfterRetry(tokens, newI);

  return {
    eval: {
      prompt: expandTok.value, // FOR prompt
      retry,
      ...(targetTok.secondaryValue ? { bin: targetTok.secondaryValue } : {}),
      expansion,
      ...(mods.allowRequests.length > 0 ? { allowRequests: mods.allowRequests } : {}),
      ...(mods.notify ? { notify: mods.notify } : {}),
      ...(mods.requestTimeout ? { requestTimeout: mods.requestTimeout } : {}),
      line: expandTok.line,
    },
    newI,
  };
}

/**
 * Check if an EXPAND token at position i targets EVAL (by peeking at the INTO: block).
 */
function isExpandTargetingEval(tokens: Token[], i: number): boolean {
  const targetTok = tokens[i + 1];
  return !!targetTok && (EVAL_STARTERS.has(targetTok.type) || targetTok.type === "EVAL");
}

/**
 * Parse a plain EVAL/RAW_EVAL token with optional RETRY.
 * Returns the EvalStep with a temporary _nextI for the caller.
 */
function parseEvalWithRetry(
  tokens: Token[],
  i: number,
  expansion: "auto" | "raw",
): { eval: EvalStep; newI: number } {
  const evalTok = tokens[i]!;
  let newI = i + 1;

  // Consume modifiers: ALLOW_REQUEST* → NOTIFY? → REQUEST_TIMEOUT?
  const mods = consumeRequestModifiers(tokens, newI);
  newI = mods.newI;

  let retry = 3;
  if (newI < tokens.length && tokens[newI]!.type === "RETRY") {
    retry = parseInt(tokens[newI]!.value, 10);
    newI++;
  }

  // Enforce: no modifiers after RETRY
  enforceNoModifiersAfterRetry(tokens, newI);

  return {
    eval: {
      prompt: evalTok.value,
      retry,
      ...(evalTok.secondaryValue ? { bin: evalTok.secondaryValue } : {}),
      expansion,
      ...(mods.allowRequests.length > 0 ? { allowRequests: mods.allowRequests } : {}),
      ...(mods.notify ? { notify: mods.notify } : {}),
      ...(mods.requestTimeout ? { requestTimeout: mods.requestTimeout } : {}),
      line: evalTok.line,
    },
    newI,
  };
}

/**
 * Consume request-related modifiers in order: ALLOW_REQUEST* → NOTIFY? → REQUEST_TIMEOUT?
 * Enforces ordering and validates that NOTIFY/REQUEST_TIMEOUT require ALLOW_REQUEST.
 */
function consumeRequestModifiers(
  tokens: Token[],
  i: number,
): { allowRequests: string[]; notify: string | null; requestTimeout: number | null; newI: number } {
  const allowRequests: string[] = [];
  let notify: string | null = null;
  let requestTimeout: number | null = null;
  let newI = i;

  // ALLOW_REQUEST*
  while (newI < tokens.length && tokens[newI]!.type === "ALLOW_REQUEST") {
    allowRequests.push(tokens[newI]!.value);
    newI++;
  }

  // NOTIFY?
  if (newI < tokens.length && tokens[newI]!.type === "NOTIFY") {
    if (allowRequests.length === 0) {
      throw new ParseError(
        "NOTIFY requires at least one ALLOW_REQUEST",
        tokens[newI]!.line,
      );
    }
    notify = tokens[newI]!.value;
    newI++;
  }

  // REQUEST_TIMEOUT?
  if (newI < tokens.length && tokens[newI]!.type === "REQUEST_TIMEOUT") {
    if (allowRequests.length === 0) {
      throw new ParseError(
        "REQUEST_TIMEOUT requires at least one ALLOW_REQUEST",
        tokens[newI]!.line,
      );
    }
    requestTimeout = parseInt(tokens[newI]!.value, 10);
    newI++;
  }

  return { allowRequests, notify, requestTimeout, newI };
}

/**
 * Enforce that no request modifiers appear after RETRY.
 */
function enforceNoModifiersAfterRetry(tokens: Token[], i: number): void {
  if (i >= tokens.length) return;
  const t = tokens[i]!.type;
  if (t === "ALLOW_REQUEST" || t === "NOTIFY" || t === "REQUEST_TIMEOUT") {
    throw new ParseError(
      `${t} must come before RETRY`,
      tokens[i]!.line,
    );
  }
}

/**
 * Interpolate ${VAR} references in a string using a lookup map.
 * Unknown variables are left as-is with a warning logged.
 */
export function interpolate(
  value: string,
  vars: Record<string, string>,
  warnings: string[] = [],
): string {
  return value.replace(/\$\{(\w+)\}/g, (match, varName: string) => {
    if (varName in vars) {
      return vars[varName]!;
    }
    warnings.push(`Unknown variable: ${varName}`);
    return match;
  });
}
