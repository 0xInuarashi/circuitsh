/**
 * Parse a <verdict>SUCCESS</verdict> or <verdict>FAILURE</verdict>
 * from EVAL output.
 *
 * - Case-insensitive matching
 * - No tag found → defaults to FAILURE (safe default)
 * - Returns the entire EVAL output as feedback (not just the verdict)
 */
export function parseVerdict(evalOutput: string): {
  success: boolean;
  feedback: string;
} {
  const match = evalOutput.match(/<verdict>(.*?)<\/verdict>/is);

  if (match) {
    const verdictText = match[1]!.trim().toUpperCase();
    return {
      success: verdictText === "SUCCESS",
      feedback: evalOutput,
    };
  }

  // No verdict tag found: default to FAILURE
  return {
    success: false,
    feedback:
      evalOutput +
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
