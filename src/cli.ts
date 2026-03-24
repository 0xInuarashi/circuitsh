#!/usr/bin/env bun

import { readFileSync } from "fs";
import { resolve } from "path";
import { Command } from "commander";
import { parse } from "./parser.ts";
import { resolveConfig } from "./config.ts";
import { executeCircuit } from "./engine.ts";
import { CircuitError, ParseError, ConfigError, BinNotFoundError } from "./errors.ts";
import type { CLIOptions } from "./types.ts";

const program = new Command();

program
  .name("circuit")
  .description("DSL for AI orchestration — plug AI agents together with eval-retry loops")
  .version("0.1.0")
  .argument("<file>", "Path to .circuit file")
  .option("--dry-run", "Parse and validate without executing", false)
  .option("-v, --verbose", "Show expanded prompts and BIN output", false)
  .option("--log-dir <dir>", "Override LOG_DIR")
  .option("--api-key <key>", "Override API_KEY")
  .option("--step <n>", "Run only step N (1-indexed)", parseInt)
  .option("--resume <runId>", "Resume from JSONL log")
  .option("--raw", "Dump all raw API request/response bodies, BIN commands, and traces", false)
  .option("--debug", "Show full tracebacks and raw responses", false)
  .action(async (file: string, options: CLIOptions) => {
    try {
      // Read and parse .circuit file
      const filePath = resolve(file);
      let source: string;
      try {
        source = readFileSync(filePath, "utf-8");
      } catch {
        console.error(`Error: Cannot read file: ${filePath}`);
        process.exit(2);
      }

      let ast;
      try {
        ast = parse(source);
      } catch (err) {
        if (err instanceof ParseError) {
          console.error(`Parse error: ${err.message}`);
          process.exit(2);
        }
        throw err;
      }

      // Resolve config
      let config;
      try {
        config = resolveConfig(ast, options);
      } catch (err) {
        if (err instanceof ConfigError) {
          console.error(`Config error: ${err.message}`);
          process.exit(3);
        }
        throw err;
      }

      // Dry run: just print AST and first expansion preview
      if (options.dryRun) {
        console.log("Parsed AST:");
        console.log(JSON.stringify(ast, null, 2));
        console.log("\nResolved config:");
        console.log(JSON.stringify({ ...config, apiKey: "***" }, null, 2));
        console.log("\nDry run complete — no execution.");
        process.exit(0);
      }

      // Execute
      const dim = "\x1b[2m";
      const bold = "\x1b[1m";
      const cyan = "\x1b[36m";
      const reset = "\x1b[0m";
      console.log(`${bold}${cyan}Circuit:${reset} ${ast.circuits[0]!.name}`);
      console.log(`${dim}Steps: ${ast.circuits[0]!.steps.length} │ RUN: ${config.runBin} │ EVAL: ${config.evalBin}${reset}`);
      console.log(`${dim}DIR: ${config.dir}${reset}`);

      const success = await executeCircuit(ast, config, options);
      process.exit(success ? 0 : 1);
    } catch (err) {
      if (err instanceof BinNotFoundError) {
        console.error(`Error: ${err.message}`);
        process.exit(4);
      }
      if (err instanceof CircuitError) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
      console.error("Unexpected error:", err);
      if (options.debug) {
        console.error(err);
      }
      process.exit(1);
    }
  });

program.parse();
