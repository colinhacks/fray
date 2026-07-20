import { createRoot } from "react-dom/client"
import { QuestionBlockCard } from "./components/ChatView.tsx"
import "./styles.css"

// Isolates the ```question rendering to PROVE two things:
//  1. The recommended option is flagged by the inline word "recommended" on its line (primary
//     mechanism), stripped from the label, with an optional `(recommended: why)` rationale → tooltip.
//  2. The "Recommended" badge FLOATS top-right so a long option's text flows around it and reclaims
//     full width below — not squeezed into a narrow left column.
// Legacy `Recommendation: B` line still chips B (backward-compat fallback).

// A deliberately LONG recommended option so the float/text-flow is visible.
const INLINE_LONG = [
  "The waker bug is diagnosed and fixable. How do you want me to proceed?",
  "",
  "- A. Just the primary fix plus a regression test — the smallest change that most likely clears the exact `dependabot-nub-ecosystem` symptom you're seeing, keeping the release-gate surface small; I'd open a follow-up for the codex/terminal-state items (recommended: tightest fix for the exact failure)",
  "- B. Implement all three fixes at once — most complete, but the largest diff and the widest gate surface",
  "- C. Diagnosis only — you take it from here",
].join("\n")

const INLINE_SHORT = [
  "Should the settings store use SQLite or a JSON file?",
  "",
  "- A. SQLite — transactional, matches the session registry (recommended)",
  "- B. JSON file — zero deps, human-editable, racy under concurrent writes",
].join("\n")

const LEGACY_FALLBACK = [
  "How should retries behave?",
  "",
  "- A. Fail fast — no retry",
  "- B. Three retries with backoff",
  "",
  "Recommendation: B — resilient to transient network blips.",
].join("\n")

const NO_REC = [
  "What should I name the flag?",
  "",
  "- A. `--strict`",
  "- B. `--safe`",
].join("\n")

function Fixture() {
  return (
    <main className="min-h-screen bg-bg p-4 sm:p-8">
      <div className="mx-auto max-w-[680px] space-y-6">
        <div data-case="inline-long">
          <p className="mb-2 text-[11px] text-muted">Inline marker on a LONG option → badge floats top-right, text flows full-width below</p>
          <QuestionBlockCard raw={INLINE_LONG} questionKind="question" />
        </div>
        <div data-case="inline-short">
          <p className="mb-2 text-[11px] text-muted">Inline `(recommended)` on a short option → chip on A</p>
          <QuestionBlockCard raw={INLINE_SHORT} questionKind="question" />
        </div>
        <div data-case="legacy-fallback">
          <p className="mb-2 text-[11px] text-muted">Legacy `Recommendation: B` line → still chips B (backward-compat)</p>
          <QuestionBlockCard raw={LEGACY_FALLBACK} questionKind="question" />
        </div>
        <div data-case="no-rec">
          <p className="mb-2 text-[11px] text-muted">No recommendation → no chip</p>
          <QuestionBlockCard raw={NO_REC} questionKind="question" />
        </div>
      </div>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
