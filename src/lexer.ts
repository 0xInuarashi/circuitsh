import type { Token, TokenType } from "./types.ts";
import { ParseError } from "./errors.ts";

const DEFINE_KEYWORDS = new Set([
  "PROVIDER",
  "API_KEY",
  "API_URL",
  "PROMPT_ENGINEER_MODEL",
  "RUN_BIN",
  "EVAL_BIN",
  "DIR",
  "LOG_DIR",
  "CHECKPOINT",
  "TIMEOUT",
]);

/**
 * Strip inline comments: everything after an unquoted `#`.
 * Respects double-quoted strings containing `#`.
 */
function stripComment(line: string): string {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      inQuote = !inQuote;
    } else if (line[i] === "#" && !inQuote) {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Remove surrounding double quotes from a value if present.
 */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Measure leading indentation as a level:
 *  - tab = 1 level per tab
 *  - 2 spaces = 1 level
 * Mixed tabs and spaces within the same line are rejected.
 */
function indentLevel(line: string, lineNum: number): number {
  if (line.length === 0) return 0;

  const hasTabs = line[0] === "\t";
  const hasSpaces = line[0] === " ";

  if (!hasTabs && !hasSpaces) return 0;

  if (hasTabs) {
    let count = 0;
    while (count < line.length && line[count] === "\t") count++;
    if (count < line.length && line[count] === " ") {
      throw new ParseError("Mixed tabs and spaces in indentation", lineNum);
    }
    return count;
  }

  // Spaces
  let count = 0;
  while (count < line.length && line[count] === " ") count++;
  if (count < line.length && line[count] === "\t") {
    throw new ParseError("Mixed tabs and spaces in indentation", lineNum);
  }
  if (count % 2 !== 0) {
    throw new ParseError(
      `Indentation must be a multiple of 2 spaces (found ${count})`,
      lineNum,
    );
  }
  return count / 2;
}

/**
 * Join physical lines with `\` continuation into logical lines.
 * Returns array of { text, line } where line is the starting line number.
 */
function joinContinuations(
  lines: string[],
): Array<{ text: string; line: number }> {
  const result: Array<{ text: string; line: number }> = [];
  let i = 0;

  while (i < lines.length) {
    let text = lines[i]!;
    const startLine = i + 1; // 1-indexed

    while (text.endsWith("\\") && i + 1 < lines.length) {
      text = text.slice(0, -1) + " " + lines[i + 1]!.trimStart();
      i++;
    }

    result.push({ text, line: startLine });
    i++;
  }

  return result;
}

/**
 * Split a RUN/EVAL body on the last ` WITH ` (case-sensitive).
 * Returns the prompt (unquoted) and optional bin name.
 */
function parseWithClause(body: string): { prompt: string; bin: string | null } {
  const idx = body.lastIndexOf(" WITH ");
  if (idx === -1) {
    return { prompt: unquote(body), bin: null };
  }
  const prompt = unquote(body.slice(0, idx).trim());
  const bin = unquote(body.slice(idx + " WITH ".length).trim());
  return { prompt, bin: bin || null };
}

/**
 * Find a keyword position in text, respecting double-quoted strings.
 * Returns the index of the keyword start, or -1 if not found.
 */
function findUnquotedKeyword(text: string, keyword: string): number {
  let inQuote = false;
  for (let i = 0; i <= text.length - keyword.length; i++) {
    if (text[i] === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote) {
      const before = i === 0 || text[i - 1] === " ";
      const match = text.substring(i, i + keyword.length) === keyword;
      const after =
        i + keyword.length >= text.length ||
        text[i + keyword.length] === " " ||
        text[i + keyword.length] === ":";
      if (before && match && after) return i;
    }
  }
  return -1;
}

/**
 * Parse an EXPAND line body (everything after "EXPAND ").
 * Expected form: AS <model> FOR <prompt> [FOCUS <guidance>] INTO:
 */
function parseExpandBody(
  body: string,
  lineNum: number,
): { model: string; prompt: string; focus: string | null } {
  // Verify and strip trailing INTO:
  const intoIdx = findUnquotedKeyword(body, "INTO:");
  if (intoIdx === -1) {
    throw new ParseError("EXPAND requires INTO: at the end", lineNum);
  }
  const beforeInto = body.slice(0, intoIdx).trim();

  const asIdx = findUnquotedKeyword(beforeInto, "AS");
  const forIdx = findUnquotedKeyword(beforeInto, "FOR");
  const focusIdx = findUnquotedKeyword(beforeInto, "FOCUS");

  if (asIdx === -1) {
    throw new ParseError("EXPAND requires AS <model>", lineNum);
  }
  if (forIdx === -1) {
    throw new ParseError("EXPAND requires FOR <prompt>", lineNum);
  }
  if (asIdx > forIdx) {
    throw new ParseError("AS must come before FOR in EXPAND", lineNum);
  }
  if (focusIdx !== -1 && focusIdx < forIdx) {
    throw new ParseError("FOCUS must come after FOR in EXPAND", lineNum);
  }

  const model = unquote(beforeInto.slice(asIdx + 3, forIdx).trim());
  const prompt =
    focusIdx !== -1
      ? unquote(beforeInto.slice(forIdx + 4, focusIdx).trim())
      : unquote(beforeInto.slice(forIdx + 4).trim());
  const focus =
    focusIdx !== -1
      ? unquote(beforeInto.slice(focusIdx + 6).trim())
      : null;

  if (!model) {
    throw new ParseError("EXPAND AS model cannot be empty", lineNum);
  }
  if (!prompt) {
    throw new ParseError("EXPAND FOR prompt cannot be empty", lineNum);
  }

  return { model, prompt, focus };
}

/**
 * Parse a level-2 INTO: block target line (RUN/EVAL with optional WITH, no prompt).
 */
function parseIntoTarget(
  stripped: string,
  lineNum: number,
): { type: "RUN" | "RAW_RUN" | "EVAL" | "RAW_EVAL"; bin: string | null } {
  for (const keyword of ["RAW_RUN", "RAW_EVAL", "RUN", "EVAL"] as const) {
    if (stripped === keyword) {
      return { type: keyword, bin: null };
    }
    if (stripped.startsWith(`${keyword} WITH `)) {
      const bin = unquote(stripped.slice(`${keyword} WITH `.length).trim());
      return { type: keyword, bin: bin || null };
    }
  }
  throw new ParseError(
    `Expected RUN, EVAL, or RETRY in INTO: block, got: ${stripped}`,
    lineNum,
  );
}

/**
 * Tokenize a .circuit file into a token stream.
 */
export function tokenize(source: string): Token[] {
  const rawLines = source.split("\n");
  const logicalLines = joinContinuations(rawLines);
  const tokens: Token[] = [];

  for (const { text, line } of logicalLines) {
    const trimmed = text.trim();

    // Blank lines
    if (trimmed === "") {
      continue;
    }

    // Comment lines
    if (trimmed.startsWith("#")) {
      continue;
    }

    const level = indentLevel(text, line);
    const stripped = stripComment(text).trim();

    if (stripped === "") continue;

    // Indent level 0: DEFINE, ALIAS, or CIRCUIT_DECL
    if (level === 0) {
      // CIRCUIT declaration
      if (stripped.startsWith("CIRCUIT ") && stripped.endsWith(":")) {
        const name = stripped.slice("CIRCUIT ".length, -1).trim();
        if (!name) {
          throw new ParseError("CIRCUIT name cannot be empty", line);
        }
        tokens.push({ type: "CIRCUIT_DECL", value: name, line });
        continue;
      }

      // ALIAS directive: ALIAS <name> <command>
      if (stripped.startsWith("ALIAS ")) {
        const rest = stripped.slice("ALIAS ".length).trim();
        const spaceIdx = rest.indexOf(" ");
        if (spaceIdx === -1) {
          throw new ParseError("ALIAS requires a name and a command", line);
        }
        const name = rest.slice(0, spaceIdx);
        const command = unquote(rest.slice(spaceIdx + 1).trim());
        if (!command) {
          throw new ParseError("ALIAS command cannot be empty", line);
        }
        tokens.push({
          type: "ALIAS",
          value: name,
          secondaryValue: command,
          line,
        });
        continue;
      }

      // DEFINE directive
      const spaceIdx = stripped.indexOf(" ");
      if (spaceIdx === -1) {
        throw new ParseError(
          `Expected a value after directive '${stripped}'`,
          line,
        );
      }

      const keyword = stripped.slice(0, spaceIdx);
      const rawValue = stripped.slice(spaceIdx + 1).trim();
      const value = unquote(rawValue);

      if (DEFINE_KEYWORDS.has(keyword)) {
        tokens.push({
          type: "DEFINE",
          value: keyword,
          secondaryValue: value,
          line,
        });
      } else {
        throw new ParseError(`Unknown directive: ${keyword}`, line);
      }
      continue;
    }

    // Indent level 1: RUN, RAW_RUN, EVAL, RAW_EVAL, EXPAND (with optional WITH <bin>)
    if (level === 1) {
      // EXPAND AS <model> FOR <prompt> [FOCUS <guidance>] INTO:
      if (stripped.startsWith("EXPAND ")) {
        const { model, prompt, focus } = parseExpandBody(
          stripped.slice("EXPAND ".length).trim(),
          line,
        );
        tokens.push({
          type: "EXPAND",
          value: prompt,
          expandModel: model,
          expandFocus: focus ?? undefined,
          line,
        });
        continue;
      }

      // RAW_RUN <prompt> [WITH <bin>]
      if (stripped.startsWith("RAW_RUN ")) {
        const { prompt, bin } = parseWithClause(
          stripped.slice("RAW_RUN ".length).trim(),
        );
        if (!prompt) {
          throw new ParseError("RAW_RUN prompt cannot be empty", line);
        }
        tokens.push({
          type: "RAW_RUN",
          value: prompt,
          secondaryValue: bin ?? undefined,
          line,
        });
        continue;
      }

      // RAW_EVAL <prompt> [WITH <bin>]
      if (stripped.startsWith("RAW_EVAL ")) {
        const { prompt, bin } = parseWithClause(
          stripped.slice("RAW_EVAL ".length).trim(),
        );
        if (!prompt) {
          throw new ParseError("RAW_EVAL prompt cannot be empty", line);
        }
        tokens.push({
          type: "RAW_EVAL",
          value: prompt,
          secondaryValue: bin ?? undefined,
          line,
        });
        continue;
      }

      // RUN <prompt> [WITH <bin>]
      if (stripped.startsWith("RUN ")) {
        const { prompt, bin } = parseWithClause(
          stripped.slice("RUN ".length).trim(),
        );
        if (!prompt) {
          throw new ParseError("RUN prompt cannot be empty", line);
        }
        tokens.push({
          type: "RUN",
          value: prompt,
          secondaryValue: bin ?? undefined,
          line,
        });
        continue;
      }

      // EVAL <prompt> [WITH <bin>]
      if (stripped.startsWith("EVAL ")) {
        const { prompt, bin } = parseWithClause(
          stripped.slice("EVAL ".length).trim(),
        );
        if (!prompt) {
          throw new ParseError("EVAL prompt cannot be empty", line);
        }
        tokens.push({
          type: "EVAL",
          value: prompt,
          secondaryValue: bin ?? undefined,
          line,
        });
        continue;
      }

      throw new ParseError(
        `Expected RUN, RAW_RUN, EVAL, RAW_EVAL, or EXPAND at indent level 1, got: ${stripped}`,
        line,
      );
    }

    // Indent level 2: ALLOW_REQUEST, RETRY, or INTO: block targets (RUN/EVAL with optional WITH)
    if (level === 2) {
      // ALLOW_REQUEST "condition"
      if (stripped.startsWith("ALLOW_REQUEST ")) {
        const condition = unquote(stripped.slice("ALLOW_REQUEST ".length).trim());
        if (!condition) {
          throw new ParseError("ALLOW_REQUEST condition cannot be empty", line);
        }
        tokens.push({ type: "ALLOW_REQUEST", value: condition, line });
        continue;
      }

      // NOTIFY <bin command>
      if (stripped.startsWith("NOTIFY ")) {
        const command = unquote(stripped.slice("NOTIFY ".length).trim());
        if (!command) {
          throw new ParseError("NOTIFY command cannot be empty", line);
        }
        tokens.push({ type: "NOTIFY", value: command, line });
        continue;
      }

      // REQUEST_TIMEOUT <seconds>
      if (stripped.startsWith("REQUEST_TIMEOUT ")) {
        const numStr = stripped.slice("REQUEST_TIMEOUT ".length).trim();
        const num = parseInt(numStr, 10);
        if (isNaN(num) || num <= 0) {
          throw new ParseError(
            `REQUEST_TIMEOUT must be a positive integer (seconds), got: ${numStr}`,
            line,
          );
        }
        tokens.push({ type: "REQUEST_TIMEOUT", value: numStr, line });
        continue;
      }

      if (stripped.startsWith("RETRY ")) {
        const numStr = stripped.slice("RETRY ".length).trim();
        const num = parseInt(numStr, 10);
        if (isNaN(num) || num <= 0) {
          throw new ParseError(
            `RETRY must be a positive integer, got: ${numStr}`,
            line,
          );
        }
        tokens.push({ type: "RETRY", value: numStr, line });
        continue;
      }

      // INTO: block targets — RUN/RAW_RUN/EVAL/RAW_EVAL [WITH <bin>] (no prompt)
      const target = parseIntoTarget(stripped, line);
      tokens.push({
        type: target.type,
        value: "", // no prompt — it lives on EXPAND's FOR
        secondaryValue: target.bin ?? undefined,
        line,
      });
      continue;
    }

    throw new ParseError(`Unexpected indentation level ${level}`, line);
  }

  return tokens;
}
