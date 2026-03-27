import { spawn } from "child_process";
import type { Writable } from "stream";
import type { BinOutput, SessionAdapter } from "./types.ts";
import { BinNotFoundError } from "./errors.ts";

export interface RunBinResult {
  output: Promise<BinOutput>;
  cancel: () => void;
  stdin: Writable | null;
}

/**
 * Execute a BIN command via subprocess.
 * Streams stdout/stderr in real-time via callbacks.
 * Returns an output promise and a cancel function.
 */
export function runBin(opts: {
  adapter: SessionAdapter;
  binCommand: string;
  prompt: string;
  sessionId: string;
  isFirst: boolean;
  workingDir: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}): RunBinResult {
  const command = opts.adapter.buildCommand(
    opts.binCommand,
    opts.prompt,
    opts.sessionId,
    opts.isFirst,
    opts.workingDir,
  );

  const [cmd, ...args] = command;
  if (!cmd) {
    throw new BinNotFoundError(opts.binCommand);
  }

  const startTime = Date.now();

  let proc: ReturnType<typeof spawn> | null = null;
  let procStdin: Writable | null = null;
  let resolved = false;
  let cancelled = false;
  let cancelReject: ((err: unknown) => void) | null = null;

  const killTree = (signal: NodeJS.Signals) => {
    if (!proc) return;
    try {
      // Kill the entire process group (negative PID)
      process.kill(-proc.pid!, signal);
    } catch {
      try { proc.kill(signal); } catch { /* already dead */ }
    }
  };

  const output = new Promise<BinOutput>((resolve, reject) => {
    cancelReject = reject;

    try {
      const spawned = spawn(cmd, args, {
        cwd: opts.workingDir,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
        detached: true,
      });
      proc = spawned;
      procStdin = spawned.stdin;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      reject(new BinNotFoundError(`${opts.binCommand}: ${msg}`));
      return;
    }

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    const cancel = () => {
      cancelled = true;
      killTree("SIGTERM");
      setTimeout(() => killTree("SIGKILL"), 2000);
    };

    proc.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      stdoutChunks.push(text);
      opts.onStdout?.(text);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      stderrChunks.push(text);
      opts.onStderr?.(text);
    });

    proc.on("error", (err) => {
      if (resolved || cancelled) return;
      resolved = true;
      reject(new BinNotFoundError(`${opts.binCommand}: ${err.message}`));
    });

    proc.on("close", (exitCode) => {
      if (resolved) return;
      resolved = true;

      if (cancelled) {
        reject(new Error(`BIN cancelled: ${opts.binCommand}`));
        return;
      }

      const durationMs = Date.now() - startTime;
      const rawStdout = stdoutChunks.join("");
      const stderr = stderrChunks.join("");

      resolve({
        stdout: opts.adapter.parseOutput(rawStdout, stderr),
        rawStdout,
        stderr,
        exitCode,
        durationMs,
        command,
      });
    });
  });

  return {
    output,
    cancel: () => {
      if (resolved) return;
      cancelled = true;
      killTree("SIGTERM");
      setTimeout(() => killTree("SIGKILL"), 2000);
      cancelReject?.(new Error("BIN cancelled"));
    },
    stdin: procStdin,
  };
}
