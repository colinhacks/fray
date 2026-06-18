import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import FrayExtension, { classifySettledRunStatus, completionQueueFromRuns, extractFinalAssistantTextFromSessionJsonl, foldRunEvents, formatRunDisplayTitle, isSlugLikeLabel, nextCompletionReminderRun, parseCompletionReminderRunId, readableTitleFromSlug, resolveRunFinalOutput, SPINNER_FRAME_MS, spinnerFrameAt, stableRunTitleText, staleLedgerLiveRuns } from "../extensions/fray/index.ts";

const base = "2026-06-18T15:00:00.000Z";
const events = [
  { id: "fray-a", label: "old", intent: "investigate", status: "completed", startedAt: base, updatedAt: base, completedAt: "2026-06-18T15:01:00.000Z", reconciled: false },
  { id: "fray-b", label: "new", intent: "verify", status: "completed", startedAt: base, updatedAt: "2026-06-18T15:02:00.000Z", completedAt: "2026-06-18T15:02:00.000Z", reconciled: false },
];

const runs = foldRunEvents(events);
assert.equal(completionQueueFromRuns(runs).map((run) => run.id).join(","), "fray-a,fray-b");

const ledgerWithRunning = foldRunEvents([
  ...events,
  { id: "fray-live", label: "has handle", intent: "investigate", status: "running", startedAt: base, updatedAt: "2026-06-18T15:05:00.000Z" },
  { id: "fray-stale", label: "lost handle", intent: "investigate", status: "running", startedAt: base, updatedAt: "2026-06-18T15:06:00.000Z" },
]);
assert.deepEqual(
  staleLedgerLiveRuns(ledgerWithRunning, new Set(["fray-live"])).map((run) => run.id),
  ["fray-stale"],
  "ledger-running records without a live SDK handle are stale, not live children",
);
assert.equal(
  staleLedgerLiveRuns(ledgerWithRunning, new Set(["fray-live"]), new Set(["fray-stale"])).length,
  0,
  "pending dispatches are not marked stale before their live handle is registered",
);

const scheduled = new Set<string>();
assert.equal(nextCompletionReminderRun(runs, scheduled)?.id, "fray-a", "oldest unhandled run should be reminded first");
scheduled.add("fray-a");
assert.equal(nextCompletionReminderRun(runs, scheduled), undefined, "do not schedule duplicate reminders for the current oldest run");

const afterHandled = foldRunEvents([
  ...events,
  { id: "fray-a", updatedAt: "2026-06-18T15:03:00.000Z", reconciled: true, reconciledAt: "2026-06-18T15:03:00.000Z" },
]);
assert.equal(completionQueueFromRuns(afterHandled).map((run) => run.id).join(","), "fray-b", "handled runs leave the durable queue");
assert.equal(nextCompletionReminderRun(afterHandled, scheduled)?.id, "fray-b", "after handling, the next oldest different run can be reminded");
scheduled.add("fray-b");
assert.equal(nextCompletionReminderRun(afterHandled, scheduled), undefined, "do not create a backlog of reminders for the next run either");

const allHandled = foldRunEvents([
  ...events,
  { id: "fray-a", updatedAt: "2026-06-18T15:03:00.000Z", reconciled: true, reconciledAt: "2026-06-18T15:03:00.000Z" },
  { id: "fray-b", updatedAt: "2026-06-18T15:04:00.000Z", reconciled: true, reconciledAt: "2026-06-18T15:04:00.000Z" },
]);
assert.equal(completionQueueFromRuns(allHandled).length, 0, "all handled means empty fray_next queue");
assert.equal(nextCompletionReminderRun(allHandled, scheduled), undefined, "no reminder can target an already-handled run");

assert.equal(parseCompletionReminderRunId("Child agent complete [fray-a]."), "fray-a", "compact completion reminder parses");
assert.equal(parseCompletionReminderRunId("Child agent complete [fray-a]. Read, handle, mark handled."), "fray-a", "previous compact reminder with inline instructions still parses");
assert.equal(parseCompletionReminderRunId("[child complete] Investigate flaky test [fray-b]"), "fray-b", "alternate compact completion reminder parses");
assert.equal(parseCompletionReminderRunId("FRAY COMPLETION TASK — handle now before unrelated work. Oldest unhandled child result: fray-a [completed] Thread title. Read the child result."), "fray-a", "legacy completion reminder parses for stale suppression");
assert.equal(parseCompletionReminderRunId("unrelated follow-up"), undefined, "unrelated extension messages are not treated as completion reminders");

assert.equal(spinnerFrameAt(0), "⠋", "spinner starts on the first frame at t=0");
assert.equal(spinnerFrameAt(SPINNER_FRAME_MS - 1), "⠋", "repeated renders within one frame interval keep the same spinner frame");
assert.equal(spinnerFrameAt(SPINNER_FRAME_MS), "⠙", "spinner advances exactly one frame after one interval");
assert.equal(spinnerFrameAt(SPINNER_FRAME_MS * 10), "⠋", "spinner wraps after all frames");
assert.equal(spinnerFrameAt(1234, ["a", "b"], 1000), "b", "spinner frame helper supports injected frames and clock values");

assert.equal(isSlugLikeLabel("setup-node-version-behavior-audit"), true, "kebab-case labels are detected as slug-like");
assert.equal(isSlugLikeLabel("setup nub Node version behavior"), false, "human labels are not treated as slug-like");
assert.equal(readableTitleFromSlug("setup-node-version-behavior-audit"), "Setup node version behavior audit", "slug-like labels can be made readable");
assert.equal(stableRunTitleText("Issue · widget title jitter"), "widget title jitter", "volatile thread category prefixes are stripped from display titles");
assert.equal(stableRunTitleText("Bug: Issue · reload title prefix"), "reload title prefix", "stacked volatile prefixes are stripped from display titles");
assert.deepEqual(
  formatRunDisplayTitle(
    { id: "fray-title", thread: "setup-nub-node-version", label: "setup-node-version-behavior-audit", intent: "review" },
    { id: "setup-nub-node-version", title: "Issue · setup nub Node version behavior" },
  ),
  { title: "Setup node version behavior audit", indicator: "" },
  "slug-like child labels are rendered from the stable child label, without volatile thread-title prefixes",
);
assert.deepEqual(
  formatRunDisplayTitle(
    { id: "fray-title-2", thread: "completion-reminders", label: "fix-widget-title-formatting", intent: "implement" },
    { id: "completion-reminders", title: "Issue · duplicate completion reminders" },
  ),
  { title: "Fix widget title formatting", indicator: "#completion-reminders" },
  "distinct slug-like child labels use a stable thread-id suffix rather than a thread-title suffix that can appear or disappear",
);
assert.deepEqual(
  formatRunDisplayTitle(
    { id: "fray-title-3", thread: "widget-title-jitter", label: "widget-title-jitter", intent: "implement" },
    { id: "widget-title-jitter", title: "Issue · widget title jitter" },
  ),
  { title: "Widget title jitter", indicator: "" },
  "running thread names do not gain an Issue prefix from thread metadata",
);

function makeHarness(root: string, entries: any[] = []) {
  const handlers = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const sent: Array<{ text: string; options: any }> = [];
  let pending = false;
  let ctx: any;
  const pi: any = {
    on(name: string, handler: Function) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name)!.push(handler);
    },
    registerTool(definition: any) { tools.set(definition.name, definition); },
    registerCommand() {},
    appendEntry(customType: string, data: any) {
      entries.push({ type: "custom", customType, data });
    },
    sendUserMessage(text: string, options: any) {
      sent.push({ text, options });
      for (const handler of handlers.get("input") || []) handler({ source: "extension", text, streamingBehavior: options?.deliverAs }, ctx);
    },
  };
  FrayExtension(pi);
  ctx = {
    cwd: root,
    hasUI: false,
    mode: "print",
    sessionManager: { getEntries: () => entries },
    ui: { theme: { fg: (_name: string, value: string) => value }, setWidget() {}, setStatus() {}, notify() {} },
    hasPendingMessages: () => pending,
  };
  return {
    entries,
    sent,
    setPending(value: boolean) { pending = value; },
    async emit(name: string, event: Record<string, any> = {}) {
      const results = [];
      for (const handler of handlers.get(name) || []) results.push(await handler({ type: name, ...event }, ctx));
      return results;
    },
    async tool(name: string, params: any = {}) {
      const tool = tools.get(name);
      assert.ok(tool, `tool ${name} registered`);
      return tool.execute("test-call", params, undefined, undefined, ctx);
    },
  };
}

function appendRun(root: string, event: Record<string, any>) {
  fs.mkdirSync(path.join(root, ".fray"), { recursive: true });
  fs.appendFileSync(path.join(root, ".fray", "runs.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
}

function assertOnlyFollowUpDelivery(sent: Array<{ text: string; options: any }>, label: string) {
  assert.ok(sent.length > 0, `${label} should send at least one native completion reminder`);
  assert.deepEqual(
    sent.map((message) => message.options),
    sent.map(() => ({ deliverAs: "followUp" })),
    `${label} queues Fray completion reminders as native follow-up messages, never parent-session steering`,
  );
}

function writeSessionJsonl(root: string, relativeFile: string, messages: any[]) {
  const file = path.join(root, relativeFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entries = [
    { type: "session", version: 3, id: path.basename(relativeFile, ".jsonl"), timestamp: base, cwd: root },
    ...messages.map((message, index) => ({ type: "message", id: `m${index}`, parentId: index ? `m${index - 1}` : null, timestamp: base, message })),
  ];
  fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

const liveStateResolution = resolveRunFinalOutput(
  os.tmpdir(),
  { sessionFile: undefined },
  { agent: { state: { messages: [
    { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: {} }], stopReason: "toolUse" },
    { role: "assistant", content: [{ type: "text", text: "LIVE FINAL OUTPUT" }], stopReason: "end" },
  ] } } },
  "",
);
assert.deepEqual(liveStateResolution, { text: "LIVE FINAL OUTPUT", source: "live-state" }, "normal live session-state capture returns the latest assistant final text");

const sessionFallbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fray-session-fallback-"));
writeSessionJsonl(sessionFallbackRoot, ".pi/sessions/fray-session-fallback.jsonl", [
  { role: "user", content: [{ type: "text", text: "task" }] },
  { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: {} }], stopReason: "toolUse" },
  { role: "assistant", content: [{ type: "text", text: "SESSION FILE FINAL OUTPUT" }], stopReason: "end" },
]);
assert.equal(
  extractFinalAssistantTextFromSessionJsonl(fs.readFileSync(path.join(sessionFallbackRoot, ".pi/sessions/fray-session-fallback.jsonl"), "utf8")),
  "SESSION FILE FINAL OUTPUT",
  "session JSONL extractor reads the latest assistant text message",
);
assert.deepEqual(
  resolveRunFinalOutput(sessionFallbackRoot, { sessionFile: ".pi/sessions/fray-session-fallback.jsonl" }, undefined, ""),
  { text: "SESSION FILE FINAL OUTPUT", source: "session-file" },
  "empty live capture falls back to the child session file",
);
assert.deepEqual(
  classifySettledRunStatus("completed" as any, "", "test fixture empty"),
  { status: "incomplete", incompleteReason: "no child final output could be captured or recovered (test fixture empty)" },
  "completed-without-final-output is reclassified as incomplete",
);

const reminderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fray-reminder-native-"));
appendRun(reminderRoot, { id: "fray-native-a", thread: "backlog", label: "native follow-up", intent: "verify", status: "completed", startedAt: base, updatedAt: "2026-06-18T15:10:00.000Z", completedAt: "2026-06-18T15:10:00.000Z", reconciled: false, findingsPath: ".fray/backlog.findings/fray-native-a.md", sessionFile: ".pi/sessions/fray-native-a.jsonl" });
appendRun(reminderRoot, { id: "fray-native-b", thread: "backlog", label: "newer follow-up", intent: "verify", status: "completed", startedAt: base, updatedAt: "2026-06-18T15:11:00.000Z", completedAt: "2026-06-18T15:11:00.000Z", reconciled: false, finalOutput: "SHOULD_NOT_APPEAR_IN_FIRST_REMINDER" });
const h1 = makeHarness(reminderRoot);
await h1.emit("session_start", { reason: "startup" });
await h1.emit("turn_end", {});
assert.equal(h1.sent.length, 1, "oldest unhandled completion schedules one native Pi follow-up");
assert.deepEqual(h1.sent[0].options, { deliverAs: "followUp" }, "completion reminders use native follow-up delivery");
assert.equal(parseCompletionReminderRunId(h1.sent[0].text), "fray-native-a", "native follow-up still parses when it embeds child output");
assert.match(h1.sent[0].text, /^Child agent complete \[fray-native-a\]\./, "embedded reminder keeps the compact parseable prefix");
assert.match(h1.sent[0].text, /## Run metadata/, "embedded reminder includes run metadata");
assert.match(h1.sent[0].text, /- Thread: \.fray\/backlog\.md/, "embedded reminder includes thread metadata");
assert.match(h1.sent[0].text, /- Label\/purpose: native follow-up/, "embedded reminder includes purpose metadata");
assert.match(h1.sent[0].text, /- Intent: verify/, "embedded reminder includes intent metadata");
assert.match(h1.sent[0].text, /- Status: incomplete/, "missing final output is reclassified before the reminder is sent");
assert.match(h1.sent[0].text, /## Incomplete handoff\n\nINCOMPLETE HANDOFF — no child final output could be captured or recovered\./, "empty final output is an explicit incomplete handoff");
assert.match(h1.sent[0].text, /Do not mark this as a normal successful completion\./, "empty final output cannot look like a normal completion");
assert.match(h1.sent[0].text, /incomplete handoff\/bug/, "empty final output is described as an incomplete handoff bug");
assert.match(h1.sent[0].text, /Fallback records:\n- Findings sidecar: \.fray\/backlog\.findings\/fray-native-a\.md\n- Child session file: \.pi\/sessions\/fray-native-a\.jsonl/, "empty final output points at fallback records");
assert.match(h1.sent[0].text, /fray_reconcile with runId=fray-native-a and markHandled=true/, "embedded reminder tells the orchestrator how to advance the ledger");
assert.match(h1.sent[0].text, /Do not call fray_next in normal completion handling/, "embedded reminder keeps fray_next out of the normal follow-up flow");
assert.doesNotMatch(h1.sent[0].text, /SHOULD_NOT_APPEAR_IN_FIRST_REMINDER/, "native reminder embeds only the oldest unhandled child");
assert.equal(h1.entries.filter((entry) => entry.data?.action === "delivered").length, 0, "queue-time input interception is not treated as actual delivery");
await h1.emit("turn_end", {});
assert.equal(h1.sent.length, 1, "scheduled in-memory reminders are not duplicated while still queued");
h1.setPending(true);
await h1.emit("agent_end", {});
assert.equal(h1.sent.length, 1, "pending native follow-up messages are not duplicated at agent_end");
h1.setPending(false);
await h1.emit("agent_end", {});
assert.equal(h1.sent.length, 2, "if no native follow-up is pending and message_start never arrived by agent_end, it is re-queued");
await h1.emit("message_start", { message: { role: "user", content: [{ type: "text", text: h1.sent.at(-1)!.text }] } });
assert.equal(h1.entries.filter((entry) => entry.data?.action === "delivered").length, 1, "actual user message delivery is recorded on message_start");
await h1.emit("turn_end", {});
assert.equal(h1.sent.length, 2, "delivered reminders are not spammed again in the same live session");
assertOnlyFollowUpDelivery(h1.sent, "same-session reminder scheduling");

const h2 = makeHarness(reminderRoot, [...h1.entries]);
await h2.emit("session_start", { reason: "reload" });
await h2.emit("turn_end", {});
assert.equal(h2.sent.length, 1, "persisted reminder breadcrumbs do not suppress resurfacing after reload while the run is unhandled");
assertOnlyFollowUpDelivery(h2.sent, "reload reminder resurfacing");

const fallbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fray-reminder-session-fallback-"));
writeSessionJsonl(fallbackRoot, ".pi/sessions/fray-fallback-a.jsonl", [
  { role: "user", content: [{ type: "text", text: "task" }] },
  { role: "assistant", content: [{ type: "text", text: "FALLBACK FINAL OUTPUT" }], stopReason: "end" },
]);
appendRun(fallbackRoot, { id: "fray-fallback-a", thread: "backlog", label: "session fallback", intent: "verify", status: "completed", startedAt: base, updatedAt: "2026-06-18T15:12:00.000Z", completedAt: "2026-06-18T15:12:00.000Z", reconciled: false, sessionFile: ".pi/sessions/fray-fallback-a.jsonl" });
const hFallback = makeHarness(fallbackRoot);
await hFallback.emit("session_start", { reason: "startup" });
assert.equal(hFallback.sent.length, 1, "session-file fallback run schedules one reminder");
assert.match(hFallback.sent[0].text, /- Status: completed/, "session-file fallback keeps a genuinely completed run completed");
assert.match(hFallback.sent[0].text, /- Final output source: session-file/, "session-file fallback is recorded in run metadata");
assert.match(hFallback.sent[0].text, /## Child final output\n\nFALLBACK FINAL OUTPUT/, "session-file fallback output is embedded in the native follow-up");
const fallbackNext = await hFallback.tool("fray_next", {});
assert.match(fallbackNext.content[0].text, /## Child final output\n\nFALLBACK FINAL OUTPUT/, "fray_next also shows session-file fallback output as the handoff");
assertOnlyFollowUpDelivery(hFallback.sent, "session-file fallback reminder scheduling");

const finalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fray-final-output-"));
const finalBody = "VERDICT: done\nChanged paths:\n- extensions/fray/index.ts\nVerification: bun test passed\nCaveats: none\nNext action: reload Pi";
appendRun(finalRoot, { id: "fray-final-a", thread: "backlog", label: "final output first", intent: "verify", status: "completed", startedAt: base, updatedAt: "2026-06-18T15:20:00.000Z", completedAt: "2026-06-18T15:20:00.000Z", reconciled: false, findingsPath: ".fray/backlog.findings/fray-final-a.md", sessionFile: ".pi/sessions/fray-final-a.jsonl", finalOutput: finalBody });
appendRun(finalRoot, { id: "fray-final-b", thread: "backlog", label: "final output second", intent: "verify", status: "completed", startedAt: base, updatedAt: "2026-06-18T15:21:00.000Z", completedAt: "2026-06-18T15:21:00.000Z", reconciled: false, finalOutput: "SECOND CHILD SHOULD NOT BE EMBEDDED" });
fs.mkdirSync(path.join(finalRoot, ".fray", "backlog.findings"), { recursive: true });
fs.writeFileSync(path.join(finalRoot, ".fray", "backlog.findings", "fray-final-a.md"), "raw sidecar should not be the primary handoff");
const h3 = makeHarness(finalRoot);
const next = await h3.tool("fray_next", {});
const nextText = next.content[0].text;
assert.match(nextText, /## Child final output/, "fray_next presents captured child final output as the primary handoff");
assert.match(nextText, /VERDICT: done/, "captured child final output is visible in fray_next");
assert.doesNotMatch(nextText, /raw sidecar should not be the primary handoff/, "sidecar content is not inlined when final output exists");
await h3.emit("session_start", { reason: "startup" });
assert.equal(h3.sent.length, 1, "final-output run schedules one embedded native follow-up");
assert.match(h3.sent[0].text, new RegExp(finalBody.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "native follow-up embeds the captured child final output body in full");
assert.match(h3.sent[0].text, /Changed paths:\n- extensions\/fray\/index\.ts/, "embedded final output surfaces changed paths when the child reported them");
assert.match(h3.sent[0].text, /Verification: bun test passed/, "embedded final output surfaces verification when the child reported it");
assert.match(h3.sent[0].text, /Caveats: none/, "embedded final output surfaces caveats when the child reported them");
assert.match(h3.sent[0].text, /Next action: reload Pi/, "embedded final output surfaces next action when the child reported it");
assert.match(h3.sent[0].text, /Reference records:\n- Raw sidecar: \.fray\/backlog\.findings\/fray-final-a\.md\n- Child session file: \.pi\/sessions\/fray-final-a\.jsonl/, "embedded final-output prompt keeps raw record references");
assert.doesNotMatch(h3.sent[0].text, /SECOND CHILD SHOULD NOT BE EMBEDDED/, "embedded native follow-up still includes only one result at a time");
const handledAck = await h3.tool("fray_reconcile", { runId: "fray-final-a", markHandled: true });
assert.match(handledAck.content[0].text, /handled fray-final-a/, "markHandled returns a concise handled ack");
assert.match(handledAck.content[0].text, /next unhandled: fray-final-b/, "handled ack points at the next queued run without manual fray_next polling");
assert.match(handledAck.content[0].text, /No child output echoed/, "handled ack does not echo the just-handled child output");
assert.doesNotMatch(handledAck.content[0].text, /VERDICT: done/, "markHandled does not duplicate the embedded final output");
assert.match(handledAck.content[0].text, /Do not call fray_next unless/, "handled ack documents fray_next as recovery/debug/manual drain only");
assert.equal(parseCompletionReminderRunId(h3.sent.at(-1)!.text), "fray-final-b", "markHandled queues the next native follow-up automatically");
const staleInteractive = await h3.emit("input", { source: "interactive", text: h3.sent[0].text });
assert.deepEqual(staleInteractive, [{ action: "handled" }], "stale handled follow-ups are suppressed even when delivered as non-extension input");
assertOnlyFollowUpDelivery(h3.sent, "final-output reminder scheduling");

const guard = await h3.emit("before_agent_start", { prompt: "Unrelated work", images: undefined, systemPrompt: "", systemPromptOptions: {} });
assert.ok(guard.some((result: any) => /Fray orchestration guardrail/.test(result?.message?.content || "")), "unhandled results inject an orchestration guardrail before agent start");
assert.ok(guard.some((result: any) => /start or steer any clear follow-up/.test(result?.message?.content || "")), "guardrail tells the orchestrator to act on clear follow-ups");

console.log("fray reminder dedupe verification OK");
