import { createRoot } from "react-dom/client"
import { useState } from "react"
import type { BoardSnapshot, ThreadView } from "@fray-ui/shared"
import { BackgroundOpsStrip } from "./components/ChatView.tsx"
import { Composer } from "./components/Composer.tsx"
import { ProfileGridSelector } from "./components/ProfileGridSelector.tsx"
import { ThreadLifecycleFooter } from "./components/ThreadLifecycleFooter.tsx"
import { Select } from "./components/ui/Select.tsx"
import { PROMPT_CONTROL_TYPOGRAPHY_CLASS } from "./lib/promptControlTypography.ts"
import { store } from "./store.ts"
import "./styles.css"

const thread: ThreadView = {
  id: "drawer-footer-fixture",
  title: "Long transcript with active work",
  status: "active",
  mechanism: null,
  humanBlocked: false,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: "running",
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  kind: "session",
  foreign: false,
  subAgents: [
    { id: "agent-a", label: "Trace the layout regression in the drawer", startedAt: "2026-07-14T10:00:00.000Z", state: "running" },
    { id: "agent-b", label: "Exercise desktop and narrow viewport behavior", startedAt: "2026-07-14T10:01:00.000Z", state: "running" },
  ],
  bgShells: [{ label: "Watch the production fixture build", startedAt: "2026-07-14T10:02:00.000Z", state: "running" }],
}

store.board = { threads: [thread] } as BoardSnapshot

function Fixture() {
  const [draft, setDraft] = useState("This deliberately long draft verifies that a multiline prompt, model selector, permission selector, and every running-operation row remain visible together.\n\nOption-Enter can add another line without changing the footer boundary.")
  const [profile, setProfile] = useState({ provider: "codex", model: "gpt-5.6-sol", effort: "high" })
  const [permission, setPermission] = useState("full")
  return (
    <main className="relative min-h-screen overflow-hidden bg-bg px-4 py-4">
      {/* This deliberately reproduces the real shell's desktop relationship: a sticky queue rail
          above the board (z-[100]) overlaps the left edge of an open thread drawer. The selectors
          are portaled to body, so this catches a portal that is opaque yet painted underneath rows. */}
      <aside data-fixture-board-rail className="pointer-events-none absolute inset-y-0 left-0 z-[100] w-[min(600px,58vw)] border-r border-border px-5 pt-20 [&>*]:pointer-events-auto max-[800px]:hidden">
        <p className="mb-3 text-[11px] font-medium uppercase tracking-wide text-muted">Active queue</p>
        {[
          "Trace the selector layering regression",
          "Exercise desktop and narrow viewport behavior",
          "Verify the drawer profile mutation",
          "Capture final visual proof",
        ].map((label) => (
          <div key={label} className="mb-2 rounded-lg border border-border bg-panel-2 px-3 py-2 text-[12px] leading-snug text-fg">
            {label}
          </div>
        ))}
        {/* A queue row at the same optical height as the upward-opening menu. Its text and pointer
            target reproduce the exact overlap without covering the drawer trigger itself. */}
        <div data-fixture-overlap-row className="absolute left-5 right-[-60px] top-[580px] rounded-lg border border-border bg-panel-2 px-3 py-2 text-[12px] leading-snug text-fg max-[800px]:hidden">
          Verify the drawer profile mutation
        </div>
      </aside>
      <section data-fixture-thread-drawer className="relative z-10 ml-[420px] flex h-[min(760px,calc(100vh-2rem))] w-[min(720px,calc(100vw-436px))] min-w-[320px] flex-col overflow-hidden border border-border bg-panel shadow-2xl max-[800px]:ml-0 max-[800px]:h-[min(680px,calc(100vh-2rem))] max-[800px]:w-full max-[800px]:min-w-0">
        <header className="shrink-0 border-b border-border px-4 py-3">
          <p className="text-[11px] text-muted">Fixture · transcript-only scroll</p>
          <h1 className="text-[15px] font-semibold">Long transcript with active work</h1>
        </header>
        <div data-drawer-transcript-scroll className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {Array.from({ length: 12 }, (_, index) => (
            <article key={index} className="mb-4 rounded-lg border border-border bg-panel-2 p-3 text-[13px] leading-relaxed text-fg/85">
              <strong className="block text-[11px] text-muted">Transcript message {index + 1}</strong>
              The transcript remains independently scrollable while the entire composer surface stays anchored below it.
            </article>
          ))}
        </div>
        <footer data-thread-chat-footer className="z-10 shrink-0 border-t border-border bg-panel">
          <div data-thread-action-bar className="px-3 py-3">
            <Composer
              surface="drawerFooterFixture"
              value={draft}
              onChange={setDraft}
              onSubmit={() => {}}
              placeholder="Follow up…"
              footer={(
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                  <ProfileGridSelector
                    groups={[{ id: "codex", label: "Codex", options: [{ model: "gpt-5.6-sol", label: "GPT-5.6 Sol", efforts: ["medium", "high"] }] }]}
                    value={profile}
                    onValueChange={setProfile}
                    ariaLabel="Thread model and effort"
                    menuAriaLabel="Choose Codex model and effort"
                    compact
                    side="top"
                    className="min-w-0 max-w-[72%] px-1.5 py-0.5"
                  />
                  <Select variant="readout" value={permission} onValueChange={setPermission} options={[{ value: "auto", label: "Auto" }, { value: "full", label: "Full access" }]} ariaLabel="Thread permission mode" side="top" className={`${PROMPT_CONTROL_TYPOGRAPHY_CLASS} px-1.5 py-0.5 text-fg/80`} />
                </div>
              )}
            />
            {/* Mirrors ThreadActionBar's `ops` slot: the strip lives INSIDE the padded box so the rows
                hang off the prompt and the box's pb (plus this pb-2) is their gap to the footer. */}
            <BackgroundOpsStrip slug={thread.id} className="px-1 pb-2 pt-1.5" />
          </div>
        </footer>
        <ThreadLifecycleFooter thread={thread} safeArea />
      </section>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
