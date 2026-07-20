import assert from "node:assert/strict"
import test from "node:test"
import {
  queuedTerminalInputBytes,
  terminalCloseKind,
  terminalReconnectDelay,
  TERMINAL_PENDING_INPUT_MAX_BYTES,
} from "./terminalConnection.ts"

test("terminalCloseKind only treats an actual attach PTY exit as a dead session", () => {
  assert.equal(terminalCloseKind(1000, "pty exit 0"), "exited")
  assert.equal(terminalCloseKind(1000, "pty exit 1"), "exited")
  assert.equal(terminalCloseKind(1006, ""), "reconnect")
  assert.equal(terminalCloseKind(1012, "service restart"), "reconnect")
  assert.equal(terminalCloseKind(1000, "server closing"), "reconnect")
})

test("terminalReconnectDelay backs off quickly and caps at five seconds", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 20].map(terminalReconnectDelay), [250, 500, 1_000, 2_000, 4_000, 5_000, 5_000])
})

test("queuedTerminalInputBytes caps offline input by UTF-8 bytes", () => {
  assert.equal(queuedTerminalInputBytes(0, "x".repeat(TERMINAL_PENDING_INPUT_MAX_BYTES)), TERMINAL_PENDING_INPUT_MAX_BYTES)
  assert.equal(queuedTerminalInputBytes(TERMINAL_PENDING_INPUT_MAX_BYTES, "x"), null)
  assert.equal(queuedTerminalInputBytes(TERMINAL_PENDING_INPUT_MAX_BYTES - 3, "é"), TERMINAL_PENDING_INPUT_MAX_BYTES - 1)
  assert.equal(queuedTerminalInputBytes(TERMINAL_PENDING_INPUT_MAX_BYTES - 3, "😀"), null)
})
