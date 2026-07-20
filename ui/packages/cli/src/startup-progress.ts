export interface StartupProgressOutput {
  isTTY?: boolean;
  write(chunk: string): boolean;
}

export interface StartupProgressOptions {
  output?: StartupProgressOutput;
  /** Kept configurable so the formatter can be tested without waiting for a real clock. */
  tickMs?: number;
}

/**
 * Small, dependency-free terminal activity indicator for the source launcher.
 *
 * TTYs get one redrawn line; pipes get newline-delimited records and a modest heartbeat so CI and
 * shell wrappers never mistake a slow Nub/Vite step for a hung launcher.
 */
export class StartupProgress {
  private readonly output: StartupProgressOutput;
  private readonly tty: boolean;
  private readonly startedAt = Date.now();
  private readonly frames = ["◐", "◓", "◑", "◒"];
  private frame = 0;
  private current: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  // Once the forked control-plane child starts writing to the SAME TTY, an in-place redraw would
  // collide with those unsynchronized writes (the launcher cannot clear another process' line).
  // Passive mode drops the open animated line and prints settled, newline-terminated status rows so
  // concurrent logs land cleanly on their own lines. Non-TTY output is already line-oriented.
  private passive = false;

  constructor({ output = process.stdout, tickMs }: StartupProgressOptions = {}) {
    this.output = output;
    this.tty = output.isTTY === true;
    const interval = tickMs ?? (this.tty ? 80 : 5_000);
    this.timer = setInterval(() => this.renderHeartbeat(), interval);
    // A progress painter must never keep a CLI process alive after its work has finished.
    this.timer.unref?.();
  }

  phase(message: string): void {
    this.current = message;
    if (this.passive && this.tty) {
      // Clear any residual animated line, then print a settled row nothing can append to.
      this.output.write(`\r\x1b[2K⋯ ${message}\n`);
      return;
    }
    this.render(true);
  }

  /**
   * Enter line-oriented mode for a phase whose window overlaps another process writing to this TTY
   * (the control-plane child). Prints one settled status line instead of holding an open, animated
   * one, so interleaved logs never glue onto the spinner. complete()/fail() still print the final
   * line beneath whatever logged in between.
   */
  beginConcurrentLogs(message: string): void {
    this.passive = true;
    this.phase(message);
  }

  complete(message: string): void {
    this.finish("ready", message);
  }

  fail(message: string): void {
    this.finish("failed", message);
  }

  /** Let ordinary console output take over a clean terminal row without stopping progress. */
  clearLine(): void {
    if (this.current && this.tty) this.output.write("\r\x1b[2K");
  }

  private elapsed(): string {
    return `${((Date.now() - this.startedAt) / 1_000).toFixed(1)}s`;
  }

  private renderHeartbeat(): void {
    if (!this.current) return;
    // A passive TTY phase must not repaint an animated line; concurrent logs own the screen now.
    if (this.passive && this.tty) return;
    this.render(false);
  }

  private render(force: boolean): void {
    if (!this.current) return;
    if (this.tty) {
      const frame = this.frames[this.frame++ % this.frames.length];
      this.output.write(`\r\x1b[2K${frame} ${this.current} (${this.elapsed()})`);
      return;
    }
    // A new phase is immediately visible. Later records are intentionally boring and parseable.
    if (force) this.output.write(`fray: ${this.current}\n`);
    else this.output.write(`fray: still ${this.current} (${this.elapsed()})\n`);
  }

  private finish(kind: "ready" | "failed", message: string): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.current = null;
    if (this.tty) {
      this.output.write(`\r\x1b[2K${kind === "ready" ? "✓" : "✗"} ${message} (${this.elapsed()})\n`);
      return;
    }
    this.output.write(`fray: ${kind}: ${message}\n`);
  }
}
