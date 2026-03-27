import { homedir } from "os";
import { resolve } from "path";
import type { CircuitAST, CircuitConfig, CLIOptions } from "./types.ts";
import {
  CONFIG_DEFAULTS,
  DEFINE_KEY_MAP,
  ENV_VAR_MAP,
} from "./types.ts";
import { ConfigError } from "./errors.ts";

/**
 * Resolve a CircuitConfig from all sources.
 * Priority: CLI flags > .circuit defines > env vars > defaults
 */
export function resolveConfig(
  ast: CircuitAST,
  cliOptions: CLIOptions,
  env: Record<string, string | undefined> = process.env,
): CircuitConfig {
  const config: Record<string, unknown> = { ...CONFIG_DEFAULTS };

  // Layer 1: env vars (lowest priority after defaults)
  for (const [envKey, configKey] of Object.entries(ENV_VAR_MAP)) {
    const val = env[envKey];
    if (val !== undefined && val !== "") {
      config[configKey] = coerce(configKey, val);
    }
  }

  // Layer 2: .circuit file defines (override env)
  for (const define of ast.defines) {
    const configKey = DEFINE_KEY_MAP[define.key];
    if (configKey) {
      config[configKey] = coerce(configKey, define.value);
    }
  }

  // Layer 3: CLI flags (highest priority)
  if (cliOptions.apiKey) config.apiKey = cliOptions.apiKey;
  if (cliOptions.logDir) config.logDir = cliOptions.logDir;

  // Build aliases map
  const aliases: Record<string, string> = {};
  for (const alias of ast.aliases) {
    aliases[alias.name] = alias.command;
  }
  config.aliases = aliases;

  // Resolve RUN_BIN / EVAL_BIN through aliases
  if (typeof config.runBin === "string" && aliases[config.runBin]) {
    config.runBin = aliases[config.runBin];
  }
  if (typeof config.evalBin === "string" && aliases[config.evalBin as string]) {
    config.evalBin = aliases[config.evalBin as string]!;
  }

  // EVAL_BIN defaults to RUN_BIN if not set
  if (!config.evalBin && config.runBin) {
    config.evalBin = config.runBin;
  }

  // Expand ~ in paths
  if (typeof config.dir === "string") {
    config.dir = expandTilde(config.dir);
  }
  if (typeof config.logDir === "string") {
    config.logDir = expandTilde(config.logDir);
  }

  // Resolve relative paths
  if (typeof config.dir === "string") {
    config.dir = resolve(config.dir as string);
  }

  // Validate required fields
  if (!config.runBin) {
    throw new ConfigError("RUN_BIN is required (set in .circuit file, CIRCUIT_RUN_BIN env var, or CLI)");
  }
  if (!config.apiKey) {
    throw new ConfigError(
      "API_KEY is required (set in .circuit file, OPENROUTER_API_KEY / CIRCUIT_API_KEY env var, or --api-key flag)",
    );
  }

  return config as unknown as CircuitConfig;
}

function coerce(key: string, value: string): unknown {
  if (key === "checkpoint") {
    return value === "on" || value === "true" || value === "1";
  }
  return value;
}

function expandTilde(p: string): string {
  if (p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}
