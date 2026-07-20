# Persistent stacked questions — decision memo

Status: design only; markdown-question implementation remains unstarted

Re-audited: 2026-07-13 against the current dirty worktree

Source handoff: `plans/unstarted-fray-handoff.md`, item 2

Maintainer decisions required: the four original forks plus the product-policy choices in [Decision checkpoint](#decision-checkpoint)

## Outcome

Fenced markdown questions are still positional. The current client makes only one trailing assistant message interactive, and the current server keeps only a trailing-question boolean which any later user turn clears. No stable question identity, durable addressed state, per-question dismiss action, or open-question collection exists.

The dirty tree does contain a substantial, separately scoped typed-interaction system and a started, read-only Claude Agent SDK adapter. They provide useful patterns for SQLite persistence, session ownership, compare-and-swap revisions, idempotent response IDs, invalidations, concurrent-client reconciliation, provider delivery, Queue membership, and a future typed Claude path. They do **not** implement markdown-question stacking. The smallest robust design should reuse those patterns but keep markdown questions and provider-native interactions as different resources and delivery paths in the first cut.

The recommended choices below are proposals, not decisions. The design is implementation-ready only after the maintainer confirms the four original forks and the additional policy choices enumerated at the checkpoint.

## Current-state evidence

### Markdown questions remain unstarted

- `ui/packages/web/src/lib/answering.ts` still exposes one `liveMsg`. `useLiveAnswering` scans backward, returns an empty block list at the first later non-empty user message, and attaches one `MessageAnswering` controller only to the last substantive assistant message.
- `ChatView.tsx` and `TodosView.tsx` still pass `answering` only when `m === liveMsg`. Historical question blocks render read-only.
- `questionBlocks.ts` parses and composes blocks but has no question identity or lifecycle. Its `BlockAnswer` state is keyed only by a block's positional number within the one live message.
- `TranscriptMessage` in `ui/packages/shared/src/index.ts` has no message ID. Claude parsing sees a raw `message.id` internally and Codex parsing sees append-only rollout records, but neither source identity crosses the transcript API.
- `tailer.ts` still maintains `lastAssistantHasQuestion`. Assistant final text replaces the boolean; any later user message clears it. `pendingQuestion` remains `turn === "idle" && lastAssistantHasQuestion`.
- `board.ts` still consumes that one boolean. It has no open-question count or per-question state.
- Searches under `ui/packages` found no addressed-question store, `questionId`, `openQuestions`, `dismissQuestion`, question revision, or expected-question-revision API.
- The only relevant tests assert the current positional behavior: tailer tests say a later user turn clears the prior question, board tests cover only the trailing boolean, and question-block tests cover parsing/composition rather than persistence or concurrency.

### Current work that materially constrains the design

The dirty tree adds `ui/packages/shared/src/interactions.ts`, `ui/packages/server/src/interaction-store.ts`, interaction RPCs in `router.ts`, Queue integration in `board.ts`, and `InteractionCards.tsx`. That system already supplies:

- durable SQLite journals scoped by project, thread slug, session ID, session epoch, and capability revision;
- opaque interaction IDs, response IDs, record revisions, compare-and-swap mutations, idempotent replay, expiration, and session-replacement cancellation;
- payload-free client invalidations and fail-closed reconciliation after ambiguous network failures;
- separate “pending/readable” and “actionable/needs user” Queue bits;
- provider-owned delivery states so a response can be queued/sent without being falsely treated as acknowledged.

Those are implementation precedents, not a reason to convert fenced markdown into provider interactions. A fenced question is agent-authored markdown discovered in an append-only conversation and answered by a conversational follow-up. A provider-native interaction is created by a trusted adapter from a structured request, has provider request/turn/item identity, and must be resolved through its provider bridge. Treating them as one resource would blur trust, identity, cancellation, and delivery semantics.

The current native-input infrastructure also constrains delivery ownership:

- `ui/packages/server/src/resume.ts` is the single live-inject/dead-resume conversational path. It already fences session and `runtime_generation` changes, protects permission handoffs, and reattaches the backend-native ID (`agent_session_id ?? session_id`). Question delivery must call an expectation-aware extension of this path; it must not add a parallel tmux sender.
- `ui/packages/server/src/permission-controller.ts` owns serialized, durable Codex input. Its `queueFollowUp(slug, message, deliveryId)` already deduplicates a delivery ID, persists before typing/submitting, and waits for a transcript witness. Question delivery must use this controller for live Codex and share its per-thread native-transport serialization with resume/permission changes.
- `ui/packages/server/src/backend/claude-agent-sdk.ts`, `claude-agent-sdk-protocol.ts`, their tests/fixtures, and `ui/packages/claude-agent-sdk-runtime/` are **started read-only native-interaction infrastructure**, not hypothetical files and not enabled markdown delivery. They are the intended future typed Claude request/response path if fork 4 later expands. The markdown first cut neither deletes nor writes through them.

### Verification performed during this audit

The following focused command passed 200 tests:

```sh
cd ui
pnpm exec node --test \
  packages/web/src/lib/questionBlocks.test.ts \
  packages/web/src/lib/answersMessage.test.ts \
  packages/server/src/tailer.test.ts \
  packages/server/src/board.test.ts \
  packages/server/src/interaction-store.test.ts \
  packages/server/src/interaction-router.test.ts
```

That green baseline confirms current behavior; it does not verify the proposed feature.

## Required invariants

Regardless of the maintainer selections, a complete implementation should preserve these invariants unless the selected fork explicitly waives one:

1. A question is a durable resource, not a property of “the latest message.”
2. Multiple fenced blocks in one assistant message and blocks across later assistant messages have independent lifecycle state.
3. Assistant event lines, tool-only activity, later assistant prose, and unrelated user steers do not change a question's lifecycle.
4. Only an explicit action naming the question may answer or dismiss it, unless the maintainer deliberately selects the heuristic policy in fork 2.
5. A question action is accepted at most once across concurrent clients. An ambiguous client failure must reconcile from server truth before enabling a different response.
6. Queue and transcript surfaces derive from the same server-authoritative pending/actionable set.
7. Server restart and browser reload preserve state. Replacing the registered conversation invalidates the old conversation's questions; restarting or resuming the same conversation does not.
8. An answer to an older question carries server-sourced question context to the worker. The client cannot substitute the quoted question text.
9. Fenced markdown questions never use fragile TTY selector/control injection. Provider-native requests keep their existing structured or terminal-specific path.
10. Every native write is fenced by the expected Fray `sessionId`, the **current** `runtimeGeneration`, and a durable delivery ID. The final ownership compare-and-swap occurs immediately before durable enqueue or live injection, and native transport operations are serialized per thread with permission changes and resume.
11. “Pending/readable” and “actionable/needs user” are separate server truths. Queued, delivering, ambiguous, and recovery-required answers cannot disappear merely because they no longer accept a second answer.
12. Question source identity and block ordinals are assigned by one canonical server projector before the 300-message presentation cap; discovery and rendering consume that metadata rather than independently reparsing different message shapes.

## Proposed resource model

This section describes the smallest robust server-authoritative model. It is conditional on the maintainer choosing fork 1's server option and fork 4's markdown-only first cut.

### Canonical source-message projector and pre-cap identity

Add optional `sourceMessageId` and server-projected question-block metadata to `TranscriptMessage`. A single pure projector must consume raw records with their transcript incarnation, zero-based line ordinal, and start byte offset, produce renderable messages and finalized question sources, assign identities, and only then apply the current `MAX_MESSAGES = 300` presentation cap. Discovery consumes the uncapped projected stream from the activation cursor; the browser consumes the capped messages plus the paginated question snapshot. Timestamps and content hashes are never identities because either may repeat.

Offsets are meaningful only inside a durable transcript incarnation. Add `question_transcript_binding` keyed by `(threadSlug, sessionId)` with `nativeTranscriptId`, canonical path, filesystem device/inode/birthtime where available, a persisted random `transcriptEpoch`, last observed size, and prefix/tail anchor digests. `nativeTranscriptId` is the current backend identity (`agent_session_id` for Codex; the bound `transcript_id ?? session_id` for Claude), not the Fray ownership ID.

- Ordinary append growth with the same file identity and matching anchors preserves the epoch.
- A smaller file, changed inode/birthtime, changed bytes before an already-consumed cursor, changed native transcript ID, or unproved path rebind creates a new epoch before any offset is reused. Source IDs therefore include `<nativeTranscriptId>:<transcriptEpoch>:<first-byte-offset>`.
- A Claude discovery rebind may preserve the epoch only when a bounded byte-for-byte anchor proves the new path is the same append-only transcript. A rename/rotation may likewise preserve it only when the old prefix and continuation boundary are proven. Otherwise it is a new incarnation.
- Existing questions from an old epoch remain durable/readable for the same Fray session, but no in-flight attempt may cross epochs. A new epoch gets its own activation row. Proven empty continuation rotation may use `from-start`; truncation/rewrite or an ambiguous rebind enters `activation_error` until the maintainer chooses `new-only`, trailing import, or selected backfill. It never silently rescans offset zero.

Normative Claude projection:

- An ordinary assistant source unit begins at the first assistant record after a user or emitted event boundary. Its locator is that record's immutable start byte offset (line ordinal is retained for diagnostics).
- A non-empty raw `message.id` permits subsequent assistant records with the same ID to merge only while they are merge-contiguous under today's transcript rule. Ignored sidecars do not break contiguity; a rendered user bubble or emitted `kind:"event"` does. A repeated Claude ID after such a break starts a new unit and therefore a new identity.
- A missing/invalid Claude `message.id` never authorizes merging: each assistant record is its own source unit. This avoids collapsing unrelated anonymous records. The source ID is `claude:<nativeTranscriptId>:<transcriptEpoch>:<first-byte-offset>`; the raw Claude ID is diagnostic metadata, not uniqueness authority.
- Preserve raw content-block order. Text blocks and tool blocks contribute to presentation exactly once. Question `blockOrdinal` is the zero-based lexical order of question fences across the unit's text blocks after applying the same `pushTextPart` separators used by rendering. Event messages have their own `claude-event:<nativeTranscriptId>:<transcriptEpoch>:<byte-offset>` presentation identity, break the merge chain, and are never discoverable sources.
- A Claude unit is discoverable only when its authoritative assistant record says `message.stop_reason === "end_turn"`. `tool_use`, missing/unknown stop reasons, half-written records, and unterminated fences do not materialize questions. If split records share an ID and stop reason, discovery runs once over the completed merged unit.

Normative Codex projection:

- A source unit is one explicit turn: it begins at `event_msg/task_started`, or defensively at the first assistant/tool event after a user message when the opening bracket is absent, and ends at `event_msg/task_complete`. Its identity is `codex-turn:<nativeTranscriptId>:<transcriptEpoch>:<opening-byte-offset>`.
- `event_msg/agent_message` with `phase:"commentary"`, tool calls, and tool results remain ordered presentation parts but are **not** question sources. A fence quoted in commentary never becomes actionable.
- The authoritative final segment is `task_complete.last_agent_message` when non-empty; otherwise it is the last non-empty `agent_message` with `phase:"final_answer"` in that turn. An equal task-complete echo replaces/deduplicates the earlier final segment; a differing task-complete value is authoritative and is not appended as a second final. A turn without either final source creates no questions.
- Question `blockOrdinal` is zero-based lexical order only within that authoritative final markdown. Commentary blocks and tool parts do not consume ordinals. `response_item/message` echoes remain excluded, matching `parseCodexLine`.
- The unit finalizes only on `task_complete`; a partial current turn does not materialize questions. Appending later turns cannot change the opening offset or ordinals of a finalized turn.

The shared projector emits for each question `{ sourceMessageId, blockOrdinal, rawInfoString, rawBody, sourceDigest, finalizedAtCursor }`. The browser receives those exact ordinals; `questionBlocks.ts` becomes the presentation/parser implementation shared through a backend-neutral package rather than a second regex. The digest covers UTF-8 bytes of the canonical info string, LF/NFC-normalized body, and ordinal. A projector change requires a schema/projector version and a migration policy; it may not silently remap existing rows.

The durable source key is:

```text
(threadSlug, sessionId, nativeTranscriptId, transcriptEpoch,
 projectorVersion, sourceMessageId, blockOrdinal)
```

Materialize an opaque random `questionId` and keep a unique constraint on that composite. RPC mutations name the opaque ID plus current thread/session scope; the composite is lookup/presentation metadata, never client mutation authority. Optimistic client-only messages have no source identity and cannot own questions.

### Conversation generation versus process generation

The session registry currently has two different notions that must not be conflated:

- `session.session_id` is the Fray-minted durable ownership ID for a registered slug. A replacement/adoption of the slug receives a new value. For Claude it is also the pinned backend-native session ID; for Codex it remains the Fray ownership/scratchpad key while the discovered native rollout ID is stored separately in `agent_session_id`.
- `session.runtime_generation` is the process-owner generation for that same registry row. It increments when Fray begins a respawn/reattach; it does not identify a new conversation. Native resume always targets `agent_session_id ?? session_id`.

Questions are owned by `(threadSlug, sessionId)` and their source includes native transcript incarnation. Equality with the **discovery-time** generation must not be required to answer, because a same-conversation resume preserves questions. Each action snapshots the current `{ sessionId, runtimeGeneration, nativeTranscriptId, transcriptEpoch, exactPaneIdentity, deliveryId }` and carries that original expectation through every transport call and multi-tick controller step. If a dead-session resume legitimately increments the generation, the expectation-aware resume transaction records the successor generation/exact pane on that attempt before any message can be submitted. Any unrelated generation, transcript incarnation, or pane change invalidates the attempt and contacts no replacement pane.

Session replacement/deletion should terminalize every nonterminal old-session question and attempt atomically with the registry mutation, just as the interaction store now cancels old provider interactions. Foreign transcripts never create actionable question records.

### Durable question record

A dedicated additive table is clearer than overloading `interaction_journal`:

```text
question_transcript_binding
  thread_slug / session_id       primary key
  native_transcript_id
  transcript_epoch
  canonical_path
  file_device / file_inode / file_birthtime
  observed_size
  prefix_anchor_digest / tail_anchor_digest
  projector_version
  state                          ready | activation_error | disabled
  diagnostic                    nullable, bounded
  updated_at

question_scope_state
  thread_slug / session_id       primary key
  next_journal_sequence
  list_revision                  increments on any list-visible mutation
  pending_count / actionable_count
  updated_at

question_feature_policy
  project_id                      primary key
  policy_revision
  dismissal_mode                 local-only | notify-worker
  approval_dismissal_mode / archive_mode / rollout defaults
  updated_at

question_journal
  id                    opaque primary key
  journal_sequence      immutable monotonic key within thread/session
  thread_slug
  session_id
  native_transcript_id
  transcript_epoch
  projector_version
  source_message_id
  block_ordinal
  source_digest         digest of canonical info + LF/NFC body + ordinal
  kind                  question | approval | multi
  danger                boolean
  raw_body              bounded server-sourced snapshot
  lifecycle             open | delivering | answered | declined | dismissed |
                        answered_unconfirmed | declined_unconfirmed | dismissed_unconfirmed |
                        cancelled | source_invalid
  record_revision
  current_action_id     nullable, references latest accepted action
  answer_text           nullable, bounded; user answer only
  addressed_at          nullable
  cancellation_reason   nullable (session-replaced | session-deleted | source-invalid)
  created_at / updated_at
  UNIQUE(thread_slug, session_id, native_transcript_id, transcript_epoch,
         projector_version, source_message_id, block_ordinal)

question_activation
  thread_slug / session_id / native_transcript_id / transcript_epoch
                                  composite primary key
  projector_version
  policy                         from-start | new-only | import-trailing | selected-backfill
  activation_cursor              byte offset before which normal discovery is suppressed
  backfill_through_cursor         nullable inclusive migration progress
  activated_at / updated_at

question_action
  action_id                      opaque primary key
  question_id
  action_kind                    answer | decline | dismiss
  normalized_value               nullable bounded answer/reason
  action_digest
  state                          accepted | delivering | terminal | superseded_unconfirmed
  accepted_revision
  created_at / updated_at

question_danger_confirmation
  nonce_hash                     primary key; raw nonce is returned once and never stored
  thread_slug / session_id / question_id
  expected_record_revision
  confirmation_purpose           answer | decline | dismiss |
                                 acknowledge-unconfirmed | reopen-with-new-answer
  action_digest
  dismissal_policy_revision / dismissal_mode   nullable unless dismiss
  issued_at / expires_at
  consumed_at / consumed_action_id   nullable until one-time use

question_delivery_attempt
  delivery_id                    opaque primary key
  question_id
  action_id                      references immutable action; may have proven-prewrite retries
  action_kind                    answer | decline | dismiss
  expected_session_id
  expected_runtime_generation
  expected_native_transcript_id
  expected_transcript_epoch
  expected_pane_id / expected_pane_pid / expected_session_created
  pre_boundary_cursor
  state                          prepared | enqueueing | queued | injecting | submitted |
                                 ambiguous | recovery_required | failed_prewrite |
                                 witnessed | completed_unconfirmed | cancelled
  native_payload_digest          exact backend user payload after known resume wrapper
  witness_cursor / witness_digest
  observation_deadline
  stage_boundary_at / submit_boundary_at   nullable per-primitive replay barriers
  completion_reason              nullable enum described below
  prepared_at / native_boundary_at / witnessed_at / completed_at / updated_at
  diagnostic                    nullable, bounded

question_delivery_outbox
  delivery_id                    primary key, references attempt
  thread_slug / session_id / runtime_generation
  transport_sequence             monotonic within thread/session lane
  native_transcript_id / transcript_epoch
  exact pane identity            nullable only while a dead-session resume is uncreated
  state                          ready | claimed | native_contacted | complete | cancelled
  lease owner / lease expiry
  bounded native payload

native_transport_item
  thread_slug / session_id / transport_sequence    composite primary key
  kind                          question | follow-up | scheduler-wake |
                                permission-handoff | resume
  owner_reference               delivery id or operation id
  expected runtime/transcript/pane tuple
  state                         ready | claimed | native-contacting |
                                awaiting-witness | ambiguous | recovery-required |
                                terminal | cancelled-precontact
  stage_contacted / submit_contacted
  created_at / updated_at

native_transport_lease
  thread_slug                    primary key
  session_id / runtime_generation
  next_transport_sequence
  owner_token / fencing_token / lease_expires_at
  blocked_sequence / blocked_reason   nullable recovery barrier
```

The durable action acceptance transaction gives one action ID exactly one immutable meaning. For a delivery-bearing action it performs one `open -> delivering` question CAS and inserts the action, first `prepared` attempt, and `ready` outbox row together. There is no committed attempt without an outbox and no outbox without its attempt. A local dismiss instead atomically inserts a terminal action and performs `open -> dismissed` with no attempt/outbox. This is the exactly-once guarantee: one durable action wins a question revision. It is **not** a claim of exactly-once provider delivery.

Every native operation—not only question actions—atomically reserves the next monotonic `transport_sequence` in the thread/session lane and creates a bounded coordinator item. The coordinator may claim only the **smallest ready sequence**. It never skips a lower `ready`, `claimed`, `native-contacting`, `ambiguous`, or `recovery-required` item to run a later follow-up, scheduler wake, permission handoff, or resume. It may advance past a lower terminal/cancelled item and past `awaiting-witness` only after that item's native call returned, its contact flags/result were durably recorded, and it no longer owns the transport lease; witness waiting remains question-pending but does not monopolize an otherwise healthy lane.

The transport lease is acquired/renewed/released through SQLite CAS and paired with an in-process FIFO keyed by thread. The durable fencing token is the cross-process authority; the FIFO mirrors sequence order locally. The interlock covers outbox claim, registry/native-transcript/pane revalidation, durable native-boundary CAS, the native contact sequence, and recording its immediate result; it is released while waiting for an ordinary transcript witness only after the contact call has returned and the lane no longer has a live owner.

Lease loss or process death while an item is `native-contacting` is not a normal expiry/takeover. Atomically mark that sequence ambiguous/recovery-required, set `blocked_sequence`, and prohibit every later sequence. Exact reconciliation may clear the lane only after it (a) finds the expected witness, or (b) proves the old fencing owner cannot continue and the exact pane is dead/absent or durably fenced from further input, confirms no matching Codex queue/composer item remains, scans the fixed transcript incarnation through the reconciliation cursor, and terminalizes the attempt through the explicit unconfirmed/prewrite rules. If continued pane contact cannot be disproved, the lane remains blocked for operator recovery. A new lease holder may reconcile the blocked item but may not contact any pane for a later item merely because wall-clock lease time elapsed.

The raw body snapshot is needed for old-question delivery context, fallback rendering when the originating message has fallen outside the transcript presentation window, and source-drift detection. The shared strict schemas are normative:

- Opaque `questionId`, `actionId`, `deliveryId`, `nativeTranscriptId`, and `transcriptEpoch` are 1–256 characters, at most 512 UTF-8 bytes, match `[A-Za-z0-9][A-Za-z0-9._:@/-]*`, and reject `__proto__`, `constructor`, and `prototype`. Server-created IDs are random UUIDs. `sourceMessageId` is server-only, at most 768 bytes, and validated against the backend-prefixed form above.
- `QuestionListCursor` is a separate opaque URL-safe base64url token, 1–512 bytes, authenticated with a persisted per-project random pagination secret. It is never parsed as a transcript/source/witness byte cursor and no raw prompt, question ID list, or answer text appears in it.
- A raw danger confirmation nonce is exactly 43 base64url characters encoding 32 random bytes; mutation inputs reject any other shape before hashing. Policy/list revisions and transport sequences use the same nonnegative-safe-integer bound as record revisions.
- Revisions, generations, line ordinals, block ordinals, and byte cursors are nonnegative safe integers. Cursors must be no greater than the fixed snapshot size and must land on a recorded JSONL line boundary. Exact pane identity is `%[0-9]+` plus positive safe-integer `panePid` and `sessionCreated`.
- Normalize accepted source/answer text from CRLF/CR to LF and Unicode NFC before digesting. Preserve leading/trailing printable text; do not trim it into a different answer. Reject `Cf`, `Cs`, `Zl`, `Zp`, C0/C1 controls other than tab/LF, lone surrogates, and any case-sensitive reserved marker prefix `[fray-question-` in source bodies, answers, or client-provided notes. The server alone creates delivery markers.
- `QUESTION_SOURCE_MAX_BYTES = 64 * 1024`, `QUESTION_ANSWER_MAX_BYTES = 24 * 1024`, `QUESTION_INFO_MAX_BYTES = 512`, `QUESTION_DIAGNOSTIC_MAX_BYTES = 2 * 1024`, `QUESTION_NATIVE_PAYLOAD_MAX_BYTES = 96 * 1024`, and at most 256 blocks per finalized source. One session/epoch may persist at most 4,096 question sources and 8 MiB of source bodies. A discovery snapshot may span at most 32 MiB per session and 128 MiB across startup; exceeding a limit enters `activation_error`, never partial discovery.
- `pendingQuestions` page limit is 1–100 (default 50), and its complete serialized payload is capped at 512 KiB. If the next record would exceed the aggregate cap, return the current page and a cursor without splitting/truncating a record. Delivery composition must fit its bound after the server wrapper is applied.

Enforce every leaf and aggregate bound in shared wire schemas and again before storage/composition. An oversized/invalid block is persisted as `source_invalid`, never actionable, with a bounded diagnostic; it is not silently truncated into a different question.

Stored markdown remains inert text. Every browser surface, including out-of-window snapshots, renders it through the question-safe branch of `ui/packages/web/src/lib/markdown.ts`: `marked`, the existing tag/attribute allowlist, and an `href` allowlist that retains only absolute `http:` or `https:` URLs. Strip relative, protocol-relative, fragment, `javascript:`, `data:`, `file:`, and every other scheme; force retained links to `target="_blank" rel="noopener noreferrer"`. The current sanitizer only strips `javascript:` and therefore must be hardened before snapshot rendering is enabled. No endpoint returns pre-rendered HTML, and no component may inject stored body text without that sanitizer. The server composes delivery from stored normalized markdown; the client submits only the bounded answer value.

`answered`, `declined`, `dismissed`, and their explicit unconfirmed variants are addressed/terminal. `cancelled` is not a user dismissal; it records that the owning session/source is no longer current. Terminal records remain queryable for read-only rendering and audit, but the normal list endpoint may return only records needed by the transcript window plus every pending state defined below.

### Discovery and reconciliation

Question discovery belongs on the server at a final-message boundary, not in React. Startup needs a publication barrier. Today `ui/packages/server/src/index.ts` creates the application and `app-socket.ts` server, then starts the board producer, then the tailer producer, then permission control. Board start can therefore assemble before tailer priming; the new design must not bolt question bootstrap onto a later tail tick.

Add a `question bootstrap` startup phase immediately after `createContext` and before application/application-socket construction. No board snapshot, socket keyframe, RPC read, or producer invalidation may be published until the phase has durably classified every registered session as `ready` or `activation_error`:

1. Snapshot the registry row and current transcript binding expectation `{ sessionId, runtimeGeneration, nativeTranscriptId, transcriptEpoch }`.
2. Open that exact file without following a replacement, `fstat`, and read one fixed, bounded byte range from the minimum activation/attempt cursor through the snapshotted EOF. `fstat` again; changed device/inode/birthtime, shrink, anchor mismatch, or mutation inside the fixed range invalidates the read. Appends after the snapshotted EOF belong to the next incremental pass.
3. In one SQLite transaction, re-read/CAS the same registry and transcript binding, create/verify activation, project/discover the fixed bytes, reconcile attempts/outbox/queue witnesses, write counts, and mark the session `ready`. If the CAS loses, discard all derived data and retry at most three times with a fresh bounded snapshot.
4. An unreadable/oversized/unstable source, unknown incarnation, schema mismatch, or exhausted retry stores a durable per-session `activation_error` with a bounded diagnostic and recovery choices (`rescan`, select activation policy for the new epoch, or explicitly disable question discovery for this session). It does not publish zero counts. `ThreadView` exposes `questionReconciliation: ready | activation-error | disabled`; activation error is a separate hard Queue reason with a repair action, while last durable question records remain readable but non-mutable. `disabled` is an explicit maintainer acknowledgement, suppresses that repair reason, keeps all question mutations disabled, and never masquerades as `ready` or legacy zero counts.
5. A database/schema failure which cannot durably record either classification fails server startup and uses the existing startup rollback path. A per-session transcript error does not take down unrelated sessions.

After this atomic startup barrier, incremental discovery follows the same bounded-snapshot/CAS rule:

1. Resolve or create `question_activation` for the exact `(threadSlug, sessionId, nativeTranscriptId, transcriptEpoch)`. The activation cursor is a raw pre-cap byte offset, not a message index or timestamp.
2. Resolve the exact native transcript ID/epoch, project uncapped finalized assistant sources after the allowed cursor, and enumerate their server-projected blocks. The projector and discovery transaction persist their cursor/version together.
3. Upsert each source composite into `question_journal`; identical replay is a no-op, while a digest mismatch for an existing source key fails closed as `source_invalid` and emits a diagnostic. Never overwrite an addressed row from transcript replay.
4. Reconcile unfinished delivery attempts from the durable outbox, Codex queue, and exact transcript witness before exposing counts.
5. Publish a scoped question invalidation and refresh the board whenever pending/actionable counts or a visible record revision changes.
6. Later assistant turns, event lines, tool results, and unrelated user messages never delete or address prior rows.

Do not materialize a half-streamed fence. Claude may append multiple raw records with one message ID, and Codex may append commentary/tools/final text into one rendered assistant message; discovery should wait until the backend's existing turn/final boundary makes the source stable.

Activation/backfill policy is durable schema, not a one-time installer assumption:

- New sessions use `from-start` with cursor `0` before their first record.
- Recommended existing-session rollout is `import-trailing`, derived **only** from the same fixed incarnation snapshot used by bootstrap. Run the canonical projector through the snapshotted EOF and reproduce the legacy condition mechanically from those bytes: the backend is at a final/idle boundary, the latest substantive rendered assistant source contains finalized question blocks, and no later genuine user source in that snapshot supersedes it. Do not read `tailer.get().pendingQuestion`, in-memory fold state, a second file read, or a browser transcript. In the single bootstrap CAS transaction, persist the EOF activation cursor, imported source rows (whose cursors may precede the watermark), projector/incarnation anchors, and final `ready`/`activation_error` classification together. If any part fails or the snapshot expectation changes, none of cursor/import/classification commits. No qualifying trailing source is atomically equivalent to `new-only`.
- `new-only` stores current EOF and imports nothing. `selected-backfill` is an explicit maintainer tool which records the requested lower cursor and monotonically advances `backfill_through_cursor`; it never changes policy implicitly on restart.
- Restart reads this row before discovery. Absence is a fail-closed migration error for an existing session once the feature flag is enabled, not permission to scan from byte zero.

The maintainer must choose rollout/backfill policy at the checkpoint. Blind historical backfill is not allowed because it can resurrect legacy questions already answered under positional semantics.

### RPC contract

Add scoped APIs parallel in shape, not in resource identity, to typed interactions:

```text
pendingQuestions({ slug, sessionId, cursor?, limit })
questionGet({ slug, sessionId, questionId })
questionsForSources({
  slug, sessionId,
  sourceMessageIds[]
}) -> compact source/block lifecycle map
answerQuestion({
  slug, sessionId, questionId,
  expectedRecordRevision,
  actionId,
  answer,
  dangerConfirmationNonce?
})
declineQuestion({
  slug, sessionId, questionId,
  expectedRecordRevision,
  actionId,
  reason?,
  dangerConfirmationNonce?
})
dismissQuestion({
  slug, sessionId, questionId,
  expectedRecordRevision,
  actionId,
  dangerConfirmationNonce?
})
confirmDangerQuestionAction({
  slug, sessionId, questionId,
  expectedRecordRevision,
  purpose, actionDigest
}) -> { confirmationNonce, expiresAt }
recoverQuestionDelivery({
  slug, sessionId, questionId,
  expectedRecordRevision, deliveryId,
  decision: reconcile | retry-proven-prewrite | acknowledge-may-have-delivered |
            reopen-with-new-answer,
  newActionId?, newAnswer?, dangerConfirmationNonce?
})
```

`pendingQuestions` returns `{ items, nextCursor, pendingCount, actionableCount, listRevision }`. It is not tied to transcript pagination: all nonterminal questions are reachable through cursor pagination, and each item carries its bounded snapshot. Default/max page sizes are 50/100; counts cover the complete scoped set, not only the page. `questionGet` remains the post-ambiguity source of truth.

The first page snapshots the exact project/thread/session/filter scope, current `listRevision`, maximum visible `journal_sequence`, and starts stable keyset order `(journal_sequence ASC, id ASC)`. `nextCursor` authenticates that scope, revision, high-water sequence, last returned key, and a 10-minute expiry. A subsequent page requires the same current session and list revision, returns only keys greater than the last key and no greater than the captured high-water mark, and never repeats/reorders a row. Any create, lifecycle/attempt/readability change, session replacement, activation classification, or policy change increments `listRevision`, publishes the existing payload-free scoped invalidation, and makes outstanding cursors return `stale-cursor`; the client discards accumulated pages and restarts at page one. Scope/filter mismatch, tampering, expiry, or use after server-secret rotation returns `invalid-cursor` without revealing another scope. This explicit invalidation rule avoids pretending mutable pending filters are MVCC snapshots.

`questionsForSources` is the single bounded terminal-state read for the rendered transcript. The client sends the distinct server-issued source IDs from one capped transcript payload in one RPC—never one query per block and never a content/index guess. Input is limited to 300 IDs and 256 KiB. The store loads them into one bounded values/temporary-key join scoped by exact project/thread/session and returns all matching block ordinals, question IDs, lifecycle, record revision, and compact attempt effect, including terminal answered/declined/dismissed/unconfirmed/cancelled/source-invalid rows. Output is grouped once per source, capped at 4,096 block states and 1 MiB; the persisted per-session source cap guarantees a valid journal fits. A corrupt journal that violates the bound produces `activation_error`, not silently missing labels.

The web question cache keys this result by `{sessionId, transcript source signature, listRevision}`. A scoped question invalidation discards both pending pages and this join, then performs one replacement join for the currently rendered sources. Thus Answered/Declined/Dismissed labels survive reload and socket transcript replacement without N RPCs. Out-of-cap actionable snapshot forms continue to obtain state from `pendingQuestions/questionGet`; the two reads share journal revisions and never manufacture separate lifecycle truth.

The recommended UI submits one question per action. This keeps independent lifecycle semantics obvious and avoids a batch in which one stale question makes unrelated answers ambiguous. If the maintainer chooses message-level “Send all drafted answers,” add a separate **atomic claim** batch RPC: validate every named row/revision and claim all or none in one SQLite transaction. Native messages are then delivered in deterministic source order under the thread transport lock. A later transport failure may leave a prefix witnessed and the suffix recovery-required; the batch response must report each durable attempt and must never pretend native delivery itself is atomic. This per-question-versus-batch choice is explicit at the checkpoint.

The server action kinds are exactly `answer`, `decline`, and `dismiss`, and the server enforces the matrix rather than trusting which button React rendered. `danger` is orthogonal to the base `question | multi | approval` kind, matching the current parser; all three danger-tagged combinations are valid source schema and have explicit rows below. Dismissal mode is server policy, not client input: persist policy 5 as `local-only | notify-worker` in the question feature configuration, and have `dismissQuestion` derive it transactionally. A client cannot request or downgrade the mode. If policy changes while a dismiss UI is open, the expected policy revision/CAS loses and no action is accepted.

| Question kind | Allowed actions under recommendation |
|---|---|
| `question` | answer; local dismiss |
| `multi` | answer; local dismiss |
| `approval` | answer/approve; delivered decline; no local dismiss |
| `question danger` | confirmed answer or confirmed delivered decline; no local dismiss |
| `multi danger` | confirmed answer or confirmed delivered decline; no local dismiss |
| `approval danger` | confirmed answer/approve or confirmed delivered decline; no local dismiss |

`answer` carries the normalized bounded answer. `decline` is a negative response delivered to the worker. `dismiss` is either an immediate local lifecycle action or, when the persisted policy selects notify-worker, a normal witnessed delivery whose terminal lifecycle is `dismissed`. Policy 9 is the only switch allowed to expand/narrow local-dismiss eligibility in these rows; an unadvertised action returns `invalid-action` without a journal/outbox write.

Every mutation re-derives the project locally and, in the same acceptance transaction, requires a current registered row with the supplied Fray `sessionId`, `state === "open"`, matching question revision, and `questionReconciliation === "ready"`. Archived-state rejection is a CAS condition, not a UI convention: an Archive race returns `archived` and creates no action/outbox. Foreign/replaced/error sessions likewise create nothing. `actionId` makes an identical retry idempotent and conflicts if reused for a different question/action/body. The response always returns the current record/attempt effect; an HTTP success is not itself proof that the worker saw the answer.

Every mutation which accepts or replaces a terminal action on a `danger` question requires a fresh durable confirmation: answer, decline, any policy-permitted dismiss, and `reopen-with-new-answer`. `confirmDangerQuestionAction` first CAS-validates current session ownership, open thread state, question revision, allowed action/mode, and exact normalized action digest; it generates 32 random bytes, returns the base64url raw nonce once, and stores only its SHA-256 hash with the complete binding and a database-clock `expires_at = issued_at + 60 seconds`. Issuance is bounded to five unexpired nonces per question; issuing a sixth revokes the oldest.

The applicable mutation hashes the supplied nonce and, in the same SQLite transaction as action acceptance/replacement, requires an unconsumed, unexpired exact binding and writes `consumed_at`/`consumed_action_id`. Replays, expired/revoked records, another action digest/kind, another revision/session, or a policy-5 dismissal-mode change fail without journal/outbox mutation. Raw nonces are never logged, persisted, placed in invalidations, or returned again. Retry of an already accepted action is idempotent from its action ID and does not consume a second nonce; a changed danger answer is a new action and needs a new nonce. Reconcile/read-only recovery does not need one, while acknowledge-unconfirmed terminalization of a danger action requires a nonce bound to that recovery decision. A boolean flag or generic close icon is insufficient.

### Answer delivery and crash windows

An answer is not addressed because a browser clicked or because the server merely claimed it. Normal `answered`/`declined`/notify-worker `dismissed` requires an exact source witness. The normative state machines are:

```text
question: open --answer CAS-------------------------------> delivering --witness--> answered
              \--decline CAS------------------------------> delivering --witness--> declined
              \--local dismiss CAS-------------------------------------------> dismissed
              \--notify dismiss CAS-----------------------> delivering --witness--> dismissed
          delivering --operator acknowledges ambiguity--> *_unconfirmed
          delivering --reopen-with-new-answer-----------> delivering (new action/attempt)
          delivering --replacement/deletion-------------> cancelled

attempt: prepared -> enqueueing -> queued -> submitted -> witnessed
                  \-> injecting -> submitted -> witnessed
          prepared|enqueueing --proof of no native contact--> failed_prewrite
          enqueueing|queued|injecting|submitted -> ambiguous -> recovery_required
          recovery_required -> completed_unconfirmed
          pre-contact -> cancelled on session replacement/deletion
          post-contact replacement/deletion -> completed_unconfirmed (question cancelled)
          incarnation mismatch -> failed_prewrite before contact, otherwise recovery_required
```

`completion_reason` is required on every terminal attempt: `witnessed`, `operator-acknowledged-unconfirmed`, `operator-reopened-after-ambiguity`, `prewrite-failed`, `session-replaced-precontact`, `session-deleted-precontact`, `session-replaced-after-contact`, `session-deleted-after-contact`, `transcript-incarnation-changed-precontact`, `transcript-incarnation-changed-after-contact`, or `source-invalid`. `completed_unconfirmed` is an explicit terminal attempt state; the question becomes `answered_unconfirmed`, `declined_unconfirmed`, or `dismissed_unconfirmed` when the operator acknowledges possible delivery. Replacement/deletion always cancels the old question; if contact already occurred, its attempt remains explicitly unconfirmed for audit rather than pretending no delivery occurred.

`reopen-with-new-answer` is available from `failed_prewrite` or `recovery_required`. In one transaction it validates the new bounded answer/new action ID (and danger nonce when applicable), replaces `question.current_action_id`, increments the revision, and inserts the new `prepared` attempt/outbox. From `failed_prewrite`, the old attempt/action remain terminal proven-not-contacted. From `recovery_required`, it marks the old attempt `completed_unconfirmed` and old action `superseded_unconfirmed`, and the replacement question carries a visible “previous answer may also have arrived” warning. The question remains `delivering`. Omitting any new-action field fails the whole transaction; immutable old audit rows are preserved.

`retry-proven-prewrite` is available only when the current attempt is terminal `failed_prewrite` with `completion_reason=prewrite-failed` and every contact timestamp/flag null. It retains the same immutable action, allocates a new delivery ID, and inserts the replacement `prepared` attempt/outbox atomically; the failed attempt remains audit history. It cannot change action kind or answer bytes.

`actionId` identifies the immutable user decision (`questionId`, action kind, normalized answer/reason digest). `deliveryId` identifies one native delivery attempt. The question-revision transaction accepts one action exactly once. Each delivery ID starts **at most one native contact sequence**: Claude performs one exact-pane send; Codex performs at most one literal stage and at most one submit key, each durably flagged before execution so neither primitive repeats across ticks/restart. Enqueue without terminal contact is still a durable outbox transition, not permission to create a second sequence. Repeating an action RPC returns the existing action/attempt. Only `retry-proven-prewrite` may create a new delivery ID for the same action, and only from `failed_prewrite` with no contact flags or `native_boundary_at`. A changed answer uses the explicit atomic `reopen-with-new-answer` transition and a new action/delivery ID. No ambiguity path automatically replays native contact. This design does not claim exactly-once native or provider delivery.

Recommended answer sequence:

1. In one SQLite transaction, compare-and-swap `open -> delivering`, store the action kind/bounded answer digest, and create the `prepared` attempt plus `ready` outbox. Snapshot the complete original expectation and pre-boundary cursor:

   ```text
   {
     sessionId, runtimeGeneration,
     nativeTranscriptId, transcriptEpoch,
     exactPaneIdentity: { paneId, panePid, sessionCreated } | null,
     deliveryId
   }
   ```

   `exactPaneIdentity` may be null only when the expected runtime is already dead and `resume.ts` must create its successor. This expectation object—not a slug lookup—is passed unchanged into the transport API. A successful dead resume returns/records a successor generation and exact new pane on the same attempt while retaining the original expectation for audit.
2. Compose a server-owned follow-up which identifies and quotes the earlier question. Example shape:

   ```text
   Answer to earlier question [<short question id>]:
   > <question context and options from raw_body>

   <user answer>

   [fray-question-delivery:<deliveryId>]
   ```

3. Enter the shared **per-thread native transport coordinator**: its SQLite lease serializes cross-process owners and its keyed FIFO serializes same-process question delivery, `followUp`, scheduler wakes, `resume.ts`, and permission-controller submission/reattach.
4. Inside the interlock, re-read the registry, transcript binding, attempt, outbox, and exact pane. Require every field of the original expectation. Immediately before native contact, one SQLite transaction CASes registry generation/state, transcript ID/epoch, exact pane expectation, attempt state, outbox claim, and any Codex queue bytes:
   - live Codex: atomically append a queue item containing the complete expectation plus delivery ID and move `prepared -> enqueueing`, outbox `ready -> claimed`. Across every later composer tick, `permission-controller.ts` revalidates session, current generation, native transcript/epoch, exact pane, outbox ownership, and delivery ID before capture, literal typing, or key submission. A mismatch before any staged text proves `failed_prewrite` and cancels the queue item; after literal staging or key contact it becomes `ambiguous` and the item is retained as a recovery barrier. It is never silently moved to a replacement generation/pane;
   - live Claude: move `prepared -> injecting` and stamp `native_boundary_at`, then send only to the exact pane tuple using an exact-pane tmux primitive. Never call `pasteText(slug)` or `sendKeys(slug)` for question delivery. The post-CAS/pre-send crash window is ambiguous by definition;
   - dead backend: call `resumeThread(expectation, payload)`. Under the same interlock it CASes `beginRuntimeGeneration`, creates and records the successor exact pane/outbox expectation, then stamps `injecting/native_boundary_at` immediately before spawning/resuming with the message. A competing resume or transcript rebind loses before contact. Subsequent operations address that recorded exact pane, never the reusable slug.
5. Mark `submitted`, never a terminal question lifecycle, after the native path crosses its write/submit boundary. Reconciliation alone advances to `witnessed`, stores witness cursor/digest, completes the outbox, and atomically maps action kind to `answered`, `declined`, or `dismissed`.

The exact witness is a genuine **user** source record in the attempt's expected/successor `nativeTranscriptId` and `transcriptEpoch`, owned by the same Fray `sessionId`, containing exactly one complete `[fray-question-delivery:<deliveryId>]` token and whose LF/NFC-normalized raw user payload hashes to the stored `native_payload_digest`. The transport stores that digest after applying any known backend resume wrapper (for example Codex scratchpad orientation), before contact. The witness cursor must be a valid line boundary strictly after `pre_boundary_cursor` and at/after the native-boundary record window; persist both cursor and digest. Substring answer matching, timestamps alone, another epoch, an assistant quote, or a matching answer without the token is insufficient. Claude queue-operation `enqueue` is only `queued`; its human `queued_command` attachment or genuine human user record is the witness. Codex's durable input queue is evidence for `queued/submitted` and idempotency, but only the subsequent `event_msg/user_message` with token+digest is `witnessed`.

Restart reconciliation runs inside the startup barrier before counts are published: replay only the bounded fixed snapshot from each attempt's pre-boundary cursor; accept exact witnesses; preserve expectation-matching Codex queue/outbox states as `queued/submitted`; classify `prepared` or `enqueueing` as `failed_prewrite` only with durable proof that no native contact flag/boundary/staged composer text exists; and move contacted `enqueueing`, `injecting`, or `submitted` without witness to `ambiguous`. `observation_deadline` is set once at contact (`native_boundary_at + 30 seconds`, matching current Codex confirmation) and never extended by restart. At the deadline, unresolved ambiguity becomes `recovery_required`. Claude is never auto-reinjected. Recovery offers the exact transitions above: re-scan, retry only proven prewrite failure, acknowledge unconfirmed terminal outcome, or reopen with a new action after an explicit duplicate-delivery warning.

Under the recommended policy, non-danger `question`/`multi` dismissal is local and atomic: `open -> dismissed`, no outbox. A notify-worker dismissal instead uses `action_kind=dismiss`, remains `delivering`, and reaches `dismissed` only on a witness or `dismissed_unconfirmed` through recovery. Non-danger `approval` and every danger-tagged question use delivered `decline`, not local dismissal, under policy 9.

### Queue truth

Replace the boolean with two mandatory exact counts on `ThreadView`:

- `pendingQuestionCount`: every question in `open` or `delivering`, including attempts in `prepared`, `enqueueing`, `queued`, `injecting`, `submitted`, `ambiguous`, `recovery_required`, or `failed_prewrite`.
- `actionableQuestionCount`: resource states requiring a human decision: `open`, `recovery_required`, and `failed_prewrite` (recovery controls only for the latter two). It excludes ordinary prepared/delivering/queued/ambiguous states. Thread lifecycle is an outer gate: under the recommended Archive policy the count remains truthful/visible, but archived rows suppress Queue and disable controls until Reopen.

The state/readability/Queue contract is normative:

| Question/attempt state | In pending list/count | In actionable count | Controls | Question hard-Queue reason |
|---|---:|---:|---|---:|
| `open` | yes | yes | Allowed Answer/Decline/Dismiss actions | yes |
| `delivering:prepared/enqueueing/injecting` | yes | no | disabled, “Sending” | no |
| `delivering:queued/submitted` | yes | no | disabled, “Queued/awaiting transcript” | no |
| `ambiguous` inside observation window | yes | no | disabled, “Reconciling” | no |
| `recovery_required` | yes | yes | recovery actions only | yes |
| `failed_prewrite` | yes | yes | Retry same action or reopen | yes |
| `witnessed` | no | no | atomically projects Answered/Declined/Dismissed | no |
| `completed_unconfirmed` | no | no | read-only unconfirmed audit state | no |
| `cancelled` | no | no | read-only cancellation | no |
| `answered/declined/dismissed` | no | no | read-only historical state | no |
| `*_unconfirmed` | no | no | read-only warning state | no |
| `source_invalid` | no | no | read-only diagnostic | no |

`witnessed` is committed in the same transaction as the terminal question lifecycle and therefore is not normally observable as a separate question row, but its mapping is specified for replay/audit. `completed_unconfirmed` maps atomically either to a `*_unconfirmed` question or, for `operator-reopened-after-ambiguity`, to the replacement action's `delivering` question with the prior warning attached.

- `pendingQuestion` remains only as rolling compatibility and equals `pendingQuestionCount > 0`; it is **not** Queue authority. This means an answer safely queued for provider delivery remains readable without falsely claiming the user still owes a new decision.
- Pass `actionableQuestionCount > 0` into `deriveNeedsYou` before the at-rest check, like actionable typed interactions. An older **open** question keeps the thread in Queue even while a later assistant turn or sub-agent event makes the worker active.
- Preserve the currently settled Snooze policy: a future explicit snooze suppresses every Queue reason until its deadline. Open records remain open and requeue when the snooze expires.
- Queue priority and sidebar `needs-input` classification use the actionable count, while badges/navigators show both when they differ (for example “1 sending · 2 open”).
- Answering/dismissing one question recomputes both counts. When actionable reaches zero, ordinary runtime/fence/crash/typed-interaction rules still decide Queue membership. “All questions addressed” removes only the question reason; it does not suppress unrelated bare-rest/completion reasons.
- Cold startup must finish activation/discovery/attempt reconciliation before publication. A per-session `activation-error` is a separate hard Queue/repair reason; it preserves last durable counts and never fabricates a recovery-required question or transient zero.
- `ThreadView.nativeTransportRecoveryRequired` exposes a blocked transport sequence even when its owner was an ordinary follow-up/wake rather than a question. It is a separate hard Queue reason. While set, every composer, answer, permission change, wake, and resume stays disabled behind the smallest blocked sequence; clearing a question count cannot bypass it.

This resolves the old-question contradiction: Queue does **not** rely on `TodosView`'s latest-user window or the 300-message transcript cap. The paginated `pendingQuestions` snapshot is authoritative and includes the bounded source body. Fork 3B's navigator pages through every actionable record and can answer from the snapshot; loading transcript history is optional context. If fork 3A is selected, the acceptance criterion must be explicitly relaxed because “in place only” cannot guarantee an out-of-cap question is reachable. The recommendation remains 3B; silently assuming every open source is still in the transcript payload is forbidden.

### Web behavior

Replace the one-message `useLiveAnswering` contract with a question collection keyed by `questionId`:

- drafts are keyed by opaque question ID, not block position alone;
- one shared `QuestionController(questionId)` owns draft, revision, mutation, confirmation, delivery/recovery state, and focus. It may be mounted in exactly one authoritative form at a time;
- every rendered block looks up its server record by `(sourceMessageId, blockOrdinal)`. If its source is already in the DOM, that anchored block hosts the authoritative controller/form;
- if no anchor exists because of `TodosView` windowing or the 300-message cap, the paginated question snapshot card hosts that **same** controller and sanitized source body. The navigator itself is only count/navigation chrome and never owns a second form;
- alternatively, “Open in context” may page the source message into the DOM, transfer the controller to the new anchor, preserve its keyed draft, focus the anchor, and unmount the snapshot form. There is never a snapshot form and anchored form concurrently;
- `delivering` maps every attempt state to explicit Sending/Queued/Reconciling/Pre-write failure labels; recovery states expose only their recovery contract; answered/declined/dismissed and unconfirmed variants remain visibly read-only;
- each open block has its own Answer and Dismiss actions, so two blocks in one message are independent;
- an unrelated free-form composer send calls only `followUp` and leaves question caches untouched;
- both Queue and thread drawer consume the same question query/cache and scoped invalidation event;
- after an ambiguous mutation error, fail closed and fetch `questionGet` before enabling another decision, following `InteractionCards`' current reconciliation pattern.

If a source message is outside `TodosView`'s default window or the 300-message cap, its authoritative snapshot form is immediately answerable from Queue; transcript pagination is optional context. This is one interaction contract with two mutually exclusive hosts, not a navigator-only fallback or duplicated answer UI.

## Decision checkpoint

The four forks below are recovered from `.fray/question-stacking.md`. Each requires an explicit maintainer answer.

### Fork 1 — authority and rollout location

#### A. Server-authoritative from the first enabled release — proposed recommendation

Consequences:

- **Data/API:** dedicated durable question/attempt journals, scoped list/get/answer/dismiss/recovery RPCs, mandatory pending/actionable board counts, invalidations.
- **Identity:** requires stable server-emitted source message IDs before UI enablement.
- **Session/generation:** exact `(slug, sessionId)` ownership; atomic cancellation on conversation replacement; process generation only guards delivery.
- **Concurrency:** revision compare-and-swap and action IDs make concurrent clients safe.
- **Queue:** one source of truth; older open questions queue even during later activity.
- **UI:** reload/restart and multiple clients agree; both Queue and thread use one cache.
- **Delivery:** one server action composes trusted old-question context and invokes follow-up.

This is the smallest option that satisfies the stated outcome rather than a visual approximation.

#### B. Client-only

Consequences:

- **Data/API:** browser memory or local storage only; no authoritative mutation API.
- **Identity:** still requires inventing an ID, but current transcript messages do not expose one. Index/content-hash identities are unstable or collision-prone.
- **Session/generation:** difficult to prevent stale local state from attaching to a replaced session.
- **Concurrency:** tabs and devices can submit different answers; double submit cannot be prevented.
- **Queue:** server `pendingQuestion` stays positional/stale, so Queue and transcript disagree.
- **UI:** memory loses state on reload; local storage survives only one browser profile and needs unsafe migration logic.
- **Delivery:** a normal `followUp` gives no durable association between the answer and question.

This option cannot meet reload, restart, Queue consistency, or concurrent-client acceptance criteria. It is suitable only as a disposable prototype and should not be labeled complete.

#### C. Client first, server second

Consequences:

- Ships B's semantic split temporarily, then requires migration from local IDs/state to server IDs/state.
- Questions answered in phase 1 may reappear when phase 2 begins unless the migration trusts unverified browser state.
- Queue remains incorrect until phase 2.
- UI code is likely rewritten twice because the controller changes from message-position state to resource queries/revisions.

If schedule requires phasing, prefer the server-first shadow rollout described later: land identity/journal/read model first, compare it against legacy behavior, then enable actions. Do not phase by making the browser authoritative.

Maintainer decision: **A / B / C**.

### Fork 2 — what marks a question addressed

#### A. Explicit per-question answer or dismiss only — proposed recommendation

Consequences:

- **Data/API:** every terminal transition names one `questionId`; dismiss is first-class.
- **Identity/session:** all mutations are ownership-checked and auditable.
- **Concurrency:** same-question races have one winner; unrelated questions are untouched.
- **Queue/UI:** counts are predictable; a free-form steer never silently removes work.
- **Delivery:** answers quote their stored question; dismissals are local unless later specified.

This directly satisfies the stated “raised and not yet explicitly addressed” rule. The UI must make Dismiss easy enough that stale questions do not become permanent clutter.

#### B. Bare steer addresses the oldest open question

Consequences:

- `followUp` must perform an implicit question mutation in addition to delivery.
- “Oldest” needs a total order and a transaction, and two concurrent steers can race over the same row.
- Multiple questions in one message make intent unknowable; a general instruction such as “pause all work” can accidentally answer a technical choice.
- The worker receives no guaranteed quoted question context, and Queue can clear despite no actual answer.
- A later policy reversal cannot recover which heuristic clears were genuine.

If selected, the API should still record a distinct `heuristic-steer` terminal reason and quote the chosen question in the delivered steer. It must never clear more than one. This is not recommended.

Maintainer decision: **A / B**. Dismissal delivery and dismissal eligibility for approval and danger-tagged questions are separately selected in policies 5 and 9 below.

### Fork 3 — stacking UX and navigation

#### A. Interactive in place only

Consequences:

- Minimal new chrome; every question remains where it was asked.
- Buried questions are hard to discover in long threads.
- `TodosView` currently windows from the latest user message, so an older open question can be hidden until “Load earlier messages” is used.
- Transcript caps require a fallback for very old still-open questions.

This meets lifecycle correctness but has weak discoverability. It also requires explicitly relaxing the acceptance criterion for an actionable source older than the 300-message payload cap; there is no in-place DOM anchor to operate. It is therefore not compatible with the unrelaxed “answer any older question from Queue” requirement.

#### B. Interactive in place plus pinned question navigator — proposed recommendation

Consequences:

- The pinned element is navigation/status, not a second answer form. The shared controller is hosted either by the in-DOM source anchor or, when no anchor exists, by one authoritative snapshot form.
- Near the composer and on Queue cards, show actionable and pending counts and allow jump/cycle to open/recovery question anchors.
- If an anchor is outside the current Queue window/payload, render the stored bounded snapshot as the authoritative form and offer “Open in context,” which pages the source into the DOM and transfers that same controller.
- After an answer/dismiss, focus advances to the next open question and the count updates from server truth.
- Adds anchor/focus/accessibility work and narrow-width testing, but prevents an open question from being technically live yet practically lost.

Maintainer decision: **A / B**.

### Fork 4 — first-cut scope

#### A. Fenced markdown questions only — proposed recommendation

Consequences:

- Uses conversation source identity and follow-up delivery described above.
- Leaves Claude `pendingAsk`, verified terminal modals, and typed provider interactions on their existing paths.
- `InteractionCards.tsx` is a reference for cache/concurrency UX, not the renderer or store for fences.
- A future aggregate “open requests” count may combine presentation, while the underlying resources remain separate.

This closes the concrete positional bug without reopening provider protocol work.

#### B. Fenced markdown plus provider-native questions

Consequences:

- Must define adapters for Claude `AskUserQuestion`, Codex structured `agent-question`, MCP forms, and terminal-only selectors, each with different trustworthy IDs and response channels.
- Native interaction session/capability epochs and provider delivery acknowledgement do not map to transcript source IDs or conversational `followUp`.
- Terminal-only `pendingAsk` currently has no safe web delivery path; answering it by TTY control injection violates the handoff boundary.
- Risks duplicate cards if a provider question also appears as transcript prose/fence.
- Requires a cross-source dedupe/correlation protocol and security review, materially expanding the feature.
- The existing `backend/claude-agent-sdk*.ts` and `packages/claude-agent-sdk-runtime/` files are the started read-only foundation for a future typed Claude path, but they do not yet authorize responses or make terminal prompts safely writable.

If B is chosen, it should be a separately planned phase after provider adapters expose structured response paths. Do not make markdown stacking wait on terminal automation, and do not auto-convert trusted native requests into markdown records.

Maintainer decision: **A / B**.

### Additional blocking product-policy decisions

These do not replace or renumber the four original forks. They close behaviors which otherwise force an implementer to invent product semantics:

5. **Dismissal delivery:** **local-only (recommended)** / notify worker with a normal delivery attempt. Notify-worker dismissal uses the complete attempt/witness state machine and may wake the thread; it cannot be a fire-and-forget side effect.
6. **Rollout/backfill:** **existing sessions import only the legacy trailing finalized question; new sessions from start (recommended)** / existing sessions new-only / selected historical backfill. Record the choice per session in `question_activation`; never infer it again on restart.
7. **Submission unit:** **one question per action (recommended)** / atomic-claim message batch. If batch is chosen, native transport is ordered but not atomically deliverable, and per-attempt recovery UI is mandatory.
8. **Archive behavior:** **retain open questions, suppress Queue and require Reopen before answer/dismiss (recommended)** / refuse Archive while actionable questions exist / atomically dismiss them on Archive. Archive must never silently change question state without the selected policy. Under the recommendation, pending counts remain visible on the archived row and Reopen restores their Queue effect.
9. **Approval and danger dismissal:** **non-danger question/multi may Dismiss; non-danger approval and every danger-tagged kind require explicit delivered Answer or Decline (recommended)** / allow local dismissal for all / forbid dismissal for all kinds. Every terminal danger action uses the server nonce confirmation flow; a generic close icon is insufficient.

Until choices 5–9 are recorded, implementation remains blocked even if forks 1–4 are chosen.

The normative technical design above is complete for the recommended selections. These nonrecommended choices materially change the contract and require a design amendment before implementation: client-only/client-first authority (fork 1B/C), bare-steer heuristic addressing (2B), fenced plus provider-native scope (4B), and any policy which makes Archive or dismissal of an approval or danger-tagged question implicitly deliver or address more than the named question. Fork 3A is implementable only with the explicit out-of-cap acceptance waiver already stated. Notify-worker dismissal, selected activation policies, atomic-claim batching, Archive refusal, and explicit local-dismiss allow/forbid variants are covered by the state/schema parameters above; they do not authorize partial/native-atomic delivery claims.

## Scenario consequences and acceptance criteria

These criteria are normative for the server-authoritative, explicit-action design. If the maintainer chooses another fork, the implementation plan must identify which criteria are intentionally waived.

### Identity and discovery

- Appending later lines to either a Claude or Codex transcript does not change existing assistant `sourceMessageId` values.
- Truncation, in-place prefix rewrite, inode rotation, or unproved transcript rebind creates a new epoch; no offset identity or witness crosses epochs. A proven append-only rename retains the epoch.
- Two byte-identical assistant messages have different source IDs.
- Claude records with a missing ID do not merge; repeated IDs merge only while contiguous, and a rendered user/event boundary creates a new source identity.
- Codex commentary fences never discover; `task_complete.last_agent_message` wins over a differing/equal `final_answer` without double rendering or double discovery.
- Multiple fenced blocks in one message create distinct question IDs in renderer order.
- An event line between an ask and later activity does not create, shadow, or address a question.
- Replaying the same transcript after server restart deduplicates discovery and preserves lifecycle/revisions.
- A half-written/unterminated fence creates no record; finalization creates it once.
- Existing-session trailing import is derived from the one fixed projector snapshot and commits its EOF activation cursor, imported rows, anchors, and ready/error classification atomically; changing the file/registry during that transaction imports nothing.

### Lifecycle semantics

- Questions Q1 and Q2 in one assistant message are both open. Answering Q1 leaves Q2 open and interactive; dismissing Q2 does not change Q1.
- Q1 in assistant turn A remains open after assistant turn B asks Q2. Both render in place.
- Later assistant prose/tool activity and sub-agent event lines leave every open question unchanged.
- A free-form user steer leaves every open question unchanged under the recommended policy.
- Answered/dismissed questions remain visibly read-only and never regain controls after reload.
- A dismiss action is per-question and does not send text to the worker unless the maintainer separately chooses notification.
- Open, queued/delivering, ambiguous, and recovery-required states have the pending/actionable counts and controls specified in the Queue table; restart never publishes a false transient zero.
- `answer`, `decline`, local `dismiss`, and notify-worker `dismiss` reach only their defined terminal lifecycle; danger actions consume a bound confirmation nonce and an Archive race accepts nothing.
- A raw danger nonce is issued once, expires/revokes durably, is consumed exactly once with its bound mutation, and cannot be replayed across revision/action/recovery/dismissal-policy changes.

### Old-question delivery

- Answering a non-trailing question delivers an unambiguous message containing its opaque reference and a server-sourced quote of the stored question body/options.
- Client-supplied text cannot alter the quote or target another question.
- A single/multi/approval block composes answers using current semantics, but the lifecycle transition is for that exact block only.
- If failure is proven before every native-contact boundary, the attempt becomes `failed_prewrite` and recovery may retry the same action with a new delivery ID. After any contact flag/CAS, lack of a witness is ambiguous and controls stay fail-closed until reconciliation/recovery.
- A delivery is answered only after the exact token plus full composed-payload digest appears as a genuine later user record in the same owned transcript. An assistant echo, text-only match, or durable queue entry is not enough.
- One action is durably accepted exactly once; each delivery ID starts at most one flagged native contact sequence, with no repeated Claude send or Codex stage/submit primitive. Proven-prewrite retry uses a new delivery ID, while ambiguous recovery never auto-replays.

### Persistence, replacement, and restart

- Browser reload preserves open/delivering/answered/declined/dismissed/unconfirmed state.
- Server restart reconstructs the same pending/actionable sets and Queue reason without re-opening addressed rows.
- Before the first board/app-socket publication, startup classifies every session ready or activation-error from one bounded incarnation-checked raw snapshot; activation errors are repairable hard Queue reasons, never zero-count success.
- Restart/resume of the same `sessionId` with a higher `runtime_generation` preserves old open questions and permits an answer through the new current runtime.
- Every enqueue/injection CASes expected session/current generation/native transcript epoch/exact pane immediately before contact, carries a unique delivery ID, and shares one durable per-thread transport interlock with follow-up, resume, scheduler, and permission control.
- Transport items execute monotonically by the smallest nonterminal ready sequence. Lease loss during native contact blocks all later traffic until exact-pane/queue/transcript reconciliation reaches a witnessed, proven-prewrite, or explicit unconfirmed terminal result.
- Replacing or deleting the registered `sessionId` atomically cancels old open/delivering questions. A stale client mutation returns a scoped stale/not-found result and contacts no worker.
- Foreign transcripts never expose answer/dismiss RPC authority.

### Queue and UI

- Any open question supplies a hard-attention Queue reason even while later assistant activity is running; an explicit future Snooze continues to park it until due.
- Answering one of several open questions does not remove the question Queue reason.
- Addressing the last question removes only that reason; other reasons such as typed interactions, native prompts, crash, done, or bare rest still apply normally.
- Queue card and thread drawer show the same count and enabled/disabled state.
- Under fork 3B, every older question hidden by Queue windowing or the 300-message cap is reachable through paginated actionable snapshots and answerable from Queue. Under 3A this criterion is explicitly waived.
- Exactly one shared controller/form owns an actionable question: anchored when its source is in the DOM, otherwise hosted by the authoritative snapshot; paging context transfers rather than duplicates it.
- Reload performs one bounded `questionsForSources` join for all rendered source IDs, so terminal labels reappear without per-block requests or positional guesses.
- Desktop and narrow layouts keep question actions, Dismiss, and the pinned navigator keyboard reachable with visible focus.
- Archive follows the selected checkpoint policy and never silently addresses questions.

### Concurrent clients

- Two clients answering the same revision produce one accepted action; the loser reconciles to the winner's current delivering/answered state and cannot send a second answer.
- Two clients may claim different questions independently; their native submissions serialize in deterministic claim order under the per-thread transport lock so text/submit boundaries cannot interleave.
- Answer racing with dismiss has one compare-and-swap winner.
- Replaying the same `actionId` and payload is idempotent; reusing it with different content conflicts.
- Replaying the same `deliveryId` never performs a second native submit. Changing an answer after proven failure/recovery uses a new action and delivery ID.
- A lost HTTP response cannot re-enable a conflicting choice until a scoped GET proves the question is still open.
- Keyset pages have stable journal order only while their authenticated scope/list revision remains current; any invalidation makes the cursor stale and forces a page-one refresh without duplicates or cross-session reads.

### Boundary with native interactions

- A fenced question creates only a question-journal row, never an `InteractionRecord`.
- A typed `agent-question`/MCP/provider approval creates only an interaction-journal row unless its adapter deliberately emits transcript prose; that prose must not be double-actionable.
- Claude `pendingAsk` and verified terminal modals retain their existing read-only/Terminal behavior in the markdown-only cut.
- No implementation sends arrow keys, Enter, escape sequences, or scraped option indices to answer provider-native prompts.

## Likely file ownership boundaries

The later implementation should be staged so one owner controls each shared seam. These are file/responsibility boundaries, not authorization to dispatch yet.

### 1. Source identity and shared parsing

Own:

- `ui/packages/shared/src/questions.ts` (new schemas/types)
- `ui/packages/shared/src/index.ts` (`TranscriptMessage.sourceMessageId`, `ThreadView` count, events/RPC types)
- `ui/packages/server/src/transcript.ts` (canonical pre-cap Claude/Codex projector and source IDs)
- `ui/packages/server/src/tailer.ts` (shared transcript-incarnation binding/rotation detector; no independent offset identity)
- `ui/packages/server/src/backend/claude.ts` and `backend/codex.ts` (final-boundary metadata only where the projector cannot consume the raw record directly)
- pure fence scanning extracted from or shared with `ui/packages/web/src/lib/questionBlocks.ts`
- transcript/parser identity tests for both backends

This must land before persistence or UI so no downstream code invents positional IDs.

### 2. Server lifecycle, storage, Queue, and delivery

Own:

- `ui/packages/server/src/question-store.ts` and optionally `question-delivery.ts` (new)
- `ui/packages/server/src/storage.ts`
- a dedicated final-message discovery/bootstrap seam (do not give this owner `tailer.ts`, which belongs to source/incarnation work above)
- `ui/packages/server/src/board.ts`
- `ui/packages/server/src/router.ts`
- `ui/packages/server/src/context.ts`
- `ui/packages/server/src/index.ts` (insert question-bootstrap phase before application/application-socket and producers)
- `ui/packages/server/src/app-socket.ts` (publication readiness gate in the narrow socket dependency)
- `ui/packages/server/src/resume.ts` (expected session/generation/delivery-ID API and shared thread transport serialization)
- `ui/packages/server/src/permission-controller.ts` (question delivery IDs, exact Codex queue witness, and serialization with permission handoff)
- `ui/packages/server/src/tmux.ts` (exact-pane Claude text/paste primitive; question delivery never targets a reusable slug)
- focused store/router/board/tailer/resume tests

This owner decides transaction and crash-window behavior. `interaction-store.ts` is reference code; modifying its schema to hold fenced questions is outside the recommended scope.

`ui/packages/server/src/backend/claude-agent-sdk.ts`, `claude-agent-sdk-protocol.ts`, their fixtures/tests, and `ui/packages/claude-agent-sdk-runtime/` remain read-only infrastructure in the markdown-only cut. They become owned only in a separately approved typed-native phase.

### 3. Web cache/controller and surfaces

Own:

- `ui/packages/web/src/lib/answering.ts` (replace positional controller)
- `ui/packages/web/src/lib/questionBlocks.ts`
- a new `ui/packages/web/src/api/question-cache.ts`
- `ui/packages/web/src/hooks.ts`
- `ui/packages/web/src/components/ChatView.tsx`
- `ui/packages/web/src/components/TodosView.tsx`
- focused controller/cache/render tests and browser E2E

Treat `InteractionCards.tsx` as read-only precedent unless a genuinely generic, security-neutral cache helper is extracted. Do not make both UI owners edit `ChatView.tsx` or `TodosView.tsx` in parallel.

### 4. Fresh review and provider-real verification

An independent reviewer should inspect source-ID stability, session replacement, delivery ambiguity, and concurrent-client behavior. Provider-real verification owns no product files.

## Incremental rollout alternative

If the maintainer wants risk reduction without a client-authoritative phase:

1. **Schema and shadow discovery:** land projector IDs, `question_activation`, question journal, attempt journal, and final-message discovery behind a server flag. Persist the maintainer-selected watermark/import policy before scanning. Keep existing UI/Queue behavior.
2. **Shadow comparison:** expose diagnostics/tests comparing legacy `pendingQuestion` to `pendingQuestionCount`/`actionableQuestionCount` without letting the new count mutate Queue. Expected differences after later turns/user steers should be explainable by the new semantics.
3. **Read-only UI:** render addressed/open status and the count, but keep action controls gated. Verify reload/restart and both backends.
4. **Enable explicit answer/dismiss:** turn on scoped mutations, per-thread native serialization, restart reconciliation, old-question quoting, and actionable-count Queue authority for opted-in projects/sessions.
5. **Compatibility removal:** after provider-real E2E, stop clearing markdown question state in `applyRecord`/`applyEvent`, project `pendingQuestion` from `pendingQuestionCount > 0` for rolling compatibility, then remove `liveMsg` and the legacy tail heuristic in a later cleanup.

This sequence delivers server authority first and avoids migrating unverifiable local addressed state.

## Required implementation verification

Unit/integration coverage:

- stable source identity for Claude and Codex, duplicate text, appended records, event interleaving, transcript cap, truncation/in-place rewrite, inode rotation, proven rename, ambiguous rebind, and native-ID/epoch change;
- Claude missing/repeated IDs and merge breaks; Codex commentary/final/task-complete replacement; pre-cap block ordinals and projector-version drift;
- multiple blocks per message, multiple messages, partial addressing, dismissals, unrelated steers, and later assistant turns;
- activation watermark/import/backfill replay, including fixed-snapshot-only legacy trailing import and atomic cursor/import/classification; bounded startup snapshot CAS, publication barrier, per-session activation-error recovery, SQLite restart, action/delivery-ID idempotency, exact witness rejection/acceptance, observation deadlines, every unconfirmed/prewrite recovery transition, session deletion/replacement, and process-generation resume;
- monotonic transport sequence/smallest-ready selection; per-thread races against ordinary follow-up, scheduler wake, permission reattach, live exact-pane Claude injection, and live/dead Codex queue/resume; lease loss during native contact, later-traffic blocking, and expectation mismatch before/staged/after submit on every multi-tick Codex step;
- board pending/actionable counts for every state, cold-start reconciliation, snooze/archive interaction, Queue priority, pagination beyond 300 messages, and rolling `pendingQuestion` compatibility;
- durable danger nonce issuance limits, database-clock expiry/revocation, one-time consumption/replay rejection across every applicable mutation, and policy-5 dismissal-mode CAS enforcement;
- strict ID/source-cursor/keyset-cursor/text/bidi/reserved-marker/aggregate bounds, cursor tamper/scope/revision/expiry/invalidation behavior, bounded `questionsForSources` terminal joins, http(s)-only snapshot link sanitization, and web cache/shared-controller host transfer/focus behavior.

Provider-real E2E in a disposable Fray stack for both Claude Code and Codex:

1. Have the worker emit Q1, continue through later assistant activity/event lines, then emit Q2.
2. From Queue, answer only older Q1 and verify Q2 remains enabled and the hard-attention count remains one.
3. Send an unrelated free-form steer and verify Q2 remains open.
4. Reload the browser, restart the server, and verify Q2 remains open on both Queue and thread surfaces.
5. Resume/restart the same worker conversation and answer or dismiss Q2 through the new process generation.
6. Repeat with two browser clients racing on Q1; verify one delivery and immediate stale-state reconciliation.
7. Replace the session while a stale client is open; verify the old mutation contacts no new worker.
8. Capture desktop/narrow screenshots and inspect console/network logs for duplicate requests, stale enabled controls, or false success.

## Decision record to obtain before implementation

The maintainer should reply with all four original selections and all five policy selections:

```text
1. Authority: server-authoritative / client-only / client-then-server
2. Address semantics: explicit answer-or-dismiss / bare-steer-oldest
3. UX: in-place only / in-place + pinned navigator
4. First cut: fenced markdown only / fenced + provider-native
5. Dismissal delivery: local-only / notify worker
6. Rollout: import trailing / new-only / selected backfill
7. Submission: per-question / atomic-claim batch
8. Archive: retain + require Reopen / refuse while actionable / dismiss atomically
9. Approval and danger dismissal: require delivered decline / allow local dismiss / forbid dismiss
```

Proposed smallest robust selection: **server-authoritative; explicit answer-or-dismiss; in-place plus pinned navigator; fenced markdown only; local-only non-danger question/multi dismissal; import only the legacy trailing question for existing sessions; per-question submission; Archive retains and requires Reopen; non-danger approval and every danger-tagged kind require a delivered explicit decline rather than local dismissal.** This is a recommendation for maintainer confirmation, not an implementation decision.

## Readiness statement

For the proposed smallest robust selections, the technical contracts are implementation-ready: identity includes transcript incarnation; action/outbox acceptance and snapshot activation/import are atomic; danger confirmation is durable and replay-proof; transport carries exact session/generation/native-transcript/pane expectation in monotonic smallest-ready order and blocks behind contact-time lease loss; native contact is at-most-once per delivery ID; witnesses/recovery/startup publication/counts/authenticated keyset pagination/terminal-state joins/sanitization are fully specified. This is intentionally not an exactly-once provider-delivery claim.

Product implementation is still **blocked** on maintainer selections 1–9. The memo does not pass general readiness for nonrecommended selections explicitly marked “requires a design amendment” above. If the maintainer selects fork 3A, the out-of-cap Queue acceptance criterion must be explicitly waived. With the recommended selections confirmed, no known design blocker remains; implementation still requires the verification matrix rather than treating this memo as proof of behavior.
