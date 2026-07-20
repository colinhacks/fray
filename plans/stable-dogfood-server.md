# Stable dogfood server plan

## Decision

Make the real shared Fray board a **stable, built, explicitly promoted instance**. `fray-dev` must default to that mode. It must not watch the Fray checkout and it must not run Vite HMR. A source edit is therefore incapable of restarting, reloading, or shifting the board a person is using for real work.

Keep fast iteration, but move it to an explicit, per-agent **isolated snapshot preview**. A preview is built from an immutable capture of the agent's current working tree (including that agent's uncommitted edits), gets an ephemeral port and a fresh test project/state namespace, and is destroyed when QA finishes. It is never allowed to become the NUB board and never attaches to NUB's SQLite database, tmux socket, native sessions, or browser profile.

This is the smallest robust staged architecture. It reuses the existing project identity, ownership fencing, health endpoint, controlled shutdown, and resilient server-restart recovery, while removing the one property that makes NUB unreliable: a watcher whose input is a checkout being edited concurrently by many agents. A shared reverse proxy / blue-green control plane is useful later for near-zero-downtime releases, but is not required to make daily dogfooding safe and is unsafe to bolt onto the current single-writer state model.

## What exists now and why it fails for NUB

The current source launcher (`ui/packages/cli/src/index.ts` and `launcher.ts`) resolves the Git checkout into one project identity and state directory, allocates a port plus `port + 39000` for Vite HMR, and runs a durable supervisor. The supervisor (`dev-supervisor.ts`) watches the whole Fray workspace. Edits to server/shared/RPC replace the disposable control-plane child; edits to launcher/config also re-exec the supervisor. Web edits are served through Vite middleware and HMR from the same source checkout. The child owns HTTP, Vite, tailers, SQLite handles, wake scheduler, and WebSocket transports.

That is reasonable for a single developer scratch server, but not for the shared dogfood board: every agent's edit is an input to the same watcher. Child replacement closes HTTP/WebSocket/Vite state and changes `bootId`; browser clients necessarily reconnect or reload. If a source edit is temporarily invalid, the supervisor preserves the watcher and reports failure, but the real board has still been churned by unrelated development work.

The live NUB instance makes this concrete on 2026-07-14:

- port `4919` was held by a source-backed `fray-dev --foreground --no-app --port 4919` supervisor;
- its authoritative NUB state record was `ready`, bound to NUB's existing project ID and state directory, with a disposable child on `4919`;
- the direct `GET /health` probe timed out during the observation, while the child PID had recently changed. This is exactly the visible outage/churn the design must eliminate;
- the running NUB agents live in the repository-scoped Fray tmux socket and the durable NUB state directory. They are protected state, not preview input.

The existing restart model is valuable and should be retained: a durable supervisor owns project launch, the child is ownership-verified before readiness, `/health` includes project identity and an owner proof, and `--stop` deliberately preserves tmux agent sessions. The change is who may cause a restart, not a rewrite of lifecycle safety.

## Non-negotiable boundaries

| Boundary | Stable NUB board | Agent preview |
| --- | --- | --- |
| Fray source | Reads only a promoted immutable build; never watches the checkout | Reads only an immutable snapshot copied from the requesting agent's tree |
| UI artifact | Content-addressed build directory, immutable after manifest verification | Separate content-addressed preview artifact, deleted by cleanup policy |
| NUB project/state | Uses the existing NUB project ID, `~/.fray/projects/<nub-id>/ui.db`, and its existing tmux socket | A new disposable Git/project identity, state directory, managed tmux socket, and browser profile |
| Native agents / transcripts | The only writer/attacher for the real board; existing agents survive UI restart | No attach, resume, terminal input, dispatch, scheduler, wake, GitHub mutation, or native control against NUB |
| Promotion authority | Explicit human/operator command only | Cannot promote itself; it can emit a candidate build digest and QA evidence |

No server may have two writers for the same project state. In particular, copying or mounting NUB's `ui.db` into a preview is not acceptable: even SQLite WAL safety would not make its tmux bindings, scheduler, wake files, native transcript readers, or browser actions safe. A preview uses fixtures/seeded test state; a future read-only NUB mirror is a separate feature with every mutation and native-control endpoint denied server-side.

## Options considered

| Architecture | Strength | Failure against this use case | Decision |
| --- | --- | --- | --- |
| Current shared source + HMR/recycling | Zero command friction | Any agent edit mutates the real board; server edits restart it; source and real work are coupled | Reject as the dogfood default; retain only as an explicitly named legacy/scratch mode during migration |
| Stable built shared instance + explicit restart | One protected board, simple ownership, no surprise source-triggered restart | A requested promotion still has a brief controlled outage | **Adopt now** |
| Opt-in per-agent HMR | Very fast CSS/component iteration | Still needs a distinct source snapshot and state namespace; HMR alone does not solve server changes or state collision | Add later as a preview flag, never shared |
| Isolated ephemeral snapshot/preview | Tests exact uncommitted content without contaminating NUB | Needs fixture data and build time | **Adopt now** as the QA path |
| Per-agent Git worktrees | Strong source isolation and clean commits | Does not itself isolate runtime/state; costly/awkward for every tiny UI probe | Recommended for substantive code ownership, complementary to previews, not a server architecture |
| Blue-green servers behind a proxy | Can make artifact swaps nearly seamless | Current servers are exclusive producers/writers for one SQLite/tmux/native state; two active generations would race | Defer until an explicit standby/readiness/handoff protocol exists |

## Target commands and UX

These names are intentionally concrete enough to implement against the new launcher; aliases may be added only if they preserve the semantics below.

```sh
# Default: serve the last promoted immutable build for this Git project.
fray-dev                         # opens/reuses stable board
fray-dev --status                # says stable | starting | degraded, artifact digest, boot, port
fray-dev --stop                  # authenticated controlled stop; tmux/native agents remain

# An operator creates a candidate build and explicitly replaces the stable generation.
fray-dev build                   # capture current tree -> verify -> immutable artifact digest
fray-dev promote <digest>        # validates candidate, then controlled restart on same stable port
fray-dev restart                 # restart the same promoted digest; never rebuild from source
fray-dev rollback [<digest>]     # restart the previous known-good promoted digest

# An agent tests its own current, possibly uncommitted checkout contents.
fray-dev preview --name <agent-task> --no-app
fray-dev preview --name <agent-task> --hmr --no-app   # later, opt-in web-only speed path
fray-dev preview --status <id>
fray-dev preview --stop <id>
```

`fray-dev` with no subcommand must **never** silently fall back to source/HMR. If no promoted artifact exists, it must say so and print `fray-dev build` then `fray-dev promote <digest>` (or an explicit temporary `fray-dev source --unsafe-shared` during the migration window). `--dev` should remain a compatibility spelling only long enough to warn and map to the explicit unsafe command; it must not preserve the hazardous default.

`build` is a build/capture operation, not a deploy. It produces a manifest with: source snapshot digest, dependency lock digest, Node/runtime version, server/CLI/web artifact digests, asset manifest, build timestamp, and schema compatibility range. It does not stop or touch a running board. `promote` is the only command allowed to select a new real-board artifact and the only normal development command allowed to restart NUB.

## Artifact and source implementation

1. Add a production artifact builder for all launch-time code, not merely `web/dist`. The output must contain compiled/bundled JS for CLI/server/shared/RPC/runtime and the hashed web dist, with a locked dependency closure. The stable launcher executes the artifact entrypoint, never TypeScript modules in `ui/packages/**/src` and never workspace `node_modules` through source symlinks.
2. Store builds under a private Fray build root, e.g. `~/.fray/builds/<artifact-digest>/`, using a staging directory plus fsync/rename and a verified immutable manifest. Mark the artifact read-only after verification. Keep an atomically written per-project `stable.json` that names `current`, `previous`, compatibility metadata, and promotion time.
3. Treat the build root as tooling-owned. No preview, server process, or browser process writes artifacts after publication; no cleanup removes a digest referenced by `stable.json`, a live owner record, or a retained rollback slot.
4. Change the stable control-plane boot to `dev: false`: serve the artifact's static web dist, no Vite middleware, no watcher, and no HMR companion socket. The stable port allocator therefore reserves only the HTTP port. Preview HMR, if implemented later, reserves its private companion port.
5. Preserve the present source-backed supervisor only behind `fray-dev source --unsafe-shared`, with a high-visibility warning and no automatic invocation. It is a temporary developer escape hatch, not a NUB operation.

## Stable lifecycle, health, promotion, and rollback

The existing per-project launch lease remains the authority. Extend its status/health payload with `mode: "stable" | "preview" | "unsafe-source"`, `artifactDigest`, `generation`, and `role`. `GET /health` must retain project ID, canonical project path, boot ID, and owner proof; the launcher must reject a response whose role, digest, or proof is not expected.

### Stable start

1. Resolve the existing Git project identity exactly as today. For NUB this selects the current repository-scoped identity and its existing `~/.fray/projects/<nub-id>` state directory and managed tmux socket.
2. Read `stable.json`, verify its artifact manifest/digests/runtime compatibility before acquiring the launch lease, then fork that artifact's server entry with the pinned launch target.
3. Start the normal producers and publish ready only after HTTP, app socket, terminal transport, tailer, storage migration checks, and health all succeed. Keep the existing token-bound ownership verification.
4. Write status with the stable artifact digest and record a bounded local log for the generation. A healthy stable instance is unaffected by any write anywhere in the Fray source checkout.

### Explicit promotion/restart

1. `promote <digest>` first verifies the immutable artifact and runs its preflight against a **disposable test project/state**, not NUB. Required checks: build-manifest integrity, static asset availability, startup/readiness, API/health identity, migration compatibility, and a smoke browser test.
2. It atomically records a pending promotion intent containing old/new digest and expected project/owner identity. The old digest remains the rollback target.
3. It asks the current authenticated stable owner to drain: stop accepting new HTTP/WebSocket work, close Fray UI producers cleanly, retire exact status, and release only its control-plane delegate. It never kills tmux sessions or deletes/reinitializes NUB state.
4. Launch the new artifact on the **same** port and existing NUB launch target; wait for token-bound health and a readiness window (for example 10 seconds with HTTP, app socket connect, board snapshot, and no immediate process exit). Browser clients reconnect once and receive a new boot identity; this is an announced, bounded restart rather than surprise churn.
5. Commit `stable.json.current` only after the readiness window. On pre-ready failure, relaunch the old digest with the same target/port, preserve the failed candidate logs, and leave `current` unchanged. On post-ready health failure during the window, automatically roll back once; after that, mark degraded and require an explicit operator action rather than looping.

`restart` performs steps 3–4 with the same digest. `rollback` selects `previous` (or an explicitly retained digest) and uses the identical controlled handoff. `--status` must report the selected digest, generation, boot ID, last successful promotion, any pending/failed candidate, and the exact recovery command.

### NUB migration from `4919`

Do not move the live board's port, project ID, state directory, tmux socket, browser profile, or native threads.

1. Build and preflight the first immutable artifact from the current known-good Fray tree in an isolated test project. Do not install a global launcher until this plan's stable mode exists.
2. Snapshot only metadata needed for recovery (current launcher/supervisor records and selected artifact); do not copy or rewrite NUB `ui.db`, `.fray` thread files, tmux state, or transcripts.
3. Announce one maintenance restart. Authenticate the current `4919` owner, perform its normal graceful stop, then start the stable artifact on `4919` using the exact current NUB launch target. The existing server restart/rebind behavior must reopen the same DB and discover/reattach existing tmux sessions.
4. Verify health owner proof, board thread count/sample, existing terminal attach, and one browser reconnect before declaring success. If anything fails before the commit window, start the prior source-backed generation only through the authenticated legacy path, preserving the same NUB state; then diagnose offline. Do not start a second server against that state.
5. After the stable generation is proven, remove the source watcher from `4919` permanently. Source edits thereafter require `build` and `promote`.

## Preview architecture: reliable QA for uncommitted work

`fray-dev preview` captures the caller's Fray checkout at invocation into a temporary, read-only snapshot. It must include uncommitted, tracked, and intended untracked files subject to an explicit allowlist; it must exclude `.git`, `node_modules`, existing `dist`, artifacts, credentials, `.fray` runtime state, and browser profiles. The command records the source path, Git HEAD, dirty-file list, and snapshot digest so screenshot evidence can say exactly what was tested.

The preview then builds that snapshot into its own immutable preview artifact and launches it against a generated fixture Git repository with a distinct Fray project identity. Each preview receives:

- an atomically allocated HTTP port from a preview range (suggest `4930–5099`) and, only with `--hmr`, an independently reserved HMR port; allocator records both ports and refuses collision;
- `~/.fray/previews/<preview-id>/state/` rather than `~/.fray/projects/<nub-id>`;
- a unique managed tmux socket, browser profile, log directory, and test fixture project;
- `FRAY_WAKERS_OFF=1`, no production GitHub side effects, and a preview capability policy denying native attach/resume/input/dispatch and every mutation that could reach NUB;
- seeded deterministic board/session/transcript fixtures sufficient for desktop and narrow UI flows. Fixture setup must exercise the same public HTTP/WebSocket/RPC paths, not component-only mocks.

For code changes needing a real backend behavior rather than a visual fixture, the preview launches the snapshot's whole server against the disposable fixture project and allows only disposable preview-created agents. It never points to the developer's shared NUB checkout. This gives an agent a reliable end-to-end Chrome target for its own uncommitted server or UI changes even while other agents change the shared branch.

`--hmr` is phase two and web-only: it watches only the preview snapshot's `packages/web/src`, never the shared checkout, and can reload only that preview. Any server/shared/RPC/config edit causes that preview to rebuild/restart in isolation. HMR is a convenience after the snapshot preview contract is sound; it is not an availability dependency.

For substantial parallel changes, agents should still use per-agent Git worktrees. A worktree gives source ownership and clean commit boundaries; `preview` gives runtime isolation. The recommended worker instruction becomes: create/use your assigned worktree, run `fray-dev preview --name <task> --no-app` from that worktree, perform browser QA, retain its screenshot/log manifest, then stop the preview. The snapshot capture makes the same guarantee for a small uncommitted shared-checkout edit, but it cannot make concurrent file writes semantically coherent; the manifest should flag files whose mtime/content changed during capture and retry rather than silently test a torn tree.

## Port and state rules

- Stable: retain NUB `4919`; stable allocation may retain the current project-preferred port behavior, but only one HTTP port is required. Its launch ownership is keyed by existing canonical project ID/path.
- Preview: choose from a named range with a lease file containing preview ID, exact process generation, HTTP/HMR ports, snapshot digest, expiry, and owner token. Probe both ports before committing the lease. Never use the stable project's preferred port or state directory.
- Worktree: current identity logic already gives linked worktrees a worktree-scoped ID and managed worktree tmux socket. Stable worktree servers are not the default; a worktree normally runs a preview. If intentionally served, it remains a separate project and cannot reuse NUB state.
- Browser/app profiles: default Chrome QA attaches to the preview's isolated profile; do not reuse NUB's `browser-profile`. Preview cleanup removes only paths under its preview ID after its process-generation ownership is proved stale.

## Implementation stages

### Stage 0 — freeze the default and document the contract

Do not globally install the new source-backed default. Update launcher help, README, architecture docs, and worker QA instructions to state that the shared board is stable-only and previews are required for UI work. Keep the existing source supervisor available only by an explicit unsafe command while the stable artifact path is built.

### Stage 1 — artifact builder and stable server

Add artifact manifest/build/promotion modules and tests. Add `mode`/artifact metadata to status and health. Teach the CLI to serve/reuse/restart/rollback a selected immutable build with the current ownership fencing. Switch stable server boot to static assets and no watcher/Vite. Make bare `fray-dev` require a selected build and never infer source mode.

### Stage 2 — NUB migration and operational hardening

Preflight an artifact in a disposable project, make the single announced `4919` cutover, verify reattachment, then observe it through ordinary real work. Add promotion intent, readiness window, automatic one-shot rollback, status/log diagnostics, retention, and a tested authenticated recovery path.

### Stage 3 — snapshot previews and required browser QA

Implement safe snapshot capture, preview state/project provisioning, fixture seeding, port leases, capability denial, lifecycle cleanup, and screenshot/log manifest output. Require desktop plus relevant narrow Chrome QA and console checks against the agent's preview before UI work is handed off. Add opt-in snapshot-local web HMR only after this stage is stable.

### Stage 4 — optional blue-green research

Only pursue a proxy when a measurable restart budget justifies it. First design a true single-writer handoff: standby can validate static assets and bind only a private readiness port; producer/state/tmux ownership transfers atomically; proxy switches only after new owner health; old generation drains without concurrent DB/native access. Do not run two fully active Fray control planes against one project as a shortcut.

## Acceptance tests

### Stable board

- Edit every watched source category repeatedly while NUB stable mode is serving. Assert its PID, boot ID, WebSocket connection, page position, and `/health` response remain unchanged for a sustained interval; no Vite/HMR socket is bound.
- Start/reuse/status/stop tests retain the existing ownership-token and collision guarantees. Verify a stable artifact launch rejects a source path, missing/changed artifact file, manifest mismatch, wrong project, wrong owner proof, or incompatible schema before touching NUB state.
- With real or fixture NUB-equivalent threads and tmux sessions, `restart` retains project ID, DB, thread registry, session attachability, and native processes. It changes only the server boot ID. Verify desktop and narrow browser reconnect behavior and console cleanliness.
- Force candidate startup failures before readiness and after initial ready. Assert old digest is restored once, state is intact, `stable.json.current` is not falsely advanced, failure logs identify the digest, and no restart loop occurs.
- `rollback` restores the previous digest on the original port and verifies owner-bound health. Cleanup never deletes a current/previous/live artifact.

### Preview and QA

- Create a dirty source edit, start a preview, then change the shared checkout. Assert preview's build digest/files and rendered behavior remain the captured version; stable NUB's boot ID/PID/health remain unchanged.
- Run two previews concurrently (including `--hmr` when implemented). Assert unique HTTP/HMR leases, state dirs, tmux sockets, and browser profiles; a deliberate port collision fails without killing either process.
- Exercise preview RPC/WebSocket UI flows with fixture data at desktop and narrow widths using `agent-browser`; save and visually inspect screenshots and collect console logs. Verify preview-only controls cannot attach to a NUB pane, open NUB's state DB, dispatch to NUB, mutate a NUB thread, or use NUB browser-profile paths.
- Inject a snapshot copy race and assert capture retries/fails with an explicit dirty-file diagnostic rather than producing an unrecorded mixed tree.
- Verify preview stop/crash cleanup cannot remove any path outside its preview root and cannot affect NUB `4919`, its state records, or its tmux sessions.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Artifact builder accidentally imports source/workspace symlinks | Make artifact provenance a manifest assertion and an integration test that renames the source checkout after launch; stable server must continue serving |
| Schema/data migration is irreversible | Require compatibility preflight and backup/recovery policy before promotion; do not claim blue-green until migration ownership is explicit |
| A preview looks correct but fixture misses a production edge | Keep deterministic fixtures broad, add regression seeds from bugs, and reserve an explicitly designed future read-only mirror rather than weakening NUB isolation |
| Build/promotion friction encourages unsafe source mode | Make build incremental/content-addressed, previews one command, and surface actionable commands; warn loudly on unsafe source mode and retire it after migration |
| Existing processes/state are harmed during cutover | Use current authenticated ownership and controlled shutdown only; preserve NUB project ID, port, state dir, tmux socket, and sessions; never delete/recreate state |
| Two agents edit one shared file during snapshot | Prefer worktrees for substantive work; snapshot records content digest and rejects a changing capture rather than pretending isolation |

## Recommendation for the global launcher

Do **not** install the current source-backed `fray-dev` as the global/default launcher for NUB. Ship the stable artifact path first, make `fray-dev` serve the last explicitly promoted immutable artifact, and provide `fray-dev preview` as the normal agent QA command. Retain current shared HMR only as an explicit, temporary unsafe escape hatch; do not use it on NUB `4919`.
