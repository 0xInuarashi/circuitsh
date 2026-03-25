import type {
  Alias,
  CircuitAST,
  CircuitBlock,
  Define,
  EvalStep,
  RunStep,
  Step,
  Token,
} from "./types.ts";
import { ParseError } from "./errors.ts";
import { tokenize } from "./lexer.ts";

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
      if (tokens[i]!.type !== "RUN") {
        throw new ParseError(
          `Expected RUN inside CIRCUIT, got ${tokens[i]!.type}: ${tokens[i]!.value}`,
          tokens[i]!.line,
        );
      }

      const runTok = tokens[i]!;
      const run: RunStep = {
        prompt: runTok.value,
        ...(runTok.secondaryValue ? { bin: runTok.secondaryValue } : {}),
        line: runTok.line,
      };
      i++;

      // Check if next token is EVAL
      let evalStep: EvalStep | null = null;
      if (i < tokens.length && tokens[i]!.type === "EVAL") {
        const evalTok = tokens[i]!;
        let retry = 3; // default
        i++;

        // Check for RETRY
        if (i < tokens.length && tokens[i]!.type === "RETRY") {
          retry = parseInt(tokens[i]!.value, 10);
          i++;
        }

        evalStep = {
          prompt: evalTok.value,
          retry,
          ...(evalTok.secondaryValue ? { bin: evalTok.secondaryValue } : {}),
          line: evalTok.line,
        };
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
