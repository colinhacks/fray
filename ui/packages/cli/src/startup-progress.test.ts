import assert from "node:assert/strict";
import { test } from "node:test";
import { StartupProgress } from "./startup-progress.ts";

function output(isTTY: boolean) {
  let text = "";
  return {
    isTTY,
    write(chunk: string) {
      text += chunk;
      return true;
    },
    text: () => text,
  };
}

test("startup progress writes its first non-TTY phase immediately and remains line-oriented", () => {
  const destination = output(false);
  const progress = new StartupProgress({ output: destination, tickMs: 60_000 });
  progress.phase("Preparing Fray startup");
  assert.equal(destination.text(), "fray: Preparing Fray startup\n");
  progress.phase("Building immutable artifact: web UI");
  progress.complete("Fray is ready");
  assert.equal(destination.text().includes("\x1b"), false);
  assert.match(destination.text(), /^fray: Preparing Fray startup$/mu);
  assert.match(destination.text(), /^fray: Building immutable artifact: web UI$/mu);
  assert.match(destination.text(), /^fray: ready: Fray is ready$/mu);
});

test("TTY concurrent-logs mode drops the open spinner line so nothing glues onto it", () => {
  const destination = output(true);
  const progress = new StartupProgress({ output: destination, tickMs: 60_000 });
  progress.phase("Starting Fray server");
  // Entering concurrent-logs mode replaces the animated line with a settled, newline-terminated row.
  progress.beginConcurrentLogs("Waiting for Fray server health");
  assert.match(destination.text(), /\r\x1b\[2K⋯ Waiting for Fray server health\n$/u);
  // The launcher is what shares this TTY with the forked child: any external log now lands cleanly
  // because the spinner is not holding an open line.
  destination.write("[fray-ui] server on http://127.0.0.1:55854 (prod) — project fray\n");
  // A later phase in this mode is also a settled row, never an animated open line.
  progress.phase("Requesting default browser");
  assert.match(destination.text(), /\r\x1b\[2K⋯ Requesting default browser\n$/u);
  progress.complete("Fray is ready");
  assert.match(destination.text(), /\r\x1b\[2K✓ Fray is ready \(0\.0s\)\n$/u);
  // No animated frame ever appears once concurrent-logs mode starts, so no glued spinner fragments.
  const afterSettle = destination.text().slice(destination.text().indexOf("⋯ Waiting"));
  assert.equal(/[◐◓◑◒]/u.test(afterSettle), false);
});

test("TTY concurrent-logs mode suppresses the animated heartbeat so ticks never repaint a frame", async () => {
  const destination = output(true);
  // A short tick makes the heartbeat timer actually fire during the test window.
  const progress = new StartupProgress({ output: destination, tickMs: 5 });
  progress.beginConcurrentLogs("Waiting for Fray server health");
  const beforeTicks = destination.text();
  await new Promise((resolve) => setTimeout(resolve, 40)); // several heartbeat intervals
  // The guard must have kept every tick from repainting; output is byte-for-byte unchanged and holds
  // no animated frame glyph. Without the guard a heartbeat would redraw "◒ Waiting …" here.
  assert.equal(destination.text(), beforeTicks);
  assert.equal(/[◐◓◑◒]/u.test(destination.text()), false);
  progress.complete("Fray is ready");
});

test("TTY startup progress uses a single elapsed-time spinner line and clears it on failure", () => {
  const destination = output(true);
  const progress = new StartupProgress({ output: destination, tickMs: 60_000 });
  progress.phase("Waiting for Fray server health");
  assert.match(destination.text(), /^\r\x1b\[2K[◐◓◑◒] Waiting for Fray server health \(0\.0s\)$/u);
  progress.clearLine();
  assert.match(destination.text(), /\r\x1b\[2K$/u);
  progress.fail("Fray startup failed: port was unavailable");
  assert.match(destination.text(), /\r\x1b\[2K✗ Fray startup failed: port was unavailable \(0\.0s\)\n$/u);
});
