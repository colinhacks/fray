import assert from "node:assert/strict";
import { completionQueueFromRuns, foldRunEvents, formatRunDisplayTitle, isSlugLikeLabel, nextCompletionReminderRun, parseCompletionReminderRunId, readableTitleFromSlug, SPINNER_FRAME_MS, spinnerFrameAt, stableRunTitleText, staleLedgerLiveRuns } from "../extensions/fray/index.ts";

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

console.log("fray reminder dedupe verification OK");
