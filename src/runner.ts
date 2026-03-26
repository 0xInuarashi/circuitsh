import { spawn } from "child_process";
import type { BinOutput, SessionAdapter } from "./types.ts";
import { BinNotFoundError, BinTimeoutError } from "./errors.ts";

/**
 * Execute a BIN command via subprocess.
 * Streams stdout/stderr in real-time via callbacks.
 */
export async function runBin(opts: {
  adapter: SessionAdapter;
  binCommand: string;
  prompt: string;
  sessionId: string;
  isFirst: boolean;
  workingDir: string;
  timeoutMs: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}): Promise<BinOutput> {
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

  return new Promise<BinOutput>((resolve, reject) => {
    let proc;
    try {
      proc = spawn(cmd, args, {
        cwd: opts.workingDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
        detached: true,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      reject(new BinNotFoundError(`${opts.binCommand}: ${msg}`));
      return;
    }

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const killTree = (signal: NodeJS.Signals) => {
      try {
        // Kill the entire process group (negative PID)
        process.kill(-proc.pid!, signal);
      } catch {
        try { proc.kill(signal); } catch { /* already dead */ }
      }
    };

    if (opts.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        killTree("SIGTERM");
        // Grace period then SIGKILL
        setTimeout(() => killTree("SIGKILL"), 5000);
      }, opts.timeoutMs);
    }

    proc.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      stdoutChunks.push(text);
      opts.onStdout?.(text);
    });

    proc.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      stderrChunks.push(text);
      opts.onStderr?.(text);
    });

    proc.on("error", (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(new BinNotFoundError(`${opts.binCommand}: ${err.message}`));
    });

    proc.on("close", (exitCode) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);

      const durationMs = Date.now() - startTime;

      const rawStdout = stdoutChunks.join("");
      const stderr = stderrChunks.join("");

      if (timedOut) {
        reject(new BinTimeoutError(
          opts.binCommand,
          opts.timeoutMs,
          opts.adapter.parseOutput(rawStdout, stderr),
          rawStdout,
          stderr,
        ));
        return;
      }

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
}
