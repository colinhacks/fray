import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  formatSize,
  getAgentDir,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";

const Type = {
  String: (opts: Record<string, unknown> = {}) => ({ type: "string", ...opts }),
  Boolean: (opts: Record<string, unknown> = {}) => ({ type: "boolean", ...opts }),
  Array: (items: Record<string, unknown>, opts: Record<string, unknown> = {}) => ({ type: "array", items, ...opts }),
  Optional: (schema: Record<string, unknown>) => ({ ...schema, __optional: true }),
  Object: (properties: Record<string, any>, opts: Record<string, unknown> = {}) => {
    const required = Object.entries(properties).filter(([, schema]) => !schema.__optional).map(([key]) => key);
    const clean = Object.fromEntries(Object.entries(properties).map(([key, schema]) => {
      const { __optional, ...rest } = schema;
      return [key, rest];
    }));
    return { type: "object", properties: clean, required, additionalProperties: false, ...opts };
  },
};

const STATUS = ["todo", "active", "needs-decision", "blocked", "deferred", "done", "dismissed"] as const;
const LEGACY_STATUS: Record<string, string> = { planned: "todo", enqueued: "todo" };
const TERMINAL = new Set(["done", "dismissed"]);
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "bash"];
const RUNS_FILE = "runs.jsonl";
const CHILD_WIDGET_KEY = "fray-child-runs";
const STATUS_KEY = "fray";
const LEGACY_HELPER_KEY = "fray-threads";
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const SPINNER_FRAME_MS = 250;
const LIVE_RUN_STATUSES = new Set<string>(["starting", "running"]);
const SETTLED_RUN_STATUSES = new Set<string>(["completed", "failed", "aborted", "error"]);
const COMPLETION_REMINDER_PREFIX = "Child agent complete";
const LEGACY_COMPLETION_REMINDER_PREFIX = "FRAY COMPLETION TASK";
const REMINDER_STATE_ENTRY = "fray-completion-reminder-state";

type RunStatus = "starting" | "running" | "completed" | "failed" | "aborted";
type Intent = "harvest" | "investigate" | "implement" | "review" | "verify" | "design" | "custom";
type ModelHint = "current" | "cheap" | "balanced" | "strong" | "strongest";

type DispatchArgs = {
  thread?: string;
  label: string;
  intent?: Intent;
  task: string;
  modelHint?: ModelHint;
  thinkingHint?: string;
  model?: string;
  tools?: string[];
  cwd?: string;
  capabilities?: { write?: boolean };
};

type FrayConfig = {
  enabled: boolean;
  autonomousMode: boolean;
  state: Record<string, string>;
  maxChildren: number;
};

type Thread = {
  id: string;
  title: string;
  status: string;
  next: string;
  updatedAt: string;
  queued: boolean;
  text: string;
  errors: string[];
};

export type RunRecord = {
  id: string;
  thread?: string;
  label: string;
  intent: Intent;
  status: RunStatus;
  model?: string;
  thinking?: string;
  cwd: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  findingsPath?: string;
  error?: string;
  progress?: string;
  sessionId?: string;
  sessionFile?: string;
  reconciled?: boolean;
  reconciledAt?: string;
};

type LiveRun = Omit<RunRecord, "progress"> & {
  session: any;
  output: string;
  progress: string[];
  unsubscribe?: () => void;
  abort?: AbortController;
};

const liveRuns = new Map<string, LiveRun>();
const pendingDispatchRunIds = new Set<string>();
let lastCtx: ExtensionContext | undefined;
let cooldownUntil = 0;
let widgetTimer: ReturnType<typeof setInterval> | undefined;
const lastUiValues = new Map<string, string>();
let reminderStateRestored = false;
const reminderStates = new Map<string, { scheduledRunIds: Set<string>; deliveredRunIds: Set<string> }>();

function frayRoot(cwd: string): string {
  let current = cwd;
  while (current && current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, ".fray")) || fs.existsSync(path.join(current, ".pi"))) return current;
    current = path.dirname(current);
  }
  return cwd;
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function scalar(raw: unknown): string {
  return String(raw ?? "").replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
}

function bool(raw: unknown, fallback: boolean): boolean {
  const v = scalar(raw).toLowerCase();
  if (["true", "on", "yes", "1"].includes(v)) return true;
  if (["false", "off", "no", "0"].includes(v)) return false;
  return fallback;
}

function loadConfig(root: string): FrayConfig {
  const config: FrayConfig = { enabled: true, autonomousMode: false, state: {}, maxChildren: 8 };
  let src = "";
  try {
    src = fs.readFileSync(path.join(root, ".fray", "config.yml"), "utf8");
  } catch {
    return config;
  }
  let inState = false;
  for (const line of src.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const nested = line.match(/^[ \t]+([\w-]+):\s*(.*)$/);
    if (inState && nested) {
      config.state[nested[1]] = scalar(nested[2]);
      continue;
    }
    const top = line.match(/^([\w-]+):\s*(.*)$/);
    if (!top) continue;
    if (top[1] === "state") {
      inState = true;
      continue;
    }
    inState = false;
    if (top[1] === "enabled") config.enabled = bool(top[2], config.enabled);
    else if (top[1] === "autonomous_mode") config.autonomousMode = bool(top[2], config.autonomousMode);
    else if (top[1] === "max_children") config.maxChildren = Math.max(1, Number.parseInt(scalar(top[2]), 10) || config.maxChildren);
  }
  return config;
}

function frontmatter(src: string): Record<string, string> | null {
  const match = src.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const out: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = scalar(kv[2]);
  }
  return out;
}

function sectionFirstLine(src: string, heading: string): string {
  const lines = src.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${heading}\\s*$`, "i").test(line));
  if (start === -1) return "";
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) break;
    if (lines[i].trim()) return lines[i].trim();
  }
  return "";
}

function readThreads(root: string): Thread[] {
  const dir = path.join(root, ".fray");
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith(".md") && !name.startsWith("_"))
      .sort()
      .map((name) => {
        const id = name.replace(/\.md$/, "");
        const file = path.join(dir, name);
        const text = fs.readFileSync(file, "utf8");
        const updatedAt = fs.statSync(file).mtime.toISOString();
        const fm = frontmatter(text);
        const errors: string[] = [];
        if (!fm) errors.push("no YAML frontmatter");
        else {
          if (!fm.title) errors.push("missing required field: title");
          if (!fm.status) errors.push("missing required field: status");
          else if (!STATUS.includes((LEGACY_STATUS[fm.status] || fm.status) as any)) errors.push(`invalid status ${JSON.stringify(fm.status)}`);
        }
        const status = fm?.status ? (LEGACY_STATUS[fm.status] || fm.status) : "?";
        return { id, title: fm?.title || "", status, next: sectionFirstLine(text, "Next step"), updatedAt, queued: /\bQUEUED\b/.test(text), text, errors };
      });
  } catch {
    return [];
  }
}

function formatBoard(root: string, only?: string): string {
  const cfg = loadConfig(root);
  const threads = readThreads(root);
  const unhandled = readRuns(root).filter((r) => ["completed", "failed", "aborted"].includes(r.status) && !r.reconciled);
  const live = Array.from(liveRuns.values()).filter((r) => r.cwd.startsWith(root));
  const out = [`fray board - autonomous_mode: ${cfg.autonomousMode ? "on" : "off"} - live:${live.length} unhandled:${unhandled.length}`];
  const errors = threads.flatMap((t) => t.errors.map((e) => `${t.id}.md: ${e}`));
  if (errors.length) out.push(`\nVALIDATION ERRORS:\n${errors.map((e) => `  ${e}`).join("\n")}`);
  if (live.length) out.push(`\n## running children (${live.length})\n${live.map((r) => `- ${r.id} [${r.intent}] ${r.thread ? `${r.thread}: ` : ""}${r.label} — ${r.status}`).join("\n")}`);
  if (unhandled.length) out.push(`\n## unhandled child results (${unhandled.length})\n${unhandled.map((r) => `- ${r.id} [${r.status}] ${r.thread ? `${r.thread}: ` : ""}${r.label}${r.findingsPath ? ` -> ${r.findingsPath}` : ""}`).join("\n")}`);
  for (const status of only ? [only] : STATUS) {
    const group = threads.filter((t) => t.status === status);
    if (!group.length) continue;
    out.push(`\n## ${status} (${group.length})`);
    for (const t of group) out.push(`- ${t.id} - ${t.title} (updated ${t.updatedAt})\n    -> ${t.next}`);
  }
  return out.join("\n");
}

function threadPath(root: string, thread: string): string {
  return path.join(root, ".fray", `${thread}.md`);
}

function assertThread(root: string, thread?: string) {
  if (!thread) return;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(thread)) throw new Error(`invalid fray thread slug: ${thread}`);
  if (!fs.existsSync(threadPath(root, thread))) throw new Error(`.fray/${thread}.md does not exist; create the thread before dispatching.`);
}

function appendRunEvent(root: string, event: Record<string, unknown>) {
  ensureDir(path.join(root, ".fray"));
  fs.appendFileSync(path.join(root, ".fray", RUNS_FILE), `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
}

export function foldRunEvents(events: Record<string, any>[]): RunRecord[] {
  const latest = new Map<string, RunRecord>();
  for (const ev of events) {
    if (!ev?.id) continue;
    const prev = latest.get(ev.id) || ({} as Partial<RunRecord>);
    latest.set(ev.id, { ...prev, ...ev } as RunRecord);
  }
  return Array.from(latest.values()).sort((a, b) => String(b.updatedAt || b.startedAt || "").localeCompare(String(a.updatedAt || a.startedAt || "")));
}

function readRuns(root: string): RunRecord[] {
  const file = path.join(root, ".fray", RUNS_FILE);
  const events: Record<string, any>[] = [];
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      events.push(JSON.parse(line));
    }
  } catch {
    // no runs yet
  }
  return foldRunEvents(events);
}

function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child || parent);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function shortDurationSince(iso?: string, nowMs = Date.now()): string {
  if (!iso) return "";
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const seconds = Math.max(0, Math.floor((nowMs - time) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
  return `${Math.floor(hours / 24)}d`;
}

function shortRunId(id?: string): string {
  if (!id) return "";
  const tail = id.split("-").pop();
  return (tail || id).slice(0, 8);
}

function threadMetaBySlug(root: string): Map<string, Thread> {
  return new Map(readThreads(root).map((thread) => [thread.id, thread]));
}

function titleWords(value?: string): Set<string> {
  return new Set(String(value || "").toLowerCase().match(/[a-z0-9]+/g) || []);
}

function materiallySameTitle(a?: string, b?: string): boolean {
  const left = titleWords(a);
  const right = titleWords(b);
  if (!left.size || !right.size) return false;
  const leftText = Array.from(left).join(" ");
  const rightText = Array.from(right).join(" ");
  if (leftText === rightText || leftText.includes(rightText) || rightText.includes(leftText)) return true;
  const overlap = Array.from(left).filter((word) => right.has(word)).length;
  return overlap / Math.min(left.size, right.size) >= 0.6;
}

export function isSlugLikeLabel(value?: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(String(value || "").trim());
}

export function readableTitleFromSlug(value?: string): string {
  const title = String(value || "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return title ? `${title.charAt(0).toUpperCase()}${title.slice(1)}` : "";
}

const VOLATILE_TITLE_PREFIX = /^(?:issue|bug|task|todo|feature|story|epic|discussion|question|note|pr|pull request)\s*(?:[·:–—-])\s*/i;

export function stableRunTitleText(value?: string): string {
  let title = String(value || "").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 2; i++) title = title.replace(VOLATILE_TITLE_PREFIX, "").trim();
  return title;
}

export function formatRunDisplayTitle(run: Pick<RunRecord, "id" | "thread" | "label" | "intent">, thread?: { id?: string; title?: string }): { title: string; indicator: string } {
  const threadId = run.thread || thread?.id || "";
  const threadTitle = stableRunTitleText(thread?.title);
  const label = String(run.label || "").trim();
  const labelIsSlug = isSlugLikeLabel(label);
  const labelTitle = stableRunTitleText(labelIsSlug ? readableTitleFromSlug(label) : label);
  const threadSlugTitle = readableTitleFromSlug(threadId);

  if (!threadId) return { title: labelTitle || run.intent || shortRunId(run.id) || "unthreaded child", indicator: "unthreaded" };

  const title = labelTitle || threadTitle || threadSlugTitle || run.intent || shortRunId(run.id) || "child";
  const indicator = threadId && !materiallySameTitle(title, threadId) ? `#${threadId}` : "";
  return { title, indicator };
}

function runTitle(root: string, threads: Map<string, Thread>, run: RunRecord): { title: string; indicator: string } {
  const thread = run.thread ? threads.get(run.thread) : undefined;
  return formatRunDisplayTitle(run, thread);
}

function liveRunRecord(live: LiveRun): RunRecord {
  const { session: _session, unsubscribe: _unsubscribe, abort: _abort, output: _output, progress: _progress, ...record } = live;
  return record;
}

function liveRunRecords(root: string): RunRecord[] {
  return Array.from(liveRuns.values())
    .filter((live) => isWithin(root, live.cwd))
    .map(liveRunRecord)
    .sort((a, b) => ageKey(a, "started").localeCompare(ageKey(b, "started")));
}

function currentRuns(root: string): RunRecord[] {
  const byId = new Map(readRuns(root).map((run) => [run.id, run]));
  for (const record of liveRunRecords(root)) {
    const existing = byId.get(record.id);
    if (existing && SETTLED_RUN_STATUSES.has(existing.status || "")) continue;
    byId.set(record.id, { ...(existing || {}), ...record });
  }
  return Array.from(byId.values());
}

function ageKey(run: RunRecord, primary: "started" | "completed"): string {
  return primary === "started"
    ? String(run.startedAt || run.updatedAt || run.completedAt || "")
    : String(run.completedAt || run.updatedAt || run.startedAt || "");
}

export function staleLedgerLiveRuns(runs: RunRecord[], liveRunIds: Set<string>, pendingRunIds: Set<string> = new Set()): RunRecord[] {
  return runs.filter((run) => !!run.id && LIVE_RUN_STATUSES.has(run.status || "") && !liveRunIds.has(run.id) && !pendingRunIds.has(run.id));
}

function staleChildRuns(root: string): RunRecord[] {
  const liveRunIds = new Set(liveRunRecords(root).map((run) => run.id));
  return staleLedgerLiveRuns(readRuns(root), liveRunIds, pendingDispatchRunIds);
}

function markLostLiveHandles(root: string): RunRecord[] {
  const stale = staleChildRuns(root);
  if (!stale.length) return [];
  const now = new Date().toISOString();
  for (const run of stale) {
    appendRunEvent(root, {
      id: run.id,
      status: "aborted",
      updatedAt: now,
      completedAt: now,
      error: "live child handle missing after reload or parent session replacement",
      previousStatus: run.status,
      reconciled: false,
    });
  }
  return stale;
}

function liveChildRuns(root: string): RunRecord[] {
  return liveRunRecords(root)
    .filter((run) => !!run.id && LIVE_RUN_STATUSES.has(run.status || ""))
    .sort((a, b) => ageKey(a, "started").localeCompare(ageKey(b, "started")));
}

export function completionQueueFromRuns(runs: RunRecord[], thread?: string): RunRecord[] {
  return runs
    .filter((run) => !!run.id && SETTLED_RUN_STATUSES.has(run.status || "") && run.reconciled !== true && (!thread || run.thread === thread))
    .sort((a, b) => ageKey(a, "completed").localeCompare(ageKey(b, "completed")));
}

function completionQueue(root: string, thread?: string): RunRecord[] {
  return completionQueueFromRuns(currentRuns(root), thread);
}

function readRunFindings(root: string, run: RunRecord): string {
  if (!run.findingsPath) return "";
  try {
    return fs.readFileSync(path.join(root, run.findingsPath), "utf8");
  } catch {
    return "";
  }
}

function formatCompletionQueueReminder(root: string): string | undefined {
  const queue = completionQueue(root);
  const run = queue[0];
  if (!run) return undefined;
  return `${COMPLETION_REMINDER_PREFIX} [${run.id}].`;
}

export function parseCompletionReminderRunId(text: string): string | undefined {
  if (text.startsWith(COMPLETION_REMINDER_PREFIX)) return text.match(/^Child agent complete\s+\[([^\]]+)\]/)?.[1];
  if (text.startsWith("[child complete]")) return text.match(/\[([^\]]+)\]\s*$/)?.[1];
  if (text.startsWith(LEGACY_COMPLETION_REMINDER_PREFIX)) return text.match(/Oldest unhandled child result:\s+(\S+)/)?.[1];
  return undefined;
}

function reminderState(root: string) {
  let state = reminderStates.get(root);
  if (!state) {
    state = { scheduledRunIds: new Set<string>(), deliveredRunIds: new Set<string>() };
    reminderStates.set(root, state);
  }
  return state;
}

function restoreReminderState(ctx: ExtensionContext) {
  if (reminderStateRestored) return;
  reminderStateRestored = true;
  const entries = (ctx.sessionManager as any)?.getEntries?.() || [];
  for (const entry of entries) {
    if (entry?.type !== "custom" || entry?.customType !== REMINDER_STATE_ENTRY) continue;
    const data = entry.data || {};
    if (typeof data.root !== "string" || typeof data.runId !== "string") continue;
    const state = reminderState(data.root);
    if (data.action === "scheduled") state.scheduledRunIds.add(data.runId);
    if (data.action === "delivered") {
      state.scheduledRunIds.add(data.runId);
      state.deliveredRunIds.add(data.runId);
    }
  }
}

function appendReminderState(pi: ExtensionAPI, root: string, runId: string, action: "scheduled" | "delivered" | "suppressed") {
  try {
    pi.appendEntry(REMINDER_STATE_ENTRY, { root, runId, action, ts: new Date().toISOString() });
  } catch {
    // Session persistence is best-effort; in-memory state still prevents duplicates in this runtime.
  }
}

function handleCompletionReminderInput(pi: ExtensionAPI, root: string, text: string): { action: "continue" | "handled" } | undefined {
  const runId = parseCompletionReminderRunId(text);
  if (!runId) return undefined;

  const state = reminderState(root);
  const current = completionQueue(root)[0];
  if (current?.id !== runId || state.deliveredRunIds.has(runId)) {
    appendReminderState(pi, root, runId, "suppressed");
    return { action: "handled" };
  }

  state.scheduledRunIds.add(runId);
  state.deliveredRunIds.add(runId);
  appendReminderState(pi, root, runId, "delivered");
  return { action: "continue" };
}

export function nextCompletionReminderRun(runs: RunRecord[], scheduledRunIds: Set<string>): RunRecord | undefined {
  const run = completionQueueFromRuns(runs)[0];
  if (!run?.id || scheduledRunIds.has(run.id)) return undefined;
  return run;
}

function queueCompletionReminder(pi: ExtensionAPI, root: string): boolean {
  const state = reminderState(root);
  const run = nextCompletionReminderRun(currentRuns(root), state.scheduledRunIds);
  if (!run?.id) return false;

  const message = formatCompletionQueueReminder(root);
  if (!message || parseCompletionReminderRunId(message) !== run.id) return false;

  try {
    pi.sendUserMessage(message, { deliverAs: "followUp" });
  } catch {
    try { pi.sendUserMessage(message); } catch { return false; }
  }
  state.scheduledRunIds.add(run.id);
  appendReminderState(pi, root, run.id, "scheduled");
  return true;
}

export function spinnerFrameAt(nowMs = Date.now(), frames: readonly string[] = SPINNER_FRAMES, frameMs = SPINNER_FRAME_MS): string {
  if (!frames.length) return "";
  const safeFrameMs = Math.max(1, Math.floor(frameMs));
  const frame = Math.floor(Math.max(0, nowMs) / safeFrameMs) % frames.length;
  return frames[frame];
}

function renderChildBoard(root: string, ctx: ExtensionContext, live: RunRecord[], nowMs = Date.now()): string[] {
  const theme = ctx.ui.theme;
  const threads = threadMetaBySlug(root);
  const spin = theme.fg("accent", spinnerFrameAt(nowMs));
  const lines: string[] = [];

  if (live.length) {
    lines.push(`${theme.fg("accent", "threads")} ${theme.fg("dim", `${live.length} running`)}`);
    for (const run of live) {
      const { title, indicator } = runTitle(root, threads, run);
      const age = shortDurationSince(run.startedAt, nowMs);
      const meta = [`${run.status || "running"}`, age ? `age ${age}` : ""].filter(Boolean).join(" · ");
      const threadMeta = indicator ? ` ${theme.fg("muted", indicator)}` : "";
      lines.push(`${spin} ${theme.fg("toolTitle", title)}${threadMeta} ${theme.fg("dim", `— ${meta}`)}`);
    }
  }

  return lines;
}

function uiValueKey(value: string | string[] | undefined): string {
  return JSON.stringify(value ?? null);
}

function setWidgetIfChanged(ctx: ExtensionContext, key: string, value: string[] | undefined, options?: Record<string, unknown>) {
  const stateKey = `widget:${key}`;
  const next = uiValueKey(value);
  if (lastUiValues.get(stateKey) === next) return;
  lastUiValues.set(stateKey, next);
  ctx.ui.setWidget(key, value, options);
}

function setStatusIfChanged(ctx: ExtensionContext, key: string, value: string | undefined) {
  const stateKey = `status:${key}`;
  const next = uiValueKey(value);
  if (lastUiValues.get(stateKey) === next) return;
  lastUiValues.set(stateKey, next);
  ctx.ui.setStatus(key, value);
}

function updateWidget(ctx?: ExtensionContext, nowMs = Date.now()) {
  if (!ctx?.hasUI || ctx.mode !== "tui") return;
  const root = frayRoot(ctx.cwd);
  const theme = ctx.ui.theme;
  const frayDir = path.join(root, ".fray");

  setWidgetIfChanged(ctx, "fray", undefined);
  setWidgetIfChanged(ctx, LEGACY_HELPER_KEY, undefined);
  setStatusIfChanged(ctx, LEGACY_HELPER_KEY, undefined);

  if (!fs.existsSync(frayDir)) {
    setWidgetIfChanged(ctx, CHILD_WIDGET_KEY, undefined);
    setStatusIfChanged(ctx, STATUS_KEY, undefined);
    return;
  }

  const cfg = loadConfig(root);
  if (!cfg.enabled) {
    setWidgetIfChanged(ctx, CHILD_WIDGET_KEY, undefined);
    setStatusIfChanged(ctx, STATUS_KEY, `${theme.fg("dim", "fray:")} ${theme.fg("dim", "off")}`);
    return;
  }

  const live = liveChildRuns(root);
  const lines = renderChildBoard(root, ctx, live, nowMs).filter((line) => line.trim().length > 0);
  setWidgetIfChanged(ctx, CHILD_WIDGET_KEY, lines.length ? lines : undefined, { placement: "aboveEditor" });

  if (!live.length) {
    setStatusIfChanged(ctx, STATUS_KEY, undefined);
    return;
  }

  const mode = cfg.autonomousMode ? theme.fg("thinkingHigh", "auto") : theme.fg("success", "on");
  const running = `${live.length} child${live.length === 1 ? "" : "ren"} running`;
  setStatusIfChanged(ctx, STATUS_KEY, `${theme.fg("dim", "fray:")} ${mode} · ${running}`);
}

function extractText(value: any): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("\n");
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    if (Array.isArray(value.content)) return extractText(value.content);
    if (value.message) return extractText(value.message);
  }
  return "";
}

function finalAssistantText(session: any): string {
  const messages = session?.messages || session?.agent?.state?.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return extractText(messages[i].content || messages[i]);
  }
  return "";
}

function getToolResultText(result: any): string {
  const content = result?.content;
  if (!Array.isArray(content)) return "";
  return content.map((entry) => entry?.type === "text" ? String(entry.text || "") : entry?.type ? `[${entry.type}]` : "").filter(Boolean).join("\n");
}

function compactRender(label: string, allowExpand = false, expandedRenderer?: (result: any, options: any, theme: any, context: any) => any) {
  return (result: any, options: any, theme: any, context: any) => {
    if (allowExpand && options.expanded && expandedRenderer) return expandedRenderer(result, options, theme, context);
    const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
    const output = getToolResultText(result).trim();
    const lines = output ? output.split("\n").length : 0;
    const bytes = Buffer.byteLength(output, "utf8");
    const state = options.isPartial ? theme.fg("warning", "…") : context.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
    const size = lines ? `${lines} line${lines === 1 ? "" : "s"}, ${formatSize(bytes)}` : "no visible text";
    text.setText(`${state} ${theme.fg("toolTitle", label)} ${theme.fg("dim", size)}`);
    return text;
  };
}

function ellipsize(value: string, max = 90): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function compactCallSummary(name: string, args: any): string {
  if (name === "read") return args?.path ? String(args.path) : "";
  if (name === "write") return args?.path ? `${args.path} (${formatSize(Buffer.byteLength(String(args.content || ""), "utf8"))})` : "";
  if (name === "edit") {
    const count = Array.isArray(args?.edits) ? args.edits.length : 0;
    const plural = count === 1 ? "replacement" : "replacements";
    return args?.path ? `${args.path} (${count} ${plural})` : `${count} ${plural}`;
  }
  if (name === "bash") return args?.command ? ellipsize(String(args.command)) : "";
  if (name === "grep") return [args?.pattern ? `/${ellipsize(String(args.pattern), 40)}/` : "", args?.path, args?.glob].filter(Boolean).join(" ");
  if (name === "find") return [args?.pattern, args?.path].filter(Boolean).join(" in ");
  if (name === "ls") return args?.path ? String(args.path) : ".";
  return ellipsize(JSON.stringify(args || {}));
}

function compactCall(name: string, args: any, theme: any, context: any) {
  const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
  const summary = compactCallSummary(name, args);
  text.setText(`${theme.fg("toolTitle", name)}${summary ? ` ${theme.fg("dim", summary)}` : ""}`);
  return text;
}

function compactBuiltinDefinition(factory: (cwd: string) => ToolDefinition<any, any, any>): ToolDefinition<any, any, any> {
  const base = factory(process.cwd());
  return {
    ...base,
    execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext) {
      return factory(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
    },
    renderCall(args: any, theme: any, context: any) {
      return compactCall(base.name, args, theme, context);
    },
    renderResult: compactRender(base.name, true, base.renderResult?.bind(base)),
  };
}

function chooseModel(ctx: ExtensionContext, hint: ModelHint, explicit?: string): Model<any> | undefined {
  const registry = ctx.modelRegistry;
  if (explicit) {
    const [provider, ...rest] = explicit.includes("/") ? explicit.split("/") : [ctx.model?.provider || "", explicit];
    const found = registry.find(provider, rest.join("/"));
    if (found) return found;
  }
  const available = registry.getAvailable();
  if (!available.length) return ctx.model;
  if (hint === "current" && ctx.model) return ctx.model;
  const scored = available.map((model) => {
    const hay = `${model.provider}/${model.id} ${(model as any).name || ""}`.toLowerCase();
    let score = 0;
    const isGpt55 = /gpt-5\.5/.test(hay) && !/fast/.test(hay);
    if (hint === "cheap") score += /haiku|mini|small|flash|fast/.test(hay) ? 80 : 0;
    else {
      if (isGpt55) score += 100;
      if (hint === "balanced") score += /gpt-5\.4|sonnet|gpt-4\.1|gemini.*pro/.test(hay) ? 40 : 0;
      if (hint === "strong") score += /opus|pro/.test(hay) ? 45 : 0;
      if (hint === "strongest") score += /opus|fable|pro/.test(hay) ? 60 : 0;
    }
    if (/fast/.test(hay) && ["balanced", "strong", "strongest"].includes(hint)) score -= 60;
    if (ctx.model && model.provider === ctx.model.provider) score += 5;
    return { model, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0]?.score > 0 ? scored[0].model : (ctx.model || available[0]);
}

function defaultThinking(intent: Intent, hint?: string): ThinkingLevel {
  if (hint) return hint as ThinkingLevel;
  if (["implement", "review", "design"].includes(intent)) return "xhigh";
  if (["investigate", "verify"].includes(intent)) return "high";
  if (intent === "harvest") return "medium";
  return "high";
}

function defaultTools(intent: Intent, write?: boolean, requested?: string[]): string[] {
  if (requested?.length) return Array.from(new Set([...requested, "fray_run_update"]));
  const base = write ?? ["implement", "custom"].includes(intent) ? DEFAULT_TOOLS : READ_ONLY_TOOLS;
  return Array.from(new Set([...base, "grep", "find", "ls", "fray_run_update"]));
}

function dispatchArgSchema(includeThread = true) {
  const props: Record<string, any> = {
    label: Type.String(),
    intent: Type.Optional(Type.String()),
    task: Type.String(),
    modelHint: Type.Optional(Type.String()),
    thinkingHint: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    tools: Type.Optional(Type.Array(Type.String())),
    cwd: Type.Optional(Type.String()),
    capabilities: Type.Optional(Type.Object({ write: Type.Optional(Type.Boolean()) })),
  };
  if (includeThread) props.thread = Type.Optional(Type.String());
  return Type.Object(props);
}

function childContract(args: any, runId: string): string {
  const threadLine = args.thread ? `You are working for fray thread .fray/${args.thread}.md. Read it as authoritative context, but do not edit it or .fray/config.yml directly.` : "This is a one-shot fray child run with no owning thread.";
  return `You are a pi fray child agent. Run id: ${runId}.\n\n${threadLine}\n\nYou have broad normal coding-agent permissions. Use read/write/edit/bash as needed for the assigned work. The only standing restrictions are coordination restrictions: do not run destructive git commands such as git reset, git checkout --, git stash, branch switches, or worktree creation in the shared tree; do not recursively copy the repo; do not edit canonical .fray thread/config/run files directly. Use the fray_run_update tool for live status. If you need durable output, write a findings sidecar only under .fray/${args.thread || "backlog"}.findings/${runId}.md.\n\nSub-agents are instruments, not deciders. Surface default/security/product/brand/API/config decisions as questions unless the prompt says they are already decided.\n\nEnd your final response with a ## Follow-ups section. Include concrete follow-ups, whether an independent review is needed, verification run, changed paths, and the single most important next step.\n\nTask:\n${args.task || args.prompt || ""}`;
}

function isProtectedFrayPath(root: string, absolutePath: string): boolean {
  const rel = path.relative(root, absolutePath).replace(/\\/g, "/");
  return /^\.fray\/(config\.yml|runs\.jsonl|[^/]+\.md)$/.test(rel);
}

function childToolDefinitions(root: string, cwd: string, enabled: string[], runUpdateTool: ToolDefinition<any>): ToolDefinition<any>[] {
  const out: ToolDefinition<any>[] = [];
  const want = new Set(enabled);
  if (want.has("read")) out.push(createReadToolDefinition(cwd));
  if (want.has("grep")) out.push(createGrepToolDefinition(cwd));
  if (want.has("find")) out.push(createFindToolDefinition(cwd));
  if (want.has("ls")) out.push(createLsToolDefinition(cwd));
  if (want.has("bash")) out.push(createBashToolDefinition(cwd, {
    spawnHook: (ctx) => {
      if (/\bgit\s+(reset|stash|checkout\s+--|clean\s+-)/.test(ctx.command)) throw new Error("fray blocks destructive git operations in the shared tree; use an isolated clone if needed.");
      return ctx;
    },
  }));
  if (want.has("write")) out.push(createWriteToolDefinition(cwd, {
    operations: {
      async mkdir(dir) { await fs.promises.mkdir(dir, { recursive: true }); },
      async writeFile(file, content) {
        if (isProtectedFrayPath(root, file)) throw new Error("canonical .fray thread/config/run files are orchestrator-owned; write a findings sidecar or use fray_run_update");
        await fs.promises.writeFile(file, content);
      },
    },
  }));
  if (want.has("edit")) out.push(createEditToolDefinition(cwd, {
    operations: {
      async readFile(file) { return fs.promises.readFile(file); },
      async access(file) { await fs.promises.access(file, fs.constants.R_OK | fs.constants.W_OK); },
      async writeFile(file, content) {
        if (isProtectedFrayPath(root, file)) throw new Error("canonical .fray thread/config/run files are orchestrator-owned; write a findings sidecar or use fray_run_update");
        await fs.promises.writeFile(file, content);
      },
    },
  }));
  out.push(runUpdateTool);
  return out;
}

function makeRunUpdateTool(root: string, runId: string, thread?: string): ToolDefinition<any> {
  return {
    name: "fray_run_update",
    label: "Fray Run Update",
    description: "Update live fray child-run progress without editing the canonical thread doc.",
    parameters: Type.Object({
      status: Type.Optional(Type.String({ description: "Short phase such as probing, editing, testing, finalizing, blocked." })),
      summary: Type.String({ description: "One concise current-state update." }),
      changedPaths: Type.Optional(Type.Array(Type.String())),
      openQuestions: Type.Optional(Type.Array(Type.String())),
      next: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId: string, params: any) {
      const dir = path.join(root, ".fray", `${thread || "backlog"}.findings`);
      ensureDir(dir);
      const progressFile = path.join(dir, `${runId}.progress.jsonl`);
      const row = { ts: new Date().toISOString(), runId, ...params };
      fs.appendFileSync(progressFile, `${JSON.stringify(row)}\n`);
      const run = liveRuns.get(runId);
      if (run) {
        run.progress.push(`${params.status || "update"}: ${params.summary}`);
        run.updatedAt = row.ts;
        appendRunEvent(root, { id: runId, status: "running", updatedAt: row.ts, progress: params.summary });
      } else {
        appendRunEvent(root, { id: runId, updatedAt: row.ts, progress: params.summary, warning: "progress received but no live child handle is registered" });
      }
      return { content: [{ type: "text", text: `fray progress recorded for ${runId}` }], details: { progressFile } };
    },
  };
}

async function dispatchChild(pi: ExtensionAPI, ctx: ExtensionContext, args: DispatchArgs) {
  const root = frayRoot(ctx.cwd);
  const cfg = loadConfig(root);
  if (!cfg.enabled) throw new Error("fray is disabled in .fray/config.yml");
  if (Date.now() < cooldownUntil) throw new Error(`fray dispatch is cooling down after provider rate-limit until ${new Date(cooldownUntil).toISOString()}`);
  if (liveRuns.size >= cfg.maxChildren) throw new Error(`fray has ${liveRuns.size} live children; max_children is ${cfg.maxChildren}`);
  if (args.thread) assertThread(root, args.thread);

  const runId = `fray-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${randomUUID().slice(0, 8)}`;
  pendingDispatchRunIds.add(runId);
  const intent: Intent = args.intent || "custom";
  const model = chooseModel(ctx, args.modelHint || (intent === "harvest" ? "cheap" : ["implement", "review", "design"].includes(intent) ? "strong" : "balanced"), args.model);
  const thinking = defaultThinking(intent, args.thinkingHint);
  const tools = defaultTools(intent, args.capabilities?.write, args.tools);
  const cwd = args.cwd || ctx.cwd;
  const childSessionManager = SessionManager.create(cwd, undefined, { id: runId });
  const now = new Date().toISOString();
  const record: RunRecord = { id: runId, thread: args.thread, label: args.label || intent, intent, status: "starting", model: model ? `${model.provider}/${model.id}` : undefined, thinking, cwd, startedAt: now, updatedAt: now, reconciled: false, sessionId: childSessionManager.getSessionId(), sessionFile: childSessionManager.getSessionFile() };
  appendRunEvent(root, record);

  try {
  const loader = new DefaultResourceLoader({
    cwd: record.cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    appendSystemPrompt: ["You are a background child agent managed by pi-fray. Keep final output concise and factual."],
  });
  await loader.reload();

  const runUpdateTool = makeRunUpdateTool(root, runId, args.thread);
  const { session } = await createAgentSession({
    cwd: record.cwd,
    authStorage: ctx.modelRegistry.authStorage,
    modelRegistry: ctx.modelRegistry,
    model,
    thinkingLevel: thinking,
    noTools: "builtin",
    tools,
    customTools: childToolDefinitions(root, record.cwd, tools, runUpdateTool),
    resourceLoader: loader,
    sessionManager: childSessionManager,
  });

  const live: LiveRun = { ...record, status: "running", session, output: "", progress: [] };
  live.unsubscribe = session.subscribe((event: any) => {
    live.updatedAt = new Date().toISOString();
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") live.output += event.assistantMessageEvent.delta;
  });
  liveRuns.set(runId, live);
  pendingDispatchRunIds.delete(runId);
  appendRunEvent(root, { id: runId, status: "running", updatedAt: live.updatedAt, sessionId: record.sessionId, sessionFile: record.sessionFile });
  ensureWidgetTimer(ctx);
  updateWidget(ctx);

  const prompt = childContract(args, runId);
  void session.prompt(prompt).then(() => {
    completeRun(pi, root, runId, "completed");
  }).catch((err: any) => {
    completeRun(pi, root, runId, "failed", String(err?.message || err));
  });

  return { runId, thread: args.thread, status: "running", model: record.model, thinking, tools, sessionId: record.sessionId, sessionFile: record.sessionFile };
  } catch (err: any) {
    pendingDispatchRunIds.delete(runId);
    appendRunEvent(root, { id: runId, status: "failed", updatedAt: new Date().toISOString(), completedAt: new Date().toISOString(), error: String(err?.message || err), reconciled: false, sessionId: record.sessionId, sessionFile: record.sessionFile });
    try { childSessionManager.getSessionFile() && fs.rmSync(childSessionManager.getSessionFile()!, { force: true }); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}

function completeRun(pi: ExtensionAPI, root: string, runId: string, status: RunStatus, error?: string) {
  const run = liveRuns.get(runId);
  if (!run) return;
  run.status = status;
  run.completedAt = new Date().toISOString();
  run.updatedAt = run.completedAt;
  run.error = error;
  run.output = finalAssistantText(run.session) || run.output || "";
  run.unsubscribe?.();
  const dir = path.join(root, ".fray", `${run.thread || "backlog"}.findings`);
  ensureDir(dir);
  const findingsPath = path.join(dir, `${runId}.md`);
  const relFindings = path.relative(root, findingsPath);
  run.findingsPath = relFindings;
  const body = [`# ${run.label}`, "", `Run: \`${runId}\``, `Status: ${status}`, `Intent: ${run.intent}`, run.model ? `Model: ${run.model}` : "", run.thinking ? `Thinking: ${run.thinking}` : "", error ? `Error: ${error}` : "", "", "## Progress", "", ...(run.progress.length ? run.progress.map((p) => `- ${p}`) : ["none recorded"]), "", "## Final output", "", run.output || "(no final output captured)", ""].filter(Boolean).join("\n");
  fs.writeFileSync(findingsPath, body);
  appendRunEvent(root, { id: runId, status, updatedAt: run.updatedAt, completedAt: run.completedAt, findingsPath: relFindings, error, reconciled: false, sessionId: run.sessionId, sessionFile: run.sessionFile });
  try { run.session.dispose?.(); } catch { /* ignore cleanup failure */ }
  liveRuns.delete(runId);
  syncWidgetTimer(lastCtx);
  updateWidget(lastCtx);
  queueCompletionReminder(pi, root);
}

function markHandled(root: string, runId: string) {
  const current = readRuns(root).find((run) => run.id === runId);
  if (current?.reconciled) return;
  const now = new Date().toISOString();
  appendRunEvent(root, { id: runId, updatedAt: now, reconciled: true, reconciledAt: now });
}

function requireLiveRunForAction(root: string, runId: string, action: string): LiveRun {
  const run = liveRuns.get(runId);
  if (run && isWithin(root, run.cwd)) return run;
  const known = readRuns(root).find((candidate) => candidate.id === runId);
  if (!known) throw new Error(`unknown fray run ${runId}; no live child handle or ledger record exists`);
  if (LIVE_RUN_STATUSES.has(known.status || "")) {
    markLostLiveHandles(root);
    throw new Error(`fray run ${runId} is known but not live/steerable: ledger status is ${known.status}, but no live SDK child handle is registered. It was marked aborted as lost; reconcile or relaunch the work if still needed.`);
  }
  const hint = known.status === "aborted" && /live child handle missing/.test(String(known.error || ""))
    ? " It was previously marked lost after reload/session replacement; reconcile or relaunch if needed."
    : "";
  throw new Error(`fray run ${runId} is ${known.status || "not running"}, not live/steerable for ${action}.${hint}`);
}

function stopWidgetTimer() {
  if (widgetTimer) clearInterval(widgetTimer);
  widgetTimer = undefined;
}

function ensureWidgetTimer(ctx?: ExtensionContext) {
  if (!ctx?.hasUI || ctx.mode !== "tui" || widgetTimer) return;
  if (!liveChildRuns(frayRoot(ctx.cwd)).length) return;
  widgetTimer = setInterval(() => {
    const activeCtx = lastCtx || ctx;
    updateWidget(activeCtx);
    syncWidgetTimer(activeCtx);
  }, SPINNER_FRAME_MS);
  widgetTimer.unref?.();
}

function syncWidgetTimer(ctx?: ExtensionContext) {
  if (ctx?.hasUI && ctx.mode === "tui" && liveChildRuns(frayRoot(ctx.cwd)).length) ensureWidgetTimer(ctx);
  else stopWidgetTimer();
}

export default function FrayExtension(pi: ExtensionAPI) {
  function remember(ctx: ExtensionContext) {
    lastCtx = ctx;
    restoreReminderState(ctx);
    markLostLiveHandles(frayRoot(ctx.cwd));
    syncWidgetTimer(ctx);
    updateWidget(ctx);
  }

  for (const factory of [
    createReadToolDefinition,
    createBashToolDefinition,
    createGrepToolDefinition,
    createFindToolDefinition,
    createLsToolDefinition,
    createWriteToolDefinition,
    createEditToolDefinition,
  ]) {
    pi.registerTool(compactBuiltinDefinition(factory));
  }

  pi.registerTool({
    name: "fray_status",
    label: "Fray Status",
    description: "Print the computed fray board, live child runs, and unhandled child results.",
    parameters: Type.Object({ status: Type.Optional(Type.String()) }),
    renderResult: compactRender("fray_status"),
    async execute(_id, params: any, _signal, _update, ctx) {
      remember(ctx);
      return { content: [{ type: "text", text: formatBoard(frayRoot(ctx.cwd), params.status) }], details: {} };
    },
  });

  pi.registerTool({
    name: "fray_validate",
    label: "Fray Validate",
    description: "Validate fray thread frontmatter.",
    parameters: Type.Object({}),
    renderResult: compactRender("fray_validate"),
    async execute(_id, _params, _signal, _update, ctx) {
      remember(ctx);
      const root = frayRoot(ctx.cwd);
      const errors = readThreads(root).flatMap((t) => t.errors.map((e) => `${t.id}.md: ${e}`));
      return { content: [{ type: "text", text: errors.length ? `fray validation FAILED\n${errors.join("\n")}` : "fray validation OK" }], details: { errors } };
    },
  });

  pi.registerTool({
    name: "fray_search",
    label: "Fray Search",
    description: "Search fray thread ids, titles, and bodies.",
    parameters: Type.Object({ query: Type.String() }),
    renderResult: compactRender("fray_search"),
    async execute(_id, params: any, _signal, _update, ctx) {
      remember(ctx);
      const q = params.query.toLowerCase();
      const hits = readThreads(frayRoot(ctx.cwd)).filter((t) => `${t.id} ${t.title} ${t.text}`.toLowerCase().includes(q));
      return { content: [{ type: "text", text: hits.length ? hits.map((t) => `${t.id} [${t.status}] - ${t.title}`).join("\n") : `no fray threads match ${JSON.stringify(params.query)}` }], details: { hits: hits.map(({ text, ...h }) => h) } };
    },
  });

  pi.registerTool({
    name: "fray_create_thread",
    label: "Fray Create Thread",
    description: "Create a canonical .fray/<slug>.md thread before dispatching child agents.",
    parameters: Type.Object({
      slug: Type.String(),
      title: Type.String(),
      goal: Type.String(),
      status: Type.Optional(Type.String()),
      decisions: Type.Optional(Type.String()),
      openQuestions: Type.Optional(Type.String()),
      steps: Type.Optional(Type.Array(Type.String())),
      nextStep: Type.String(),
      initialDispatches: Type.Optional(Type.Array(dispatchArgSchema(false))),
    }),
    async execute(_id, params: any, _signal, _update, ctx) {
      remember(ctx);
      const root = frayRoot(ctx.cwd);
      ensureDir(path.join(root, ".fray"));
      if (!/^[a-z0-9][a-z0-9-]*$/.test(params.slug)) throw new Error("slug must be lowercase kebab-case");
      const file = threadPath(root, params.slug);
      if (fs.existsSync(file)) throw new Error(`.fray/${params.slug}.md already exists`);
      const initialDispatches = (params.initialDispatches || []) as DispatchArgs[];
      const status = params.status || (initialDispatches.length ? "active" : "todo");
      if (!STATUS.includes(status as any)) throw new Error(`status must be one of: ${STATUS.join(", ")}`);
      const steps = (params.steps || []).map((s: string) => `- [ ] ${s}`).join("\n") || (initialDispatches.length ? "- [ ] Handle dispatched child results." : "- [ ] Dispatch the first bounded child run.");
      const text = `---\ntitle: ${JSON.stringify(params.title)}\nstatus: ${status}\nlast_update: ${new Date().toISOString().slice(0, 10)}\n---\n\n## Goal\n${params.goal}\n\n## Status\n${initialDispatches.length ? "Thread created; initial child runs dispatching." : "Thread created; no child runs dispatched yet."}\n\n## Decisions\n${params.decisions || "none yet"}\n\n## Open questions\n${params.openQuestions || "none"}\n\n## Steps / follow-up queue\n${steps}\n\n## Next step\n${params.nextStep}\n`;
      fs.writeFileSync(file, text);
      const dispatches = [];
      for (const child of initialDispatches) dispatches.push(await dispatchChild(pi, ctx, { ...child, thread: params.slug }));
      const suffix = dispatches.length ? ` and dispatched ${dispatches.map((run) => run.runId).join(", ")}` : "";
      return { content: [{ type: "text", text: `created .fray/${params.slug}.md${suffix}` }], details: { path: path.relative(root, file), dispatches } };
    },
  });

  pi.registerTool({
    name: "fray_dispatch",
    label: "Fray Dispatch",
    description: "Atomically create a live SDK-backed fray child agent and associate it with an optional thread.",
    parameters: dispatchArgSchema(true),
    async execute(_id, params: any, _signal, _update, ctx) {
      remember(ctx);
      const result = await dispatchChild(pi, ctx, params);
      return { content: [{ type: "text", text: `dispatched ${result.runId}${result.thread ? ` for .fray/${result.thread}.md` : ""} (${result.model || "default model"}, ${result.thinking})` }], details: result };
    },
  });

  pi.registerTool({
    name: "fray_dispatch_many",
    label: "Fray Dispatch Many",
    description: "Dispatch multiple independent fray children and record them in the structured run ledger.",
    parameters: Type.Object({
      thread: Type.Optional(Type.String()),
      agents: Type.Array(dispatchArgSchema(true)),
    }),
    async execute(_id, params: any, _signal, _update, ctx) {
      remember(ctx);
      const root = frayRoot(ctx.cwd);
      const agents = (params.agents || []) as DispatchArgs[];
      if (!agents.length) throw new Error("agents must contain at least one dispatch");
      const cfg = loadConfig(root);
      if (liveRuns.size + agents.length > cfg.maxChildren) throw new Error(`fray has ${liveRuns.size} live children; dispatching ${agents.length} would exceed max_children ${cfg.maxChildren}`);
      for (const agent of agents) assertThread(root, agent.thread || params.thread);
      const dispatches = [];
      for (const agent of agents) dispatches.push(await dispatchChild(pi, ctx, { ...agent, thread: agent.thread || params.thread }));
      return { content: [{ type: "text", text: `dispatched ${dispatches.map((run) => run.runId).join(", ")}` }], details: { dispatches } };
    },
  });

  pi.registerTool({
    name: "fray_children",
    label: "Fray Children",
    description: "List live fray child runs and recently completed runs.",
    parameters: Type.Object({}),
    renderResult: compactRender("fray_children"),
    async execute(_id, _params, _signal, _update, ctx) {
      remember(ctx);
      const root = frayRoot(ctx.cwd);
      const live = liveChildRuns(root);
      const runs = currentRuns(root).sort((a, b) => String(b.updatedAt || b.startedAt || "").localeCompare(String(a.updatedAt || a.startedAt || ""))).slice(0, 20);
      const text = [`live children: ${live.length}`, ...live.map((r) => `- ${r.id} [${r.intent}] ${r.thread || "-"}: ${r.label} (${r.status})`), "", "recent runs:", ...runs.map((r) => `- ${r.id} [${r.status}] ${r.thread || "-"}: ${r.label}${r.error ? ` — ${r.error}` : ""}${r.reconciled ? " (handled)" : ""}`)].join("\n");
      return { content: [{ type: "text", text }], details: { live, runs } };
    },
  });

  pi.registerTool({
    name: "fray_next",
    label: "Fray Next",
    description: "Return the oldest unhandled child result so the orchestrator can handle completions one at a time.",
    parameters: Type.Object({ thread: Type.Optional(Type.String()) }),
    renderResult: compactRender("fray_next"),
    async execute(_id, params: any, _signal, _update, ctx) {
      remember(ctx);
      const root = frayRoot(ctx.cwd);
      const queue = completionQueue(root, params.thread);
      const run = queue[0];
      if (!run) return { content: [{ type: "text", text: "fray result queue empty" }], details: { queue: [] } };
      const findings = readRunFindings(root, run);
      const header = `next unhandled: ${run.id} [${run.status}] ${run.thread || "-"}: ${run.label}${run.findingsPath ? ` -> ${run.findingsPath}` : ""}`;
      return { content: [{ type: "text", text: findings ? `${header}\n\n${findings}` : `${header}\n\n${JSON.stringify(run, null, 2)}` }], details: { run, remaining: queue.length } };
    },
  });

  pi.registerTool({
    name: "fray_steer",
    label: "Fray Steer",
    description: "Send a steering message into a running fray child agent.",
    parameters: Type.Object({ runId: Type.String(), message: Type.String() }),
    async execute(_id, params: any, _signal, _update, ctx) {
      remember(ctx);
      const root = frayRoot(ctx.cwd);
      const run = requireLiveRunForAction(root, params.runId, "steer");
      await run.session.steer(params.message);
      appendRunEvent(root, { id: params.runId, updatedAt: new Date().toISOString(), steered: true });
      return { content: [{ type: "text", text: `steered ${params.runId}` }], details: {} };
    },
  });

  pi.registerTool({
    name: "fray_followup",
    label: "Fray Follow-up",
    description: "Queue a follow-up message for a fray child after its current work settles.",
    parameters: Type.Object({ runId: Type.String(), message: Type.String() }),
    async execute(_id, params: any, _signal, _update, ctx) {
      remember(ctx);
      const root = frayRoot(ctx.cwd);
      const run = requireLiveRunForAction(root, params.runId, "follow-up");
      await run.session.followUp(params.message);
      appendRunEvent(root, { id: params.runId, updatedAt: new Date().toISOString(), followupQueued: true });
      return { content: [{ type: "text", text: `queued follow-up for ${params.runId}` }], details: {} };
    },
  });

  pi.registerTool({
    name: "fray_abort_child",
    label: "Fray Abort Child",
    description: "Abort a running fray child agent. Prefer steering/follow-up over aborting unless necessary.",
    parameters: Type.Object({ runId: Type.String(), reason: Type.Optional(Type.String()) }),
    async execute(_id, params: any, _signal, _update, ctx) {
      remember(ctx);
      const root = frayRoot(ctx.cwd);
      const run = requireLiveRunForAction(root, params.runId, "abort");
      await run.session.abort();
      completeRun(pi, root, params.runId, "aborted", params.reason || "aborted by orchestrator");
      return { content: [{ type: "text", text: `aborted ${params.runId}` }], details: {} };
    },
  });

  pi.registerTool({
    name: "fray_reconcile",
    label: "Fray Result",
    description: "Read a child run's result. Pass markHandled after the orchestrator has handled whatever the result requires; markReconciled is accepted as a legacy alias.",
    parameters: Type.Object({ runId: Type.String(), markHandled: Type.Optional(Type.Boolean()), markReconciled: Type.Optional(Type.Boolean()) }),
    renderResult: compactRender("fray_reconcile"),
    async execute(_id, params: any, _signal, _update, ctx) {
      remember(ctx);
      const root = frayRoot(ctx.cwd);
      const run = currentRuns(root).find((r) => r.id === params.runId);
      if (!run) throw new Error(`unknown fray run ${params.runId}`);
      const findings = readRunFindings(root, run);
      const shouldMarkHandled = !!(params.markHandled || params.markReconciled);
      if (shouldMarkHandled) markHandled(root, params.runId);
      updateWidget(ctx);
      return { content: [{ type: "text", text: findings || JSON.stringify(run, null, 2) }], details: { run, markedHandled: shouldMarkHandled } };
    },
  });

  pi.registerTool({
    name: "fray_set_mode",
    label: "Fray Set Mode",
    description: "Set .fray/config.yml autonomous_mode on or off. Use only when the user explicitly asks to change autonomous mode; enabling fray does not imply autonomous mode.",
    parameters: Type.Object({ autonomousMode: Type.Boolean() }),
    async execute(_id, params: any, _signal, _update, ctx) {
      remember(ctx);
      const root = frayRoot(ctx.cwd);
      const file = path.join(root, ".fray", "config.yml");
      ensureDir(path.dirname(file));
      let src = "";
      try { src = fs.readFileSync(file, "utf8"); } catch { src = "enabled: true\nautonomous_mode: off\nstate: {}\n"; }
      if (/^autonomous_mode:/m.test(src)) src = src.replace(/^autonomous_mode:.*$/m, `autonomous_mode: ${params.autonomousMode ? "on" : "off"}`);
      else src = `autonomous_mode: ${params.autonomousMode ? "on" : "off"}\n${src}`;
      fs.writeFileSync(file, src);
      updateWidget(ctx);
      return { content: [{ type: "text", text: `autonomous_mode=${params.autonomousMode ? "on" : "off"}` }], details: {} };
    },
  });

  pi.registerCommand("fray-queue", {
    description: "Show unhandled fray child results, oldest first",
    handler: async (_args, ctx) => {
      remember(ctx);
      const root = frayRoot(ctx.cwd);
      const queue = completionQueue(root);
      if (!queue.length) {
        ctx.ui.notify("Fray result queue empty", "info");
        return;
      }
      const threads = threadMetaBySlug(root);
      const lines = queue.map((run, index) => {
        const { title, indicator } = runTitle(root, threads, run);
        return `${index + 1}. ${run.id} — ${title} ${indicator} (${run.status || "settled"})`;
      });
      ctx.ui.notify(`Fray unhandled results:\n${lines.join("\n")}`, "warning");
    },
  });
  pi.registerCommand("fray-next", {
    description: "Show the oldest unhandled fray child result",
    handler: async (_args, ctx) => {
      remember(ctx);
      const root = frayRoot(ctx.cwd);
      const run = completionQueue(root)[0];
      if (!run) {
        ctx.ui.notify("Fray result queue empty", "info");
        return;
      }
      const threads = threadMetaBySlug(root);
      const { title, indicator } = runTitle(root, threads, run);
      const findings = readRunFindings(root, run).trim();
      const preview = findings ? `\n\n${findings.slice(0, 2400)}${findings.length > 2400 ? "\n…" : ""}` : "";
      ctx.ui.notify(
        `Next Fray result:\n${run.id}\n${title} ${indicator}\n${run.findingsPath ? `Findings: ${run.findingsPath}` : "No findings path"}${preview}`,
        "warning",
      );
    },
  });
  pi.registerCommand("fray-done", {
    description: "Mark a fray child result handled; defaults to the oldest queued run",
    handler: async (args, ctx) => {
      remember(ctx);
      const root = frayRoot(ctx.cwd);
      const requested = String(args ?? "").trim();
      const queue = completionQueue(root);
      const run = requested ? queue.find((candidate) => candidate.id === requested || shortRunId(candidate.id) === requested) : queue[0];
      if (!run?.id) {
        ctx.ui.notify(requested ? `No queued Fray result matches ${requested}` : "Fray result queue empty", "info");
        return;
      }
      markHandled(root, run.id);
      updateWidget(ctx);
      ctx.ui.notify(`Marked Fray result handled: ${run.id}`, "info");
      queueCompletionReminder(pi, root);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    reminderStates.clear();
    reminderStateRestored = false;
    remember(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    const root = frayRoot(ctx.cwd);
    for (const run of liveRuns.values()) {
      appendRunEvent(root, { id: run.id, status: "aborted", updatedAt: new Date().toISOString(), completedAt: new Date().toISOString(), error: "parent pi session shut down before child completed", reconciled: false, sessionId: run.sessionId, sessionFile: run.sessionFile });
      try { await run.session.abort(); } catch { /* ignore */ }
      try { run.session.dispose?.(); } catch { /* ignore */ }
    }
    liveRuns.clear();
    pendingDispatchRunIds.clear();
    stopWidgetTimer();
    lastUiValues.clear();
    if (ctx.hasUI) {
      ctx.ui.setWidget(CHILD_WIDGET_KEY, undefined);
      ctx.ui.setWidget("fray", undefined);
      ctx.ui.setWidget(LEGACY_HELPER_KEY, undefined);
      ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.setStatus(LEGACY_HELPER_KEY, undefined);
    }
    if (lastCtx === ctx) lastCtx = undefined;
  });
  pi.on("turn_end", async (_event, ctx) => {
    remember(ctx);
    queueCompletionReminder(pi, frayRoot(ctx.cwd));
  });
  pi.on("tool_execution_start", async (_event, ctx) => { remember(ctx); });
  pi.on("tool_execution_update", async (_event, ctx) => { remember(ctx); });
  pi.on("tool_execution_end", async (_event, ctx) => { remember(ctx); });
  pi.on("session_before_compact", async (_event, ctx) => {
    remember(ctx);
    // Pi's compaction hook can cancel or replace the summary, but it does not expose a simple append-only context slot.
    // Completed child runs are durable in .fray/runs.jsonl and findings sidecars; compact reminders are delivered only as follow-up messages.
  });
  pi.on("after_provider_response", async (event, ctx) => {
    remember(ctx);
    if ((event as any).status === 429) {
      cooldownUntil = Date.now() + 60_000;
      ctx.ui.notify("fray dispatch cooldown: provider returned 429", "warning");
    }
  });
  pi.on("tool_call", async (event, ctx) => {
    remember(ctx);
    if (event.toolName === "bash") {
      const command = String((event.input as any)?.command || "");
      if (/\bgit\s+(reset|stash|checkout\s+--|clean\s+-)/.test(command)) return { block: true, reason: "fray blocks destructive git operations in the shared tree; steer the child or use an isolated clone instead." };
    }
  });
  pi.on("input", async (event, ctx) => {
    remember(ctx);
    const root = frayRoot(ctx.cwd);
    if (event.source === "extension") {
      const reminderAction = handleCompletionReminderInput(pi, root, event.text);
      if (reminderAction) return reminderAction;
    }
    if (!event.text.startsWith("/fray ")) return;
    return { action: "continue" };
  });
}
