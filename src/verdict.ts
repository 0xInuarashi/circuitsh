/**
 * Parse a <verdict> tag from EVAL output.
 *
 * Searches the raw stdout first (contains all streamed text deltas),
 * then falls back to the parsed result text. This handles cases where
 * the verdict tag arrives after the result event fires.
 *
 * - Case-insensitive matching
 * - No tag found → defaults to FAILURE (safe default)
 * - Returns the entire raw stdout as feedback
 * @param rawStdout - raw subprocess stdout (all streamed JSON Lines)
 * @param parsedResult - the parsed result text from data.result
 */
export type Verdict = "SUCCESS" | "PROGRESS" | "FAILURE";

export function parseVerdict(
  rawStdout: string,
  parsedResult: string,
): {
  verdict: Verdict;
  feedback: string;
} {
  // Search raw stdout first — has all streamed text deltas
  const match = rawStdout.match(/<verdict>(.*?)<\/verdict>/is)
    ?? parsedResult.match(/<verdict>(.*?)<\/verdict>/is);

  if (match) {
    const verdictText = match[1]!.trim().toUpperCase();
    if (verdictText === "SUCCESS") {
      return { verdict: "SUCCESS", feedback: parsedResult };
    }
    if (verdictText === "PROGRESS") {
      return { verdict: "PROGRESS", feedback: parsedResult };
    }
    return { verdict: "FAILURE", feedback: parsedResult };
  }

  // No verdict tag found: default to FAILURE
  return {
    verdict: "FAILURE",
    feedback:
      parsedResult +
      "\n\n[CIRCUIT: No <verdict> tag found in EVAL output. Defaulting to FAILURE.]",
  };
}

/**
 * Parse scratchpad_set tags from BIN output.
 * Format: <scratchpad_set key="name">value</scratchpad_set>
 */
export function parseScratchpadUpdates(
  output: string,
): Record<string, string> {
  const updates: Record<string, string> = {};
  const regex = /<scratchpad_set\s+key="([^"]+)">([\s\S]*?)<\/scratchpad_set>/gi;
  let match;

  while ((match = regex.exec(output)) !== null) {
    updates[match[1]!] = match[2]!.trim();
  }

  return updates;
}

/**
 * Parse engineer_scratchpad_set tags from prompt engineer output.
 * Format: <engineer_scratchpad_set key="name">value</engineer_scratchpad_set>
 */
export function parseEngineerScratchpadUpdates(
  output: string,
): Record<string, string> {
  const updates: Record<string, string> = {};
  const regex =
    /<engineer_scratchpad_set\s+key="([^"]+)">([\s\S]*?)<\/engineer_scratchpad_set>/gi;
  let match;

  while ((match = regex.exec(output)) !== null) {
    updates[match[1]!] = match[2]!.trim();
  }

  return updates;
}

/**
 * Parse <expanded_prompt>...</expanded_prompt> from engineer output.
 * Returns null if tag not found.
 */
export function parseExpandedPrompt(engineerOutput: string): string | null {
  const match = engineerOutput.match(
    /<expanded_prompt>([\s\S]*?)<\/expanded_prompt>/i,
  );
  return match ? match[1]!.trim() : null;
}

/**
 * Parse <request_input key="..." reason="...">message</request_input>
 * from prompt engineer output. Returns null if tag not found.
 */
export function parseRequestInput(
  output: string,
): { key: string; reason: string; message: string } | null {
  const match = output.match(/<request_input([^>]*)>([\s\S]*?)<\/request_input>/i);
  if (!match) return null;

  const attrs = match[1]!;
  const message = match[2]!.trim();

  const keyMatch = attrs.match(/key="([^"]*)"/);
  const reasonMatch = attrs.match(/reason="([^"]*)"/);

  if (!keyMatch || !reasonMatch) return null;

  return {
    key: keyMatch[1]!.trim(),
    reason: reasonMatch[1]!.trim(),
    message,
  };
}
