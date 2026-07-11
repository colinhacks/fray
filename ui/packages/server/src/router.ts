import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { query, mutation } from "@fray-ui/rpc/server"
import {
  BoardSnapshot,
  DispatchInput,
  FollowUpInput,
  GithubStatus,
  GithubItem,
  GithubListInput,
  GithubBatchInput,
  GithubBatchResult,
  Settings,
  TranscriptMessage,
} from "@fray-ui/shared"
import type { AppContext } from "./context.ts"
import { runThreadUpdate } from "./fray.ts"
import { repairThreadFile } from "./repair.ts"
import { resumeThread } from "./resume.ts"
import { readThreadTranscript, readTranscriptFile } from "./transcript.ts"
import { openExternalUrl } from "./open-external.ts"
import { ghInstalled, ghAuthed, ghRepo, listItems, hydrateIssue, hydratePr, renderGithubPrompt, effectiveTemplate, DEFAULT_ISSUE_PROMPT, DEFAULT_PR_PROMPT } from "./github.ts"
import { slugify, resolveSlug } from "./dispatch.ts"
import * as tmux from "./tmux.ts"

const SlugInput = z.object({ slug: z.string() })

// The typed RPC surface. Every handler is thin: state mutations go through fray scripts
// (thread files) or tmux (agents), then rebuild the board so a fresh snapshot fans out on SSE.
export function createRouter(ctx: AppContext) {
  const frayDir = join(ctx.project.dir, ".fray")

  // Resolve the repo owner/name for a GitHub call. A POSITIVE boot cache short-circuits (stable, no
  // gh call — the common path). A null/absent cache is NOT trusted: it can be the boot race (cache not
  // resolved yet) OR an unauthed-at-boot detection (`gh repo view` needs auth), so fall back to a live
  // ghRepo and WARM the cache on success — this makes a post-boot `gh auth login` light up the feature
  // without a server restart. Never throws (ghRepo swallows failures → null).
  async function resolveRepo(): Promise<string | null> {
    const cached = ctx.github?.nameWithOwner
    if (cached) return cached
    const live = await ghRepo(ctx.project.dir)
    if (live) {
      if (ctx.github) {
        ctx.github.inRepo = true
        ctx.github.nameWithOwner = live
      } else {
        ctx.github = { installed: true, inRepo: true, nameWithOwner: live }
      }
    }
    return live
  }

  return {
    board: query({
      output: BoardSnapshot,
      handler: () => ctx.board.snapshot(),
    }),

    threadBody: query({
      input: SlugInput,
      output: z.object({ markdown: z.string() }),
      handler: async ({ input }) => {
        // Shape-guard the slug like every other file-resolving input (board id regex) — a bare
        // join would happily read `<frayDir>/../../x.md`.
        if (!/^[a-z0-9][a-z0-9-]*$/.test(input.slug)) return { markdown: "" }
        try {
          return { markdown: readFileSync(join(frayDir, `${input.slug}.md`), "utf8") }
        } catch {
          return { markdown: "" }
        }
      },
    }),

    // The full conversation, parsed mechanically from the session JSONL. Chat-first UI renders
    // this by default; the raw terminal is the power-user toggle.
    threadTranscript: query({
      input: SlugInput,
      output: z.object({ messages: z.array(TranscriptMessage) }),
      handler: async ({ input }) => {
        // Registry row → its session's transcript; foreign slug (a session id) → resolved directly; else [].
        return { messages: readThreadTranscript(ctx.project, ctx.storage, input.slug) }
      },
    }),

    // A live/stale background sub-agent's OWN transcript, for the drill-in drawer that overlays the
    // thread. Resolves the tracked child (thread slug + dispatch tool_use id) to its output JSONL, then
    // parses it with the same mechanical extractor. Never throws: an unknown/dropped id (completed
    // children leave tracking on their terminal notification) or an unreadable file → an empty
    // transcript with state "gone", which the drawer renders as its quiet "unavailable" state.
    subAgentTranscript: query({
      input: z.object({ slug: z.string(), id: z.string() }),
      output: z.object({ messages: z.array(TranscriptMessage), state: z.enum(["running", "stale", "done", "gone"]) }),
      handler: async ({ input }) => {
        const info = ctx.tailer.subAgent(input.slug, input.id)
        if (!info) return { messages: [], state: "gone" as const }
        const messages = info.outputFile ? readTranscriptFile(info.outputFile) : []
        return { messages, state: info.state }
      },
    }),

    dispatch: mutation({
      input: DispatchInput,
      output: z.object({ slug: z.string(), sessionId: z.string() }),
      // Forward the picker-selected backend into the dispatch opts seam (Codex-support epic, Phase 3).
      // Omitted ⇒ the dispatcher defaults to "claude", so an old client (no backend field) is
      // byte-identical. The resume path needs NO analog — resume reads the backend from the row's
      // `backend` column (backendFor(row.backend)), which dispatch already stamped for a codex thread.
      handler: ({ input }) => ctx.dispatcher.dispatch(input, { backend: input.backend }),
    }),

    // Cold-adopt a pre-existing thread (no session row): spawn a fresh worker on its file.
    adoptThread: mutation({
      input: z.object({ slug: z.string(), message: z.string().optional() }),
      output: z.object({ slug: z.string(), sessionId: z.string() }),
      handler: ({ input }) => ctx.dispatcher.adopt(input.slug, input.message),
    }),

    followUp: mutation({
      input: FollowUpInput,
      handler: async ({ input }) => {
        // Live → inject; dead → resume the pinned conversation. Shared with the wakers scheduler.
        resumeThread({ project: ctx.project, storage: ctx.storage, board: ctx.board, getSettings: ctx.getSettings, backendFor: ctx.backendFor }, input.slug, input.message)
      },
    }),

    // Archive = hide the row (UI flag) AND settle the fray doc: a non-terminal thread gets
    // status: done written to its frontmatter. Respawn/resume un-archives the row.
    archiveThread: mutation({
      input: SlugInput,
      handler: async ({ input }) => {
        ctx.storage.setArchived(input.slug, true)
        const t = (await ctx.board.snapshot()).threads.find((x) => x.id === input.slug)
        if (t && t.status !== "done" && t.status !== "dismissed") {
          await runThreadUpdate(ctx.project.dir, input.slug, ["--status", "done"]).catch(() => {})
        }
        void ctx.board.rebuild() // .fray changed; respond now, snapshot lands via SSE (watcher also fires)
      },
    }),

    markRead: mutation({
      input: SlugInput,
      handler: async ({ input }) => {
        ctx.storage.markRead(input.slug)
        ctx.board.refresh() // storage-only change — overlay is enough
      },
    }),

    // Interaction clearance (session-first queue mechanics): opening a thread records seen_at, which
    // clears it from the Needs-you queue until NEW activity re-arms it. Sets BOTH seen_at and
    // last_read_at/unread — one clearance covers the new queue and the old unread badge. No-op for a
    // foreign thread (no registry row — foreign threads never enter the queue).
    threadSeen: mutation({
      input: SlugInput,
      handler: async ({ input }) => {
        if (!ctx.storage.getSession(input.slug)) return
        const at = new Date().toISOString()
        ctx.storage.setSeenAt(input.slug, at)
        ctx.storage.markRead(input.slug, at)
        ctx.board.refresh() // storage-only change — overlay is enough
      },
    }),

    // Explicit lifecycle write for session threads: Archive (the done-card button / row action) and
    // Reopen. This is the ONLY writer of state='archived' — the done fence itself mutates nothing
    // (maintainer-settled). Touches only ui.db; never the .fray legacy files.
    setThreadState: mutation({
      input: z.object({ slug: z.string(), state: z.enum(["open", "archived"]) }),
      handler: async ({ input }) => {
        if (!ctx.storage.getSession(input.slug)) throw new Error(`no session registered for ${input.slug}`)
        ctx.storage.setState(input.slug, input.state)
        ctx.board.refresh() // storage-only change — overlay is enough
      },
    }),

    // Dismiss/forget: the HARD-DELETE verb for a stalled/exited phantom the user wants GONE, not merely
    // shelved (Archive = state='archived', still listed in Inactive). Removes the registry row AND
    // tombstones its transcript id so a log-dir rescan / foreign-discovery can never resurrect it, then
    // drops the tailer's in-memory state. GATED on a NOT-live row: only a thread whose derived runtime is
    // "exited" (a dead pane, or a boot-failure "Stalled" session degradeIfNoTranscript flags) can be
    // forgotten — a genuinely-live session (running / turn-idle / perm-prompt) is refused so it can't be
    // yanked out from under itself. Idempotent: an already-forgotten slug no-ops.
    forgetThread: mutation({
      input: SlugInput,
      handler: async ({ input }) => {
        if (!ctx.storage.getSession(input.slug)) return // already gone — idempotent
        const t = (await ctx.board.snapshot()).threads.find((x) => x.id === input.slug)
        if (t && t.runtime !== "exited") {
          throw new Error("only a stalled or exited session can be dismissed — archive a live one instead")
        }
        tmux.killSession(input.slug) // tear down any lingering (remain-on-exit) pane before we forget it
        ctx.storage.forgetSession(input.slug)
        ctx.tailer.forget(input.slug)
        ctx.board.refresh() // storage-only change — the removed row fans out as a delete delta on SSE
      },
    }),

    // A plan artifact's markdown (.fray/plans/*.md — no schema, no validation). The path is the
    // PlanView.path shipped on the board snapshot; a strict shape check (single filename segment,
    // .md) forecloses traversal.
    planBody: query({
      input: z.object({ path: z.string() }),
      output: z.object({ markdown: z.string() }),
      handler: async ({ input }) => {
        const m = input.path.match(/^\.fray\/plans\/([A-Za-z0-9][A-Za-z0-9._ -]*\.md)$/)
        if (!m) return { markdown: "" }
        try {
          return { markdown: readFileSync(join(frayDir, "plans", m[1]), "utf8") }
        } catch {
          return { markdown: "" }
        }
      },
    }),

    // The thread's scratchpad (.fray/scratch/<session-id>.md) — the worker's compaction-proof
    // working memory, rendered as the thread's doc tab. "" when never provisioned / foreign.
    threadScratchpad: query({
      input: SlugInput,
      output: z.object({ markdown: z.string() }),
      handler: async ({ input }) => {
        const row = ctx.storage.getSession(input.slug)
        if (!row) return { markdown: "" }
        try {
          return { markdown: readFileSync(join(frayDir, "scratch", `${row.session_id}.md`), "utf8") }
        } catch {
          return { markdown: "" }
        }
      },
    }),

    // Route a link clicked inside the chromeless Chrome --app window to the OS default browser.
    // Without this, http(s) links open within our dedicated user-data-dir profile — the
    // "anonymous Chrome window" the user reported. Validation lives in open-external.ts, which
    // rejects any non-http(s) scheme and spawns `open`/`xdg-open` with an args array (no shell).
    openExternal: mutation({
      input: z.object({ url: z.string() }),
      handler: async ({ input }) => {
        openExternalUrl(input.url)
      },
    }),

    markComplete: mutation({
      input: SlugInput,
      handler: async ({ input }) => {
        await runThreadUpdate(ctx.project.dir, input.slug, ["--status", "done"])
        ctx.storage.markRead(input.slug)
        void ctx.board.rebuild() // .fray changed; respond now, snapshot lands via SSE (watcher also fires)
      },
    }),

    // Assign ANY status (the "Mark as <status>" split button): the exact fray status the human picks.
    // Dismissing also ends the live agent session (same side-effect the Dismiss verb carries).
    setThreadStatus: mutation({
      input: z.object({ slug: z.string(), status: z.enum(["active", "planning", "planned", "needs-human", "blocked", "done", "dismissed"]) }),
      handler: async ({ input }) => {
        await runThreadUpdate(ctx.project.dir, input.slug, ["--status", input.status])
        if (input.status === "done" || input.status === "dismissed") ctx.storage.markRead(input.slug)
        if (input.status === "dismissed") {
          tmux.killSession(input.slug)
          ctx.storage.setExited(input.slug, true)
        }
        void ctx.board.rebuild() // .fray changed; respond now, snapshot lands via SSE (watcher also fires)
      },
    }),

    // One-click recovery for a malformed thread file: PREPEND minimal frontmatter to a thread .md that
    // has none (see repair.ts for the guards + why it's deliberately conservative), then rebuild the
    // board so the healed thread appears in the queue/status system. Repairs the missing-frontmatter
    // case ONLY — the write hook already blocks compliant workers; this catches the stragglers.
    repairThread: mutation({
      input: z.object({ file: z.string() }),
      output: z.object({ slug: z.string() }),
      handler: async ({ input }) => {
        const { slug } = repairThreadFile(frayDir, input.file)
        void ctx.board.rebuild() // .fray changed; respond now, fresh snapshot fans out on SSE (watcher also fires)
        return { slug }
      },
    }),

    dismissThread: mutation({
      input: SlugInput,
      handler: async ({ input }) => {
        await runThreadUpdate(ctx.project.dir, input.slug, ["--status", "dismissed"])
        void ctx.board.rebuild() // .fray changed; respond now, snapshot lands via SSE (watcher also fires)
      },
    }),

    // Regenerate the thread's display name: inject a bare `/rename` (Claude auto-generates a fresh
    // name, no agent turn burned) into the live idle session. The tailer reads the resulting
    // custom-title record like an ai-title; title-sync then persists it into the fray doc for
    // auto-titled threads.
    renameThread: mutation({
      input: SlugInput,
      handler: async ({ input }) => {
        if (!tmux.isLive(input.slug)) throw new Error("agent session is not running — resume it first")
        tmux.sendKeys(input.slug, "/rename")
      },
    }),

    killAgent: mutation({
      input: SlugInput,
      handler: async ({ input }) => {
        tmux.killSession(input.slug)
        ctx.storage.setExited(input.slug, true)
        ctx.board.refresh() // storage-only change — overlay is enough
      },
    }),

    settingsGet: query({
      output: Settings,
      handler: async () => ctx.getSettings(),
    }),

    settingsSet: mutation({
      input: Settings,
      output: Settings,
      handler: async ({ input }) => ctx.setSettings(input),
    }),

    // Clear the stored settings blob so defaults (incl. the shipped default preamble) apply again.
    settingsReset: mutation({
      input: z.object({}),
      output: Settings,
      handler: async () => ctx.resetSettings(),
    }),

    // The shipped GitHub batch-dispatch prompt templates (single source of truth: server/github.ts).
    // The Settings UI reads these to prefill the editors for editing and to power "reset to default";
    // an empty/unset githubIssuePrompt/githubPrPrompt setting means the server uses exactly these.
    githubPromptDefaults: query({
      output: z.object({ issue: z.string(), pr: z.string() }),
      handler: async () => ({ issue: DEFAULT_ISSUE_PROMPT, pr: DEFAULT_PR_PROMPT }),
    }),

    // ---- GitHub-first batch dispatch ----

    // gh availability: installed (cached, else live) + inRepo/nameWithOwner (cache-warmed resolveRepo)
    // + a LIVE authed re-check (never cached — a mid-session `gh auth login` reflects on the next
    // query). The repo is resolved only when authed (gh repo view needs auth), so a cached-negative
    // inRepo from an unauthed/racy boot never sticks. Never throws (all probes degrade to false/null).
    githubStatus: query({
      output: GithubStatus,
      handler: async () => {
        const installed = ctx.github?.installed ?? (await ghInstalled())
        if (!installed) return { installed: false, inRepo: false, nameWithOwner: null, authed: false }
        const authed = await ghAuthed()
        const nameWithOwner = authed ? await resolveRepo() : (ctx.github?.nameWithOwner ?? null)
        return { installed: true, inRepo: nameWithOwner !== null, nameWithOwner, authed }
      },
    }),

    // The repo's issues or PRs, gh-sorted (recency or reactions). Empty when this isn't a GitHub repo.
    // resolveRepo warms/uses the cache with a live fallback (so a post-boot sign-in works). A gh error
    // (rate limit / network) propagates → surfaced to the client as a failed query (risk 7), rather
    // than silently reading as "no items".
    githubList: query({
      input: GithubListInput,
      output: z.object({ items: z.array(GithubItem) }),
      handler: async ({ input }) => {
        const repo = await resolveRepo()
        if (!repo) return { items: [] }
        return { items: await listItems(repo, input.kind, input.sort, input.limit) }
      },
    }),

    // Spin up one fray thread per checked item: hydrate each fresh from gh, template a server-side
    // prompt (single source of truth, unit-tested), then REUSE ctx.dispatcher.dispatch (no new spawn
    // logic). SEQUENTIAL — a burst of 20 concurrent tmux spawns would hammer the box (risk 5). A
    // per-item failure is captured in `failed[]` and never aborts the rest of the batch.
    githubDispatchBatch: mutation({
      input: GithubBatchInput,
      output: GithubBatchResult,
      handler: async ({ input }) => {
        const repo = await resolveRepo()
        if (!repo) throw new Error("not a GitHub repo")
        // Read the templates ONCE per batch: the user's Settings override (githubIssuePrompt /
        // githubPrPrompt) when non-blank, else the exported default (effectiveTemplate decides).
        const settings = ctx.getSettings()
        const dispatched: { number: number; kind: string; slug: string }[] = []
        const failed: { number: number; kind: string; error: string }[] = []
        for (const it of input.items) {
          try {
            // Explicit title skips the fallback-chop so the slug reads investigate-owner-repo-N. RESERVE
            // the slug here with the SAME predicate dispatch uses (existing .fray file / registry row)
            // and pass it EXPLICITLY, so the prompt's THREAD tag equals the real dispatched slug even on
            // a collision (re-dispatch / duplicate items) — otherwise the worker would write a ghost
            // .fray/<base>.md disjoint from the -2 registry row (resolveSlug is idempotent on a free slug).
            const title = `${it.kind === "issue" ? "Investigate" : "Review"} ${repo}#${it.number}`
            const slug = resolveSlug(frayDir, slugify(title), (s) => ctx.storage.getSession(s) !== undefined)
            const template = effectiveTemplate(it.kind, it.kind === "issue" ? settings.githubIssuePrompt : settings.githubPrPrompt)
            const hydrated = it.kind === "issue" ? await hydrateIssue(repo, it.number) : await hydratePr(repo, it.number)
            const prompt = renderGithubPrompt(template, repo, hydrated, slug, it.kind)
            const res = await ctx.dispatcher.dispatch({
              prompt,
              title,
              slug,
              model: input.model,
              effort: input.effort,
              permissionMode: input.permissionMode,
            })
            dispatched.push({ number: it.number, kind: it.kind, slug: res.slug })
          } catch (e) {
            failed.push({ number: it.number, kind: it.kind, error: (e as Error).message.slice(0, 120) })
          }
        }
        return { dispatched, failed }
      },
    }),
  }
}

export type AppRouter = ReturnType<typeof createRouter>
