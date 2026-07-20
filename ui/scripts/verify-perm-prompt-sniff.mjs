// Ad hoc proof for the perm-prompt pane sniff, exercised against REAL tmux panes (no mocks, no string
// fixtures) — the capture path production actually uses.
//
// The bug (reported 2026-07-18): matchesPermPrompt scanned the whole visible pane for content signals
// alone, so a healthy worker whose TRANSCRIPT happened to show a prompt's lines — an agent quoting an
// approval, reading tailer.ts, pasting a probe's terminal output — was read as blocked. Because
// sniffPane only fires after a ≥PERM_SNIFF_MS quiet gap, the verdict flipped with every pause in the
// stream and the thread oscillated between the sidebar's running band and Needs-you.
//
// Each scenario paints a REAL tmux pane with a REAL captured screen, captures it exactly as the tailer
// does (`tmux capture-pane -p`), and asserts the verdict. Negative controls (three genuine modal
// shapes, and a mode line quoted mid-transcript) prove the new structural gates did not weaken
// detection of a real prompt.
//
// Usage: npx tsx ui/scripts/verify-perm-prompt-sniff.mjs   (exit 0 = all green)
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { matchesPermPrompt } from "../packages/server/src/tailer.ts"

const socket = `permsniff-${randomUUID().slice(0, 8)}`
const work = mkdtempSync(join(tmpdir(), "permsniff-"))
const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`)
}

const tmux = (...a) => execFileSync("tmux", ["-L", socket, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })

// Paint `screen` into a real 200x50 pane (the worker geometry) and read it back through the exact
// capture production uses, so tmux's own wrapping/padding is in the loop rather than assumed away.
function verdictFor(screen) {
  const file = join(work, `${randomUUID()}.txt`)
  writeFileSync(file, screen.endsWith("\n") ? screen : `${screen}\n`)
  const name = `pane-${randomUUID().slice(0, 8)}`
  tmux("new-session", "-d", "-s", name, "-x", "200", "-y", "50", "--", "sh", "-c", `cat ${file}; sleep 30`)
  try {
    // Give cat a beat to paint before capturing.
    execFileSync("sleep", ["0.4"])
    return matchesPermPrompt(tmux("capture-pane", "-p", "-t", name))
  } finally {
    try { tmux("kill-session", "-t", name) } catch {}
  }
}

// The composer as every input-accepting Claude pane renders it: prompt row, divider, project line, mode
// line. Its presence is what proves the TUI is NOT blocked.
const composer = (mode) => [
  "─".repeat(120),
  "❯ ",
  "─".repeat(120),
  "  repro · main · Opus 4.8 · 17%                    /rc",
  `  ${mode} · ← 3 agents`,
].join("\n")

// ---- real modal shapes (verbatim captures from a disposable claude session, 2026-07-18) ----
const MODAL_BASH = [
  " Bash command",
  "   touch approved-me.txt",
  "   Create an empty file called approved-me.txt",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and always allow access to repro/ from this project",
  "   3. No",
  " Esc to cancel · Tab to amend · ctrl+e to explain",
].join("\n")

const MODAL_WRITE = [
  " Overwrite file",
  " approved-me.txt",
  "  1 +hello",
  " Do you want to overwrite approved-me.txt?",
  " ❯ 1. Yes",
  "   2. Yes, allow all edits during this session (shift+tab)",
  "   3. No",
  " Esc to cancel · Tab to amend",
].join("\n")

// The pre-boot workspace-trust prompt: no "Do you want" line at all, so the footer alone must carry it.
const MODAL_TRUST = [
  " Accessing workspace:",
  " /tmp/repro",
  " Quick safety check: Is this a project you created or one you trust?",
  " Security guide",
  " ❯ 1. Yes, I trust this folder",
  "   2. No, exit",
  " Enter to confirm · Esc to cancel",
].join("\n")

// ExitPlanMode's approval — neither "Do you want" nor "Esc to cancel"; missing it hangs a worker
// forever, since detectNativeInput is a Codex-only hook and this is Claude's sole modal signal.
const MODAL_EXIT_PLAN = [
  "   Claude has written up a plan and is ready to execute. Would you like to proceed?",
  "   ❯ 1. Yes, and use auto mode",
  "     2. Yes, manually approve edits",
  "     3. No, refine with Ultraplan on Claude Code on the web",
  "     4. Tell Claude what to change",
  "        shift+tab to approve with this feedback",
  "   ctrl+g to edit in VS Code · ~/.claude/plans/plan-name.md",
].join("\n")

// The reported false positive: the agent's own reply quotes a prompt while the composer stays live.
const QUOTED = ["⏺ Do you want to proceed?", "  1. Yes", "  2. No", "  Esc to cancel", "✻ Crunched for 1s"].join("\n")

// `ctrl+o` swaps the composer for this footer: composer-less but fully live, and sticky per session.
const TRANSCRIPT_VIEW_FOOTER =
  "  Showing detailed transcript · ctrl+o to toggle · ↑↓ scroll · v to open in code · ? for shortcuts    verbose"

try {
  const modals = [
    ["Bash approval", MODAL_BASH],
    ["Write approval", MODAL_WRITE],
    ["workspace trust", MODAL_TRUST],
    ["ExitPlanMode approval", MODAL_EXIT_PLAN],
  ]
  for (const [label, modal] of modals) {
    check(`real ${label} modal is detected`, verdictFor(modal) === true)
  }

  for (const mode of ["⏵⏵ auto mode on (shift+tab to cycle)", "⏸ manual mode on", "⏵ accept edits on", "⏵⏵ bypass permissions on", "⏸ plan mode on"]) {
    check(`quoted prompt under "${mode}" is NOT detected`, verdictFor(`${QUOTED}\n${composer(mode)}`) === false)
  }

  check(
    "quoted prompt under the ctrl+o transcript view is NOT detected",
    verdictFor(`${QUOTED}\n${TRANSCRIPT_VIEW_FOOTER}`) === false,
  )

  // The same modal shape scrolled up into history with later output and a live composer beneath it.
  const scrolled = [MODAL_BASH, ...Array.from({ length: 14 }, (_, i) => `⏺ later output line ${i}`), composer("⏵⏵ auto mode on")].join("\n")
  check("a scrolled-past modal above live output is NOT detected", verdictFor(scrolled) === false)

  // Fail-safe control: the composer gate reads only the last rows, so an agent PRINTING a mode line
  // mid-transcript must never suppress a genuine prompt sitting at the bottom.
  check(
    "a mode line quoted in history does not suppress a real modal",
    verdictFor(`⏺ The footer reads: ⏵⏵ auto mode on\n${MODAL_BASH}`) === true,
  )
} finally {
  try { tmux("kill-server") } catch {}
  rmSync(work, { recursive: true, force: true })
}

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
