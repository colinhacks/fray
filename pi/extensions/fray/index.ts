import { spawn } from "node:child_process";
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
import { patchThreadFile } from "./thread-patch.ts";

const Type = {
  String: (opts: Record<string, unknown> = {}) => ({ type: "string", ...opts }),
  Number: (opts: Record<string, unknown> = {}) => ({ type: "number", ...opts }),
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
const SETTLED_RUN_STATUSES = new Set<string>(["completed", "failed", "aborted", "incomplete", "error"]);
const COMPLETION_REMINDER_PREFIX = "Child agent complete";
const LEGACY_COMPLETION_REMINDER_PREFIX = "FRAY COMPLETION TASK";
const REMINDER_STATE_ENTRY = "fray-completion-reminder-state";
const EXTERNAL_STATUS_SUFFIX = ".external-status.json";
const EXTERNAL_LOG_TAIL_CHARS = 24000;
const BACKLOG_THREAD = "backlog";
export const LOST_HANDLE_GRACE_MS = 2 * 60 * 1000;

type RunStatus = "starting" | "running" | "completed" | "failed" | "aborted" | "incomplete";
type Intent = "harvest" | "investigate" | "implement" | "review" | "verify" | "design" | "custom";
type ModelHint = "current" | "cheap" | "balanced" | "strong" | "strongest";
type ExternalRunner = "codex" | "claude" | "custom";

type LaunchExternalArgs = {
  thread?: string;
  label: string;
  runner: ExternalRunner;
  prompt?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  finalOutputPath?: string;
};

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
  finalOutput?: string;
  finalOutputSource?: string;
  incompleteReason?: string;
  external?: boolean;
  externalRunner?: ExternalRunner;
  externalStatusPath?: string;
  externalLogFallbackFinal?: boolean;
  pid?: number;
  command?: string;
  args?: string[];
  logPath?: string;
  finalOutputPath?: string;
  exitCode?: number | null;
  exitSignal?: string | null;
  timeoutMs?: number;
  sessionId?: string;
  sessionFile?: string;
  sourceRunId?: string;
  resumeDepth?: number;
  startLeafId?: string;
  reconciled?: boolean;
  reconciledAt?: string;
};

type LiveRun = Omit<RunRecord, "progress"> & {
  session: any;
  output: string;
  currentAssistantText?: string;
  progress: string[];
  unsubscribe?: () => void;
  abort?: AbortController;
};

// Exported for tests: lets verification harnesses inspect/seed live child handles (e.g. to
// exercise the stale-source -> live-continuation steer redirect without a real SDK session).
export const liveRuns = new Map<string, LiveRun>();
const settlingExternalRunIds = new Set<string>();
const pendingDispatchRunIds = new Set<string>();
const resumingSourceRunIds = new Set<string>();
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
  const unhandled = readRuns(root).filter((r) => SETTLED_RUN_STATUSES.has(r.status || "") && !r.reconciled);
  const live = liveChildRuns(root);
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

function ensureBacklogThread(root: string) {
  ensureDir(path.join(root, ".fray"));
  const file = threadPath(root, BACKLOG_THREAD);
  if (fs.existsSync(file)) return;
  const text = `---\ntitle: "Backlog"\nstatus: active\nlast_update: ${new Date().toISOString().slice(0, 10)}\n---\n\n## Goal\nCentral control surface for child runs that were dispatched without a more specific fray thread.\n\n## Status\nBacklog thread initialized automatically. Reconcile child final outputs here when no narrower thread owns the work.\n\n## Decisions\nnone yet\n\n## Open questions\nnone\n\n## Steps / follow-up queue\n- [ ] Reconcile unthreaded child results into this backlog instead of leaving raw findings as the only record.\n\n## Next step\nRun fray_next, synthesize accepted child results here, report in chat, then mark handled.\n`;
  fs.writeFileSync(file, text);
}

function assertThread(root: string, thread?: string) {
  if (!thread) return;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(thread)) throw new Error(`invalid fray thread slug: ${thread}`);
  if (thread === BACKLOG_THREAD) ensureBacklogThread(root);
  if (!fs.existsSync(threadPath(root, thread))) throw new Error(`.fray/${thread}.md does not exist; create the thread before dispatching.`);
}

function effectiveThread(root: string, thread?: string): string {
  if (thread) {
    assertThread(root, thread);
    return thread;
  }
  ensureBacklogThread(root);
  return BACKLOG_THREAD;
}

function upsertThreadRunCard(root: string, run: Pick<RunRecord, "id" | "thread" | "label" | "intent" | "status" | "findingsPath" | "completedAt" | "reconciled" | "incompleteReason">) {
  const thread = run.thread || BACKLOG_THREAD;
  if (thread === BACKLOG_THREAD) ensureBacklogThread(root);
  const file = threadPath(root, thread);
  if (!fs.existsSync(file)) return;
  let src = fs.readFileSync(file, "utf8");
  const checked = run.reconciled ? "x" : " ";
  const status = run.reconciled ? "handled" : run.status || "running";
  const suffix = run.reconciled
    ? `reconciled ${new Date().toISOString().slice(0, 10)}`
    : run.status === "incomplete"
      ? `incomplete/needs retry${run.incompleteReason ? `: ${run.incompleteReason}` : ""}${run.findingsPath ? `; raw sidecar ${run.findingsPath}` : ""}`
      : SETTLED_RUN_STATUSES.has(String(run.status || ""))
        ? `awaiting native follow-up synthesis${run.findingsPath ? `; raw sidecar ${run.findingsPath}` : ""}`
        : `intent ${run.intent || "custom"}`;
  const line = `- [${checked}] ${run.id} [${status}] ${run.label || run.intent || "child"} — ${suffix}`;
  const lines = src.split("\n");
  const existing = lines.findIndex((candidate) => candidate.includes(run.id));
  if (existing !== -1) {
    lines[existing] = line;
    fs.writeFileSync(file, lines.join("\n"));
    return;
  }
  if (!/^## Child runs$/m.test(src)) src = `${src.replace(/\s*$/, "")}\n\n## Child runs\n`;
  src = `${src.replace(/\s*$/, "")}\n${line}\n`;
  fs.writeFileSync(file, src);
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
  const { session: _session, unsubscribe: _unsubscribe, abort: _abort, output: _output, currentAssistantText: _currentAssistantText, progress: _progress, ...record } = live;
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

function runActivityMs(run: Pick<RunRecord, "updatedAt" | "startedAt" | "completedAt">): number {
  for (const value of [run.updatedAt, run.startedAt, run.completedAt]) {
    const parsed = Date.parse(String(value || ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function isPastLostHandleGrace(run: RunRecord, nowMs: number, graceMs: number): boolean {
  const activityMs = runActivityMs(run);
  return activityMs <= 0 || nowMs - activityMs >= graceMs;
}

export function staleLedgerLiveRuns(runs: RunRecord[], liveRunIds: Set<string>, pendingRunIds: Set<string> = new Set(), nowMs = Date.now(), graceMs = LOST_HANDLE_GRACE_MS): RunRecord[] {
  return runs.filter((run) => !!run.id && !run.external && LIVE_RUN_STATUSES.has(run.status || "") && !liveRunIds.has(run.id) && !pendingRunIds.has(run.id) && isPastLostHandleGrace(run, nowMs, graceMs));
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
    const resolution = resolveRunFinalOutput(root, run);
    const classification = classifySettledRunStatus("aborted", resolution.text, resolution.reason);
    const settled: RunRecord = {
      ...run,
      status: classification.status,
      updatedAt: now,
      completedAt: now,
      finalOutput: resolution.text || undefined,
      finalOutputSource: resolution.source,
      incompleteReason: classification.incompleteReason,
      error: classification.incompleteReason || "live child handle missing after reload or parent session replacement",
      reconciled: false,
    };
    settled.findingsPath = writeRunFindings(root, settled, resolution.text);
    appendRunEvent(root, {
      id: run.id,
      status: settled.status,
      updatedAt: now,
      completedAt: now,
      findingsPath: settled.findingsPath,
      finalOutput: resolution.text || undefined,
      finalOutputSource: resolution.source,
      incompleteReason: settled.incompleteReason,
      error: settled.error,
      previousStatus: run.status,
      reconciled: false,
      sessionId: run.sessionId,
      sessionFile: run.sessionFile,
    });
    upsertThreadRunCard(root, settled);
  }
  return stale;
}

function repairCompletedRunsMissingFinalOutput(root: string): number {
  const runs = readRuns(root).filter((run) => run.status === "completed" && !run.reconciled && !String(run.finalOutput || "").trim() && !run.incompleteReason);
  let repaired = 0;
  for (const run of runs) {
    const now = new Date().toISOString();
    const resolution = resolveRunFinalOutput(root, run);
    if (resolution.text) {
      appendRunEvent(root, {
        id: run.id,
        updatedAt: now,
        finalOutput: resolution.text,
        finalOutputSource: resolution.source,
        recoveredFinalOutput: true,
      });
      repaired++;
      continue;
    }
    const classification = classifySettledRunStatus("completed", "", resolution.reason);
    const settled: RunRecord = {
      ...run,
      status: classification.status,
      updatedAt: now,
      completedAt: run.completedAt || now,
      incompleteReason: classification.incompleteReason,
      error: classification.incompleteReason,
      reconciled: false,
    };
    settled.findingsPath = run.findingsPath || writeRunFindings(root, settled, "");
    appendRunEvent(root, {
      id: run.id,
      status: settled.status,
      previousStatus: "completed",
      updatedAt: now,
      completedAt: settled.completedAt,
      findingsPath: settled.findingsPath,
      incompleteReason: settled.incompleteReason,
      error: settled.error,
      reconciled: false,
      sessionId: run.sessionId,
      sessionFile: run.sessionFile,
    });
    upsertThreadRunCard(root, settled);
    repaired++;
  }
  return repaired;
}

function runningExternalRuns(root: string): RunRecord[] {
  return readRuns(root)
    .filter((run) => !!run.id && !!run.external && LIVE_RUN_STATUSES.has(run.status || ""))
    .sort((a, b) => ageKey(a, "started").localeCompare(ageKey(b, "started")));
}

function liveChildRuns(root: string): RunRecord[] {
  return [
    ...liveRunRecords(root).filter((run) => !!run.id && LIVE_RUN_STATUSES.has(run.status || "")),
    ...runningExternalRuns(root),
  ].sort((a, b) => ageKey(a, "started").localeCompare(ageKey(b, "started")));
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

function formatFallbackRecords(run: RunRecord): string[] {
  return [
    run.findingsPath ? `- Findings sidecar: ${run.findingsPath}` : "- Findings sidecar: not recorded",
    run.finalOutputPath ? `- Final output file: ${run.finalOutputPath}` : "",
    run.logPath ? `- External log: ${run.logPath}` : "",
    run.sessionFile ? `- Child session file: ${run.sessionFile}` : run.external ? "" : "- Child session file: not recorded",
    !run.external && run.sessionFile ? `- Resume: use fray_steer with runId=${run.id} to continue from the recorded child session file` : "",
  ].filter(Boolean);
}

function formatRunResult(root: string, run: RunRecord): string {
  const header = `next unhandled: ${run.id} [${run.status}] ${run.thread || "-"}: ${run.label}${run.findingsPath ? ` -> ${run.findingsPath}` : ""}`;
  const finalOutput = String(run.finalOutput || "").trim();
  const needsRetry = run.status !== "completed" || !!run.incompleteReason || !finalOutput;
  const records = formatFallbackRecords(run).join("\n");
  if (finalOutput) {
    const title = run.status === "completed" ? "Child final output" : "Recovered child output";
    const metadata = run.external ? `\n\n## Run metadata\n\n${formatRunMetadata(run).join("\n")}` : "";
    const caution = needsRetry ? `\n\n## Status\n\nThis run is ${run.status}; treat the output as fallback evidence, not a successful completed handoff.${run.incompleteReason ? `\n\nReason: ${run.incompleteReason}` : ""}` : "";
    return `${header}${metadata}${caution}\n\n## ${title}\n\n${finalOutput}\n\n${run.findingsPath ? `Raw sidecar: ${run.findingsPath}` : ""}`.trim();
  }
  const reason = run.incompleteReason || run.error || missingFinalOutputReason();
  const findings = readRunFindings(root, run).trim();
  return `${header}\n\n## Incomplete Fray handoff\n\nNo child final output could be captured or recovered. Treat this run as incomplete/needs-retry, not as a successful completion.\n\nReason: ${reason}\n\nFallback records:\n${records}${findings ? `\n\n## Findings sidecar\n\n${findings}` : `\n\n${JSON.stringify(run, null, 2)}`}`;
}

function formatRunMetadata(run: RunRecord): string[] {
  const thread = run.thread || BACKLOG_THREAD;
  return [
    `- Run ID: ${run.id}`,
    `- Thread: .fray/${thread}.md`,
    `- Label/purpose: ${run.label || "-"}`,
    `- Intent: ${run.intent || "custom"}`,
    `- Status: ${run.status || "unknown"}`,
    run.error ? `- Error: ${run.error}` : "",
    run.startedAt ? `- Started: ${run.startedAt}` : "",
    run.completedAt ? `- Completed: ${run.completedAt}` : "",
    run.model ? `- Model: ${run.model}` : "",
    run.thinking ? `- Thinking: ${run.thinking}` : "",
    run.external ? `- External runner: ${run.externalRunner || "custom"}` : "",
    run.pid ? `- External PID: ${run.pid}` : "",
    run.command ? `- External command: ${[run.command, ...(run.args || [])].join(" ")}` : "",
    run.exitCode !== undefined ? `- Exit code: ${run.exitCode === null ? "null" : run.exitCode}` : "",
    run.exitSignal ? `- Exit signal: ${run.exitSignal}` : "",
    run.logPath ? `- External log: ${run.logPath}` : "",
    run.finalOutputPath ? `- Final output file: ${run.finalOutputPath}` : "",
    run.finalOutputSource ? `- Final output source: ${run.finalOutputSource}` : "",
    run.incompleteReason ? `- Incomplete reason: ${run.incompleteReason}` : "",
    run.findingsPath ? `- Findings sidecar: ${run.findingsPath}` : "",
    run.sessionFile ? `- Child session file: ${run.sessionFile}` : "",
  ].filter(Boolean);
}

function completionReminderHeadline(root: string, run: RunRecord): string {
  const threads = threadMetaBySlug(root);
  const { title, indicator } = runTitle(root, threads, run);
  const summary = [title || run.label || run.id, indicator].filter(Boolean).join(" ").trim();
  return `[${run.status || "settled"}] ${summary || run.id}`;
}

function formatCompletionQueueReminder(root: string): string | undefined {
  const queue = completionQueue(root);
  const run = queue[0];
  if (!run) return undefined;
  const childFinalOutput = String(run.finalOutput ?? "");
  const hasFinalOutput = childFinalOutput.trim().length > 0;
  const needsRetry = run.status !== "completed" || !!run.incompleteReason || !hasFinalOutput;
  const targetThreadPath = `.fray/${run.thread || BACKLOG_THREAD}.md`;
  const lines = [
    completionReminderHeadline(root, run),
    "",
    needsRetry
      ? "Handle this Fray child result now. This is an incomplete/failed/aborted handoff; do not treat it as a successful completed child result."
      : "Handle this Fray child result now. This is the oldest unhandled child result; do not batch other completions into this response.",
    "",
    "## Run metadata",
    "",
    ...formatRunMetadata(run),
    "",
    hasFinalOutput ? "## Child final output" : "## Incomplete handoff",
    "",
    hasFinalOutput ? childFinalOutput : "INCOMPLETE HANDOFF — no child final output could be captured or recovered.",
  ];
  if (needsRetry) {
    lines.push(
      "",
      "## Incomplete/needs-retry handling",
      "",
      `Reason: ${run.incompleteReason || run.error || missingFinalOutputReason()}`,
      "Do not mark this as a normal successful completion. Missing/empty final output is an incomplete handoff/bug; relaunch the child if the work is still needed, or record why no retry is needed before marking handled.",
      "",
      "Fallback records:",
      ...formatFallbackRecords(run),
      "Use fallback records only as evidence; they are not a substitute for a child final handoff.",
    );
  } else if (run.findingsPath || run.sessionFile) {
    lines.push("", "Reference records:");
    if (run.findingsPath) lines.push(`- Raw sidecar: ${run.findingsPath}`);
    if (run.sessionFile) lines.push(`- Child session file: ${run.sessionFile}`);
  }
  lines.push(
    "",
    "## Required handling",
    "",
    `Synthesize accepted facts for ${run.id} into ${targetThreadPath} before marking it handled.`,
    hasFinalOutput
      ? "Report in chat with purpose, result, changed files/actions, verification, caveats, and next action, using the embedded child final output above for those fields when present."
      : "Report in chat that the handoff is incomplete/needs-retry, include fallback references, and do not present the child as done.",
    "If this result identifies a clear blocker, known required fix, or reload blocker, start or steer the follow-up after the chat report unless a human-owned decision blocks it.",
    `Then call fray_reconcile with runId=${run.id} and markHandled=true only after the incomplete/successful handling is recorded; this is the handled-state ack and should not echo the child output.`,
    "Do not call fray_next in normal completion handling. If another result is queued, Fray will schedule the next native follow-up; use fray_next only for recovery, debugging, or a deliberate manual drain.",
  );
  return lines.join("\n").trimEnd();
}

export function parseCompletionReminderRunId(text: string): string | undefined {
  if (text.startsWith(COMPLETION_REMINDER_PREFIX)) return text.match(/^Child agent complete\s+\[([^\]]+)\]/)?.[1];
  if (text.startsWith("[child complete]")) return text.match(/\[([^\]]+)\]\s*$/)?.[1];
  if (text.startsWith(LEGACY_COMPLETION_REMINDER_PREFIX)) return text.match(/Oldest unhandled child result:\s+(\S+)/)?.[1];
  if (/^\[(?:completed|failed|aborted|incomplete|error)\]\s+/i.test(text)) return text.match(/(?:^|\n)- Run ID:\s*(\S+)/)?.[1];
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

function restoreReminderState(_ctx: ExtensionContext) {
  if (reminderStateRestored) return;
  reminderStateRestored = true;
  // Native Pi follow-up queues are process-local. Persisted reminder entries are audit/recovery breadcrumbs only; restoring them as suppression state would make an unhandled run disappear after reload if the queued native follow-up was lost.
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

  return { action: "continue" };
}

function handleCompletionReminderMessage(pi: ExtensionAPI, root: string, text: string) {
  const runId = parseCompletionReminderRunId(text);
  if (!runId) return;
  const current = completionQueue(root)[0];
  if (current?.id !== runId) return;
  const state = reminderState(root);
  state.scheduledRunIds.add(runId);
  if (state.deliveredRunIds.has(runId)) return;
  state.deliveredRunIds.add(runId);
  appendReminderState(pi, root, runId, "delivered");
}

function formatOrchestrationGuardrail(root: string, prompt: string): string | undefined {
  const queue = completionQueue(root);
  const run = queue[0];
  if (!run) return undefined;
  const reminderRunId = parseCompletionReminderRunId(prompt);
  const target = `${run.id} [${run.status}] ${run.thread || "-"}: ${run.label}`;
  const needsRetry = run.status !== "completed" || !!run.incompleteReason || !String(run.finalOutput || "").trim();
  return [
    "Fray orchestration guardrail:",
    `- ${queue.length} unhandled child result${queue.length === 1 ? "" : "s"}; oldest is ${target}.`,
    reminderRunId
      ? needsRetry
        ? `- The current prompt is the native Pi follow-up for ${reminderRunId}; it is incomplete/failed/aborted. Treat it as retryable unless you explicitly record why no retry is needed.`
        : `- The current prompt is the native Pi follow-up for ${reminderRunId}; its embedded child final output is the primary handoff. Use fray_next only for recovery/debug/manual drain, or fray_reconcile without markHandled only if you need to re-read missing data.`
      : "- Before unrelated work or more dispatches, handle the oldest child result unless the user asked a higher-priority direct question.",
    "- Required handling: synthesize accepted facts into the owning thread or .fray/backlog.md, report purpose/result/changed files/actions/verification/caveats/next action in chat, start or steer any clear follow-up/blocker fix after reporting, then mark handled with fray_reconcile. Do not call fray_next in normal flow; Fray will queue the next native follow-up automatically.",
  ].join("\n");
}

export function nextCompletionReminderRun(runs: RunRecord[], scheduledRunIds: Set<string>): RunRecord | undefined {
  const run = completionQueueFromRuns(runs)[0];
  if (!run?.id || scheduledRunIds.has(run.id)) return undefined;
  return run;
}

function clearUndeliveredReminderSchedules(root: string) {
  const state = reminderState(root);
  const queuedIds = new Set(completionQueue(root).map((run) => run.id));
  for (const runId of Array.from(state.scheduledRunIds)) {
    if (queuedIds.has(runId) && !state.deliveredRunIds.has(runId)) state.scheduledRunIds.delete(runId);
  }
}

function queueCompletionReminder(pi: ExtensionAPI, root: string): boolean {
  const state = reminderState(root);
  const run = nextCompletionReminderRun(currentRuns(root), state.scheduledRunIds);
  if (!run?.id) return false;

  const message = formatCompletionQueueReminder(root);
  if (!message || parseCompletionReminderRunId(message) !== run.id) return false;

  state.scheduledRunIds.add(run.id);
  appendReminderState(pi, root, run.id, "scheduled");
  try {
    pi.sendUserMessage(message, { deliverAs: "followUp" });
  } catch {
    state.scheduledRunIds.delete(run.id);
    return false;
  }
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
  const unhandledCount = completionQueue(root).length;
  const lines = renderChildBoard(root, ctx, live, nowMs).filter((line) => line.trim().length > 0);
  setWidgetIfChanged(ctx, CHILD_WIDGET_KEY, lines.length ? lines : undefined, { placement: "aboveEditor" });

  const mode = cfg.autonomousMode ? theme.fg("thinkingHigh", "auto") : theme.fg("success", "on");
  const statusParts = [mode];
  if (live.length) statusParts.push(`${live.length} child${live.length === 1 ? "" : "ren"} running`);
  if (unhandledCount) statusParts.push(theme.fg("warning", `${unhandledCount} unhandled`));
  setStatusIfChanged(ctx, STATUS_KEY, `${theme.fg("dim", "fray:")} ${statusParts.join(" · ")}`);
}

function extractText(value: any): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("\n");
  if (typeof value === "object") {
    if (value.type === "text" && typeof value.text === "string") return value.text;
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    if (Array.isArray(value.content)) return extractText(value.content);
    if (value.message) return extractText(value.message);
  }
  return "";
}

function assistantMessageText(message: any): string {
  if (!message || message.role !== "assistant") return "";
  return extractText(message.content).trim();
}

function finalAssistantText(session: any): string {
  const messages = session?.messages || session?.agent?.state?.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "assistant") continue;
    return assistantMessageText(messages[i]);
  }
  return "";
}

function parseJsonlEntries(content: string): any[] {
  const entries: any[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Ignore torn/truncated JSONL lines; session files are append-only and may be read mid-write.
    }
  }
  return entries;
}

export function extractFinalAssistantTextFromSessionJsonl(content: string): string {
  const entries = parseJsonlEntries(content);
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    return assistantMessageText(entry.message);
  }
  return "";
}

// Final-output recovery for a resumed run: only the assistant output produced after the
// continuation start leaf belongs to this run; earlier assistant text is the source run's output.
export function extractFinalAssistantTextFromSessionJsonlAfter(content: string, afterLeafId?: string): string {
  if (!afterLeafId) return extractFinalAssistantTextFromSessionJsonl(content);
  const entries = parseJsonlEntries(content);
  const pivot = entries.findIndex((entry) => entry?.id === afterLeafId);
  const start = pivot >= 0 ? pivot + 1 : 0;
  for (let i = entries.length - 1; i >= start; i--) {
    const entry = entries[i];
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    return assistantMessageText(entry.message);
  }
  return "";
}

export function readSessionHeaderFromSessionJsonl(content: string): { type: "session"; id: string; cwd?: string; version?: number; parentSession?: string } | undefined {
  for (const entry of parseJsonlEntries(content)) {
    if (entry?.type === "session" && typeof entry.id === "string") return entry;
  }
  return undefined;
}

function resolveSessionFile(root: string, sessionFile?: string): string | undefined {
  if (!sessionFile) return undefined;
  if (path.isAbsolute(sessionFile)) return sessionFile;
  return path.join(root, sessionFile);
}

export function recoverFinalOutputFromSessionFile(root: string, sessionFile?: string, startLeafId?: string): { text: string; error?: string } {
  const file = resolveSessionFile(root, sessionFile);
  if (!file) return { text: "", error: "child session file was not recorded" };
  try {
    const content = fs.readFileSync(file, "utf8");
    return { text: startLeafId ? extractFinalAssistantTextFromSessionJsonlAfter(content, startLeafId) : extractFinalAssistantTextFromSessionJsonl(content) };
  } catch (err: any) {
    return { text: "", error: `could not read child session file ${sessionFile}: ${String(err?.message || err)}` };
  }
}

export function resolveRunFinalOutput(root: string, run: Pick<RunRecord, "sessionFile" | "startLeafId">, session?: any, liveOutput?: string): { text: string; source?: string; reason?: string } {
  const stateText = finalAssistantText(session);
  if (stateText) return { text: stateText, source: "live-state" };
  const eventText = String(liveOutput || "").trim();
  if (eventText) return { text: eventText, source: "live-event" };
  const recovered = recoverFinalOutputFromSessionFile(root, run.sessionFile, run.startLeafId);
  if (recovered.text) return { text: recovered.text, source: "session-file" };
  return { text: "", reason: recovered.error || "live capture and child session-file fallback were empty" };
}

function missingFinalOutputReason(reason?: string): string {
  return `no child final output could be captured or recovered${reason ? ` (${reason})` : ""}`;
}

export function classifySettledRunStatus(status: RunStatus, finalOutput: string, reason?: string): { status: RunStatus; incompleteReason?: string } {
  if (status === "completed" && !finalOutput.trim()) return { status: "incomplete", incompleteReason: missingFinalOutputReason(reason) };
  if (["failed", "aborted", "incomplete"].includes(status) && !finalOutput.trim()) return { status, incompleteReason: missingFinalOutputReason(reason) };
  return { status };
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
  if (name === "fray_thread_patch") {
    const replacements = Array.isArray(args?.replacements) ? args.replacements.length : 0;
    const appends = Array.isArray(args?.appendSections) ? args.appendSections.length : 0;
    return `${replacements} replacement${replacements === 1 ? "" : "s"}, ${appends} append${appends === 1 ? "" : "s"}`;
  }
  if (name === "fray_launch_external") return [args?.runner, args?.label].filter(Boolean).join(" ");
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

export function chooseModel(ctx: ExtensionContext, hint: ModelHint, explicit?: string, strictExplicit = true): Model<any> | undefined {
  const registry = ctx.modelRegistry;
  if (explicit) {
    const [provider, ...rest] = explicit.includes("/") ? explicit.split("/") : [ctx.model?.provider || "", explicit];
    const found = registry.find(provider, rest.join("/"));
    if (found) return found;
    if (strictExplicit) throw new Error(`requested fray model is not available: ${explicit}`);
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
  if (requested?.length) return Array.from(new Set([...requested, "fray_run_update", "fray_thread_patch"]));
  const base = write ?? ["implement", "custom"].includes(intent) ? DEFAULT_TOOLS : READ_ONLY_TOOLS;
  return Array.from(new Set([...base, "grep", "find", "ls", "fray_run_update", "fray_thread_patch"]));
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
  const thread = args.thread || BACKLOG_THREAD;
  const threadLine = `You are working for fray thread .fray/${thread}.md. Read it as authoritative context and keep it current as part of your task. Use fray_thread_patch for owning-thread updates; do not use generic write/edit/bash for canonical .fray thread/config/run files.`;
  return `You are a pi fray child agent. Run id: ${runId}.\n\n${threadLine}\n\nThread-doc updates are expected child work. Eagerly patch your owning thread when facts become durable: frontmatter status/last_update, Status, Decisions, Open questions, Steps/checklists, Next step, Child runs rows, and body synthesis. fray_thread_patch can update frontmatter and body in one atomic exact-replacement/append call. You may update only .fray/${thread}.md unless explicitly assigned otherwise; never edit unrelated threads, .fray/config.yml, or .fray/runs.jsonl.\n\nYour final assistant response is mandatory and remains the primary completion report the orchestrator will read through fray_next/fray_reconcile. Make it orchestration-ready: verdict/status, what you did or changed, changed paths/artifacts, verification commands and results, blockers/caveats/risks, and one concrete next action. Empty or missing final output is an incomplete handoff/bug, not normal success; keep working, recover evidence, or report a blocker rather than ending silently. Use .fray/${thread}.findings/${runId}.md only for long raw artifacts or bulky evidence that does not fit cleanly in the final response; do not make a sidecar the main handoff.\n\nYou have broad normal coding-agent permissions. Use read/write/edit/bash as needed for the assigned work. The standing restrictions are coordination restrictions: do not run destructive git commands such as git reset, git checkout --, git stash, branch switches, or worktree creation in the shared tree; do not recursively copy the repo; do not edit canonical .fray thread/config/run files with generic tools. Use fray_run_update for live status. Use fray_thread_patch for atomic exact-replacement/append updates to your owning thread doc. fray_reconcile remains orchestrator-owned: final result handling, chat reporting, and durable handled/ledger state are not delegated to children.\n\nFor substantive implementation, operate as a mini-orchestrator within this assigned task: plan briefly, implement, run local verification, self-review the diff, evaluate/integrate, and for landing work commit and push to main by default unless the task/repo specifies a PR flow or forbids pushing. If CI applies and credentials are available, wait for CI and fix in-scope failures. When a blocker/P0/known required fix is found, start or steer the fix immediately unless a human-owned decision blocks it; do not only describe the next action.

Sub-agents are instruments, not deciders. Surface default/security/product/brand/API/config decisions as questions unless the prompt says they are already decided. For any GitHub issue or PR task, use the gh CLI before proposing or landing work: run gh issue view for issues, inspect linked/open PRs with relevant gh pr list / gh pr view checks, and include the GH commands and results in the final report. After context is known, drive the outcome: fix, push, comment, close, or verify when safe instead of stopping at a diagnosis.\n\nEnd your final response with a ## Follow-ups section. Include concrete follow-ups, whether an independent review is needed, verification run, changed paths, and the single most important next step.\n\nTask:\n${args.task || args.prompt || ""}`;
}

function isProtectedFrayPath(root: string, absolutePath: string): boolean {
  const rel = path.relative(root, absolutePath).replace(/\\/g, "/");
  return /^\.fray\/(config\.yml|runs\.jsonl|[^/]+\.md)$/.test(rel);
}

function relOrAbs(root: string, absolutePath: string): string {
  const rel = path.relative(root, absolutePath).replace(/\\/g, "/");
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : absolutePath;
}

function recordedPath(root: string, value?: string): string | undefined {
  if (!value) return undefined;
  return path.isAbsolute(value) ? value : path.join(root, value);
}

function normalizeExternalRunner(value: unknown): ExternalRunner {
  if (value === "codex" || value === "claude" || value === "custom") return value;
  throw new Error("runner must be one of: codex, claude, custom");
}

function normalizeStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${name} must be an array of strings`);
  return value.map((entry, index) => {
    if (typeof entry !== "string") throw new Error(`${name}[${index}] must be a string`);
    return entry;
  });
}

function normalizeExternalEnv(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("env must be an object whose values are strings");
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`env key ${JSON.stringify(key)} is not a valid environment variable name`);
    if (typeof raw !== "string") throw new Error(`env.${key} must be a string`);
    out[key] = raw;
  }
  return out;
}

function normalizeTimeoutMs(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout < 1) throw new Error("timeoutMs must be a positive number of milliseconds when provided");
  return Math.floor(timeout);
}

function resolveLaunchCwd(baseCwd: string, value?: string): string {
  const cwd = value ? path.resolve(baseCwd, value) : baseCwd;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch (err: any) {
    throw new Error(`cwd does not exist: ${cwd} (${String(err?.message || err)})`);
  }
  if (!stat.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
  return cwd;
}

function ensureExternalFileAllowed(root: string, absolutePath: string, label: string) {
  if (isProtectedFrayPath(root, absolutePath)) throw new Error(`${label} cannot be a canonical .fray thread/config/run file; use a findings sidecar path instead`);
  ensureDir(path.dirname(absolutePath));
}

function defaultExternalPaths(root: string, cwd: string, thread: string, runId: string, finalOutputPath?: string) {
  const findingsDir = path.join(root, ".fray", `${thread}.findings`);
  ensureDir(findingsDir);
  const findingsAbs = path.join(findingsDir, `${runId}.md`);
  const logAbs = path.join(findingsDir, `${runId}.log`);
  const statusAbs = path.join(findingsDir, `${runId}${EXTERNAL_STATUS_SUFFIX}`);
  const finalAbs = finalOutputPath ? path.resolve(cwd, finalOutputPath) : path.join(findingsDir, `${runId}.final.md`);
  ensureExternalFileAllowed(root, finalAbs, "finalOutputPath");
  for (const [label, candidate] of [["findingsPath", findingsAbs], ["logPath", logAbs], ["externalStatusPath", statusAbs]] as const) ensureExternalFileAllowed(root, candidate, label);
  if (new Set([findingsAbs, logAbs, statusAbs, finalAbs]).size !== 4) throw new Error("external run output paths must be distinct");
  return {
    findingsAbs,
    logAbs,
    statusAbs,
    finalAbs,
    findingsPath: relOrAbs(root, findingsAbs),
    logPath: relOrAbs(root, logAbs),
    externalStatusPath: relOrAbs(root, statusAbs),
    finalOutputPath: relOrAbs(root, finalAbs),
  };
}

function buildExternalInvocation(params: LaunchExternalArgs, cwd: string, finalOutputPath: string): { runner: ExternalRunner; command: string; args: string[]; externalLogFallbackFinal: boolean } {
  const runner = normalizeExternalRunner(params.runner);
  const suppliedArgs = normalizeStringArray(params.args, "args");
  const prompt = typeof params.prompt === "string" ? params.prompt : "";
  const commandOverride = typeof params.command === "string" ? params.command.trim() : "";

  if (runner === "codex") {
    if (!suppliedArgs && !prompt.trim()) throw new Error("prompt is required for the default codex invocation");
    return {
      runner,
      command: commandOverride || "codex",
      args: suppliedArgs || ["exec", "--cd", cwd, "--color", "never", "--output-last-message", finalOutputPath, prompt],
      externalLogFallbackFinal: false,
    };
  }

  if (runner === "claude") {
    if (!suppliedArgs && !prompt.trim()) throw new Error("prompt is required for the default claude invocation");
    return {
      runner,
      command: commandOverride || "claude",
      args: suppliedArgs || ["--print", "--output-format", "text", prompt],
      externalLogFallbackFinal: !params.finalOutputPath,
    };
  }

  if (!commandOverride) throw new Error("command is required when runner is custom");
  return {
    runner,
    command: commandOverride,
    args: suppliedArgs || [],
    externalLogFallbackFinal: !params.finalOutputPath,
  };
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_/:=.,@%+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandLine(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(" ");
}

function readUtf8IfPresent(file?: string): { text: string; error?: string } {
  if (!file) return { text: "", error: "path was not recorded" };
  try {
    return { text: fs.readFileSync(file, "utf8") };
  } catch (err: any) {
    return { text: "", error: `${file}: ${String(err?.message || err)}` };
  }
}

function stripExternalLogHeader(text: string): string {
  return text.replace(/^# Fray external run [^\n]*\n(?:# [^\n]*\n)*\n/, "");
}

function readFileTail(file?: string, maxChars = EXTERNAL_LOG_TAIL_CHARS): { text: string; error?: string } {
  if (!file) return { text: "", error: "path was not recorded" };
  let fd: number | undefined;
  try {
    const stat = fs.statSync(file);
    const maxBytes = Math.max(1, maxChars * 4);
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(file, "r");
    fs.readSync(fd, buffer, 0, length, start);
    const text = buffer.toString("utf8");
    return { text: text.length > maxChars ? text.slice(-maxChars) : text };
  } catch (err: any) {
    return { text: "", error: `${file}: ${String(err?.message || err)}` };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function resolveExternalFinalOutput(root: string, run: RunRecord): { text: string; source?: string; reason?: string } {
  const finalAbs = recordedPath(root, run.finalOutputPath);
  const finalRead = readUtf8IfPresent(finalAbs);
  if (finalRead.text.trim()) return { text: finalRead.text, source: "final-output-file" };

  const logRead = readFileTail(recordedPath(root, run.logPath));
  const logText = stripExternalLogHeader(logRead.text);
  if (logText.trim()) {
    const reason = `external final output file was missing or empty${finalRead.error ? ` (${finalRead.error})` : ""}; using log tail fallback`;
    if (run.externalLogFallbackFinal) {
      if (finalAbs) {
        try {
          ensureExternalFileAllowed(root, finalAbs, "finalOutputPath");
          fs.writeFileSync(finalAbs, logText);
        } catch {
          // The log remains the durable fallback even if mirroring it into finalOutputPath fails.
        }
      }
      return { text: logText, source: "log" };
    }
    return { text: logText, source: "log-tail", reason };
  }

  const reasons = [finalRead.error ? `final output: ${finalRead.error}` : "final output file was empty", logRead.error ? `log: ${logRead.error}` : "log was empty"];
  return { text: "", reason: reasons.join("; ") };
}

function classifyExternalSettledRunStatus(status: RunStatus, resolution: { text: string; source?: string; reason?: string }): { status: RunStatus; incompleteReason?: string } {
  if (status === "completed") {
    if (!resolution.text.trim()) return { status: "incomplete", incompleteReason: missingFinalOutputReason(resolution.reason) };
    if (resolution.source === "log-tail") return { status: "incomplete", incompleteReason: resolution.reason || "external runner did not write its final output file; using log tail fallback" };
    return { status };
  }
  if (["failed", "aborted", "incomplete"].includes(status) && !resolution.text.trim()) return { status, incompleteReason: missingFinalOutputReason(resolution.reason) };
  if (resolution.source === "log-tail") return { status, incompleteReason: resolution.reason || "external runner did not write its final output file; using log tail fallback" };
  return { status };
}

function writeExternalStatusFile(root: string, run: RunRecord, extra: Record<string, unknown> = {}) {
  const statusAbs = recordedPath(root, run.externalStatusPath);
  if (!statusAbs) return;
  try {
    ensureExternalFileAllowed(root, statusAbs, "externalStatusPath");
    fs.writeFileSync(statusAbs, `${JSON.stringify({
      id: run.id,
      thread: run.thread,
      label: run.label,
      runner: run.externalRunner,
      status: run.status,
      pid: run.pid,
      command: run.command,
      args: run.args,
      cwd: run.cwd,
      logPath: run.logPath,
      finalOutputPath: run.finalOutputPath,
      findingsPath: run.findingsPath,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      completedAt: run.completedAt,
      exitCode: run.exitCode,
      exitSignal: run.exitSignal,
      finalOutputSource: run.finalOutputSource,
      incompleteReason: run.incompleteReason,
      error: run.error,
      ...extra,
    }, null, 2)}\n`);
  } catch {
    // Status files are recovery aids; the JSONL ledger remains authoritative.
  }
}

function readExternalStatusFile(root: string, run: RunRecord): Record<string, any> | undefined {
  const statusAbs = recordedPath(root, run.externalStatusPath);
  if (!statusAbs) return undefined;
  try {
    return JSON.parse(fs.readFileSync(statusAbs, "utf8"));
  } catch {
    return undefined;
  }
}

function isProcessRunning(pid?: number): boolean {
  if (!Number.isInteger(pid) || !pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

function signalExternalProcess(pid: number, signal: NodeJS.Signals | number = "SIGTERM") {
  try {
    if (process.platform !== "win32") process.kill(-pid, signal);
    else process.kill(pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* process may already be gone */ }
  }
}

function settleExternalRun(pi: ExtensionAPI, root: string, run: RunRecord, status: RunStatus, details: { exitCode?: number | null; exitSignal?: string | null; error?: string; recovered?: boolean } = {}): RunRecord | undefined {
  if (!run.external || !run.id) return undefined;
  if (settlingExternalRunIds.has(run.id)) return readRuns(root).find((candidate) => candidate.id === run.id);
  const current = readRuns(root).find((candidate) => candidate.id === run.id) || run;
  if (SETTLED_RUN_STATUSES.has(current.status || "")) return current;

  settlingExternalRunIds.add(run.id);
  try {
    const completedAt = new Date().toISOString();
    const resolution = resolveExternalFinalOutput(root, current);
    const classification = classifyExternalSettledRunStatus(status, resolution);
    const exitCode = details.exitCode !== undefined ? details.exitCode : current.exitCode;
    const exitSignal = details.exitSignal !== undefined ? details.exitSignal : current.exitSignal;
    const error = details.error || classification.incompleteReason;
    const settled: RunRecord = {
      ...current,
      status: classification.status,
      updatedAt: completedAt,
      completedAt,
      finalOutput: resolution.text || undefined,
      finalOutputSource: resolution.source,
      incompleteReason: classification.incompleteReason,
      error,
      exitCode,
      exitSignal,
      reconciled: false,
    };
    settled.findingsPath = writeRunFindings(root, settled, resolution.text);
    writeExternalStatusFile(root, settled, { recovered: !!details.recovered });
    appendRunEvent(root, {
      id: settled.id,
      external: true,
      externalRunner: settled.externalRunner,
      status: settled.status,
      previousStatus: current.status !== settled.status ? current.status : undefined,
      updatedAt: settled.updatedAt,
      completedAt: settled.completedAt,
      findingsPath: settled.findingsPath,
      finalOutput: resolution.text || undefined,
      finalOutputSource: resolution.source,
      incompleteReason: settled.incompleteReason,
      error: settled.error,
      exitCode: settled.exitCode,
      exitSignal: settled.exitSignal,
      reconciled: false,
      recoveredExternal: !!details.recovered,
    });
    upsertThreadRunCard(root, settled);
    syncWidgetTimer(lastCtx);
    updateWidget(lastCtx);
    if (lastCtx?.hasUI) lastCtx.ui.notify(`Fray external child ${settled.status}: ${settled.id}`, settled.status === "completed" ? "info" : "warning");
    queueCompletionReminder(pi, root);
    return settled;
  } finally {
    settlingExternalRunIds.delete(run.id);
  }
}

function recoverExternalRuns(pi: ExtensionAPI, root: string): RunRecord[] {
  const recovered: RunRecord[] = [];
  for (const run of readRuns(root).filter((candidate) => candidate.external && LIVE_RUN_STATUSES.has(candidate.status || ""))) {
    if (settlingExternalRunIds.has(run.id)) continue;
    const statusFile = readExternalStatusFile(root, run);
    const statusFromFile = String(statusFile?.status || "");
    if (SETTLED_RUN_STATUSES.has(statusFromFile)) {
      const settled = settleExternalRun(pi, root, { ...run, exitCode: statusFile?.exitCode, exitSignal: statusFile?.exitSignal }, statusFromFile as RunStatus, { exitCode: statusFile?.exitCode, exitSignal: statusFile?.exitSignal, error: statusFile?.error, recovered: true });
      if (settled) recovered.push(settled);
      continue;
    }

    const resolution = resolveExternalFinalOutput(root, run);
    if (resolution.source === "final-output-file" && resolution.text.trim()) {
      const settled = settleExternalRun(pi, root, run, "completed", { recovered: true });
      if (settled) recovered.push(settled);
      continue;
    }

    if (isProcessRunning(run.pid)) continue;

    const settled = settleExternalRun(pi, root, run, "completed", {
      error: run.pid ? "external process is no longer running; exit code unavailable after recovery" : "external process pid was not recorded; recovered from output files",
      recovered: true,
    });
    if (settled) recovered.push(settled);
  }
  return recovered;
}

async function launchExternalRun(pi: ExtensionAPI, ctx: ExtensionContext, params: LaunchExternalArgs) {
  const root = frayRoot(ctx.cwd);
  const cfg = loadConfig(root);
  if (!cfg.enabled) throw new Error("fray is disabled in .fray/config.yml");
  const liveCount = liveChildRuns(root).length;
  if (liveCount >= cfg.maxChildren) throw new Error(`fray has ${liveCount} live children; max_children is ${cfg.maxChildren}`);
  if (!params?.label || typeof params.label !== "string") throw new Error("label is required");
  const thread = effectiveThread(root, params.thread);
  const cwd = resolveLaunchCwd(ctx.cwd, params.cwd);
  const runId = `fray-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${randomUUID().slice(0, 8)}`;
  const paths = defaultExternalPaths(root, cwd, thread, runId, params.finalOutputPath);
  const invocation = buildExternalInvocation(params, cwd, recordedPath(root, paths.finalOutputPath) || paths.finalOutputPath);
  const env = normalizeExternalEnv(params.env);
  const timeoutMs = normalizeTimeoutMs(params.timeoutMs);
  const now = new Date().toISOString();
  const record: RunRecord = {
    id: runId,
    thread,
    label: params.label,
    intent: "custom",
    status: "starting",
    cwd,
    startedAt: now,
    updatedAt: now,
    findingsPath: paths.findingsPath,
    reconciled: false,
    external: true,
    externalRunner: invocation.runner,
    externalStatusPath: paths.externalStatusPath,
    externalLogFallbackFinal: invocation.externalLogFallbackFinal,
    command: invocation.command,
    args: invocation.args,
    logPath: paths.logPath,
    finalOutputPath: paths.finalOutputPath,
    timeoutMs,
  };
  appendRunEvent(root, record);
  upsertThreadRunCard(root, record);
  writeExternalStatusFile(root, record);

  let logFd: number | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    logFd = fs.openSync(paths.logAbs, "a");
    fs.writeSync(logFd, `# Fray external run ${runId}\n# ${now}\n# cwd: ${cwd}\n# command: ${commandLine(invocation.command, invocation.args)}\n\n`);
    child = spawn(invocation.command, invocation.args, {
      cwd,
      detached: true,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", logFd, logFd],
    });
    child.once("error", (err: any) => {
      settleExternalRun(pi, root, { ...record, pid: child?.pid, status: "running" }, "failed", { error: String(err?.message || err) });
    });
    if (!child.pid) throw new Error(`external runner did not start: ${invocation.command}`);
  } catch (err: any) {
    if (logFd !== undefined) try { fs.closeSync(logFd); } catch { /* ignore */ }
    const failed: RunRecord = { ...record, status: "failed", updatedAt: new Date().toISOString(), completedAt: new Date().toISOString(), error: String(err?.message || err), reconciled: false };
    failed.findingsPath = writeRunFindings(root, failed, "");
    appendRunEvent(root, { id: runId, status: "failed", updatedAt: failed.updatedAt, completedAt: failed.completedAt, findingsPath: failed.findingsPath, error: failed.error, reconciled: false });
    upsertThreadRunCard(root, failed);
    writeExternalStatusFile(root, failed);
    queueCompletionReminder(pi, root);
    throw err;
  }

  if (logFd !== undefined) try { fs.closeSync(logFd); } catch { /* ignore */ }
  const running: RunRecord = { ...record, status: "running", pid: child.pid, updatedAt: new Date().toISOString() };
  appendRunEvent(root, { id: runId, status: "running", updatedAt: running.updatedAt, pid: running.pid });
  upsertThreadRunCard(root, running);
  writeExternalStatusFile(root, running);

  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs) {
    timeout = setTimeout(() => {
      timedOut = true;
      appendRunEvent(root, { id: runId, status: "running", updatedAt: new Date().toISOString(), progress: `external runner timed out after ${timeoutMs}ms; sent SIGTERM` });
      writeExternalStatusFile(root, { ...running, updatedAt: new Date().toISOString(), error: `external runner timed out after ${timeoutMs}ms` }, { timeoutAt: new Date().toISOString() });
      signalExternalProcess(child!.pid!, "SIGTERM");
      const killTimer = setTimeout(() => signalExternalProcess(child!.pid!, "SIGKILL"), 5000);
      killTimer.unref?.();
    }, timeoutMs);
    timeout.unref?.();
  }

  child.once("exit", (code, signal) => {
    if (timeout) clearTimeout(timeout);
    const baseStatus: RunStatus = timedOut ? "aborted" : code === 0 ? "completed" : signal ? "aborted" : "failed";
    const error = timedOut
      ? `external runner timed out after ${timeoutMs}ms`
      : code && code !== 0
        ? `external runner exited with code ${code}`
        : signal
          ? `external runner exited from signal ${signal}`
          : undefined;
    settleExternalRun(pi, root, running, baseStatus, { exitCode: code, exitSignal: signal, error });
  });
  child.unref();
  syncWidgetTimer(ctx);
  updateWidget(ctx);
  if (ctx.hasUI) ctx.ui.notify(`Fray launched external ${runId}: ${params.label}`, "info");

  return {
    runId,
    thread,
    runner: invocation.runner,
    pid: running.pid,
    status: "running",
    command: invocation.command,
    args: invocation.args,
    cwd,
    logPath: paths.logPath,
    finalOutputPath: paths.finalOutputPath,
    findingsPath: paths.findingsPath,
  };
}

function childToolDefinitions(root: string, cwd: string, enabled: string[], runUpdateTool: ToolDefinition<any>, threadPatchTool: ToolDefinition<any>): ToolDefinition<any>[] {
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
        if (isProtectedFrayPath(root, file)) throw new Error("canonical .fray thread/config/run files are protected from generic writes; write a findings sidecar, use fray_run_update for live progress, or use fray_thread_patch for your owning thread doc");
        await fs.promises.writeFile(file, content);
      },
    },
  }));
  if (want.has("edit")) out.push(createEditToolDefinition(cwd, {
    operations: {
      async readFile(file) { return fs.promises.readFile(file); },
      async access(file) { await fs.promises.access(file, fs.constants.R_OK | fs.constants.W_OK); },
      async writeFile(file, content) {
        if (isProtectedFrayPath(root, file)) throw new Error("canonical .fray thread/config/run files are protected from generic writes; write a findings sidecar, use fray_run_update for live progress, or use fray_thread_patch for your owning thread doc");
        await fs.promises.writeFile(file, content);
      },
    },
  }));
  out.push(runUpdateTool, threadPatchTool);
  return out;
}

function makeRunUpdateTool(root: string, runId: string, thread?: string): ToolDefinition<any> {
  return {
    name: "fray_run_update",
    label: "Fray Run Update",
    description: "Update transient live fray child-run progress; use fray_thread_patch for durable owning-thread doc updates.",
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

function makeThreadPatchTool(root: string, runId: string, thread?: string): ToolDefinition<any> {
  return {
    name: "fray_thread_patch",
    label: "Fray Thread Patch",
    description: "Atomically patch this child run's owning .fray/<thread>.md only, using multiple exact replacements and optional appended sections.",
    parameters: Type.Object({
      replacements: Type.Optional(Type.Array(Type.Object({
        oldText: Type.String({ description: "Exact text to replace. It must match exactly once in the current owning thread doc." }),
        newText: Type.String({ description: "Replacement text." }),
      }), { description: "Zero or more exact replacements, all matched against the original thread doc before any changes are written." })),
      appendSections: Type.Optional(Type.Array(Type.Object({
        heading: Type.String({ description: "Level-2 Markdown heading text to append, without leading ##." }),
        content: Type.String({ description: "Section body to append under the heading." }),
      }), { description: "Optional level-2 sections appended to the end of the owning thread doc in the same atomic patch." })),
      expectedSha256: Type.Optional(Type.String({ description: "Optional SHA-256 of the thread doc content read earlier; rejects if the file changed before patching." })),
    }),
    renderCall(args: any, theme: any, context: any) {
      return compactCall("fray_thread_patch", args, theme, context);
    },
    renderResult: compactRender("fray_thread_patch"),
    async execute(_toolCallId: string, params: any) {
      const owningThread = thread || BACKLOG_THREAD;
      if (owningThread === BACKLOG_THREAD) ensureBacklogThread(root);
      else assertThread(root, owningThread);
      const file = threadPath(root, owningThread);
      const result = await patchThreadFile(file, {
        replacements: params.replacements || [],
        appendSections: params.appendSections || [],
        expectedSha256: params.expectedSha256,
      }, { lockId: runId });
      const summary = `patched .fray/${owningThread}.md (${result.replacementCount} replacement${result.replacementCount === 1 ? "" : "s"}, ${result.appendedSectionCount} appended section${result.appendedSectionCount === 1 ? "" : "s"})`;
      const now = new Date().toISOString();
      const run = liveRuns.get(runId);
      if (run) {
        run.progress.push(`thread-patch: ${summary}`);
        run.updatedAt = now;
        appendRunEvent(root, { id: runId, status: "running", updatedAt: now, progress: summary });
      } else {
        appendRunEvent(root, { id: runId, updatedAt: now, progress: summary, warning: "thread patch received but no live child handle is registered" });
      }
      return { content: [{ type: "text", text: `${summary}\nsha256: ${result.sha256Before} -> ${result.sha256After}` }], details: { thread: owningThread, path: path.relative(root, file), ...result } };
    },
  };
}

function wireLiveRunSession(live: LiveRun, session: any) {
  live.unsubscribe = session.subscribe((event: any) => {
    live.updatedAt = new Date().toISOString();
    if (event.type === "message_start" && event.message?.role === "assistant") live.currentAssistantText = "";
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") live.currentAssistantText = `${live.currentAssistantText || ""}${event.assistantMessageEvent.delta || ""}`;
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const endedText = assistantMessageText(event.message) || String(live.currentAssistantText || "").trim();
      if (endedText) {
        live.output = endedText;
        live.finalOutputSource = "live-event";
      }
      live.currentAssistantText = undefined;
    }
  });
}

export function buildResumeTask(sourceRunId: string, sessionFile: string | undefined, message: string): string {
  return [
    `Continuation of Fray source run ${sourceRunId}${sessionFile ? ` (recorded session ${sessionFile})` : ""}.`,
    "You are resuming that child's exact recorded session with full prior context; continue the same work rather than restarting from scratch.",
    "Re-read your owning fray thread for any changes since the source run paused, then address the steering message below.",
    "Your final assistant response remains the mandatory orchestration-ready handoff: verdict/status, what you changed, changed paths/artifacts, verification commands and results, caveats/risks, and one concrete next action.",
    "",
    "## Steering message",
    "",
    message,
  ].join("\n");
}

// Find a live continuation descended from a (possibly stale) source run, if one exists.
// Repeated fray_steer on an already-resumed stale source must steer the existing live
// continuation, never open a second continuation writing to the same recorded session file.
// `liveRecords` are the in-memory live runs (only running/starting ones are steerable);
// `ancestry` supplies sourceRunId links so deeper resume chains (A→B→C) still resolve to C.
export function findLiveContinuationId(
  liveRecords: Array<Pick<RunRecord, "id" | "status" | "sourceRunId" | "startedAt">>,
  ancestry: Array<Pick<RunRecord, "id" | "sourceRunId">>,
  sourceRunId: string,
): string | undefined {
  const parent = new Map<string, string>();
  for (const r of ancestry) if (r.sourceRunId) parent.set(r.id, r.sourceRunId);
  for (const r of liveRecords) if (r.sourceRunId) parent.set(r.id, r.sourceRunId);
  let best: { id: string; startedAt: string } | undefined;
  for (const live of liveRecords) {
    if (live.status !== "running" && live.status !== "starting") continue;
    let cur: string | undefined = live.id;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const next = parent.get(cur);
      if (next === sourceRunId) {
        const startedAt = live.startedAt || "";
        if (!best || startedAt >= best.startedAt) best = { id: live.id, startedAt };
        break;
      }
      cur = next;
    }
  }
  return best?.id;
}

// Reload-safe fray_steer fallback: when no live SDK handle exists for runId (e.g. after a parent
// reload or session replacement) but the child's session file was recorded, resume that exact
// session as a fresh continuation run instead of silently relaunching or failing.
async function resumeRun(pi: ExtensionAPI, ctx: ExtensionContext, sourceRunId: string, message: string) {
  const root = frayRoot(ctx.cwd);
  const cfg = loadConfig(root);
  if (!cfg.enabled) throw new Error("fray is disabled in .fray/config.yml");

  const known = readRuns(root).find((run) => run.id === sourceRunId);
  if (!known) throw new Error(`unknown fray run ${sourceRunId}; no live child handle or ledger record exists`);
  if (known.external) throw new Error(`fray run ${sourceRunId} is an external runner result; resume is only supported for Pi child sessions, so relaunch the external work instead.`);
  if (!known.sessionFile) throw new Error(`fray run ${sourceRunId} has no recorded sessionFile; cannot resume exactly, so relaunch the work instead.`);

  if (resumingSourceRunIds.has(sourceRunId)) throw new Error(`fray run ${sourceRunId} is already being resumed; wait for the in-flight resume to register its live handle before steering again.`);

  const sessionFileAbs = resolveSessionFile(root, known.sessionFile);
  if (!sessionFileAbs || !fs.existsSync(sessionFileAbs)) throw new Error(`fray run ${sourceRunId} session file ${known.sessionFile} is missing on disk; cannot resume exactly, so relaunch the work instead.`);
  let header: ReturnType<typeof readSessionHeaderFromSessionJsonl>;
  try {
    header = readSessionHeaderFromSessionJsonl(fs.readFileSync(sessionFileAbs, "utf8"));
  } catch (err: any) {
    throw new Error(`could not read session file ${known.sessionFile} for resume of ${sourceRunId}: ${String(err?.message || err)}`);
  }
  if (!header?.id) throw new Error(`session file ${known.sessionFile} has no valid Pi session header; cannot resume exactly, so relaunch the work instead.`);
  if (known.sessionId && header.id !== known.sessionId) throw new Error(`session file ${known.sessionFile} header id ${header.id} does not match recorded session ${known.sessionId} for ${sourceRunId}; refusing to resume a mismatched session.`);

  if (Date.now() < cooldownUntil) throw new Error(`fray dispatch is cooling down after provider rate-limit until ${new Date(cooldownUntil).toISOString()}`);
  const liveCount = liveChildRuns(root).length;
  if (liveCount >= cfg.maxChildren) throw new Error(`fray has ${liveCount} live children; max_children is ${cfg.maxChildren}`);

  const intent: Intent = known.intent || "custom";
  const resumeDepth = (known.resumeDepth || 0) + 1;
  const runId = `fray-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${randomUUID().slice(0, 8)}`;
  resumingSourceRunIds.add(sourceRunId);
  pendingDispatchRunIds.add(runId);

  try {
    const cwd = header.cwd && fs.existsSync(header.cwd) ? header.cwd : (known.cwd || ctx.cwd);
    const sessionManager = SessionManager.open(sessionFileAbs, undefined, cwd);
    const startLeafId = sessionManager.getLeafId() || undefined;
    const model = chooseModel(ctx, "current", known.model, false);
    const thinking = defaultThinking(intent, known.thinking);
    const tools = defaultTools(intent, true);
    const thread = known.thread || BACKLOG_THREAD;
    const now = new Date().toISOString();
    const record: RunRecord = {
      id: runId,
      thread,
      label: known.label || intent,
      intent,
      status: "starting",
      model: model ? `${model.provider}/${model.id}` : undefined,
      thinking,
      cwd,
      startedAt: now,
      updatedAt: now,
      reconciled: false,
      sessionId: sessionManager.getSessionId(),
      sessionFile: known.sessionFile,
      sourceRunId,
      resumeDepth,
      startLeafId,
    };
    appendRunEvent(root, record);
    upsertThreadRunCard(root, record);

    const loader = new DefaultResourceLoader({
      cwd: record.cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      appendSystemPrompt: ["You are a background child agent managed by pi-fray, resuming a recorded session. Keep final output concise and factual."],
    });
    await loader.reload();

    const runUpdateTool = makeRunUpdateTool(root, runId, thread);
    const threadPatchTool = makeThreadPatchTool(root, runId, thread);
    const { session } = await createAgentSession({
      cwd: record.cwd,
      authStorage: ctx.modelRegistry.authStorage,
      modelRegistry: ctx.modelRegistry,
      model,
      thinkingLevel: thinking,
      noTools: "builtin",
      tools,
      customTools: childToolDefinitions(root, record.cwd, tools, runUpdateTool, threadPatchTool),
      resourceLoader: loader,
      sessionManager,
    });

    const live: LiveRun = { ...record, status: "running", session, output: "", progress: [] };
    wireLiveRunSession(live, session);
    liveRuns.set(runId, live);
    pendingDispatchRunIds.delete(runId);
    appendRunEvent(root, { id: runId, status: "running", updatedAt: live.updatedAt, sessionId: record.sessionId, sessionFile: record.sessionFile, sourceRunId, resumeDepth, startLeafId });
    upsertThreadRunCard(root, live);
    ensureWidgetTimer(ctx);
    updateWidget(ctx);
    if (ctx.hasUI) ctx.ui.notify(`Fray resumed ${sourceRunId} as ${runId}: ${record.label}`, "info");

    const prompt = buildResumeTask(sourceRunId, known.sessionFile, message);
    void session.prompt(prompt).then(() => {
      completeRun(pi, root, runId, "completed");
    }).catch((err: any) => {
      completeRun(pi, root, runId, "failed", String(err?.message || err));
    });

    appendRunEvent(root, { id: sourceRunId, updatedAt: now, resumedAs: runId, resumeDepth });
    return {
      content: [{ type: "text", text: `resumed ${sourceRunId} as ${runId} (no live handle was registered; continued from recorded session ${known.sessionFile})` }],
      details: { mode: "resumed", runId, sourceRunId, resumeDepth, startLeafId, sessionId: record.sessionId, sessionFile: record.sessionFile },
    };
  } catch (err: any) {
    pendingDispatchRunIds.delete(runId);
    appendRunEvent(root, { id: runId, status: "failed", updatedAt: new Date().toISOString(), completedAt: new Date().toISOString(), error: `resume of ${sourceRunId} failed: ${String(err?.message || err)}`, sourceRunId, resumeDepth, reconciled: false });
    throw err;
  } finally {
    resumingSourceRunIds.delete(sourceRunId);
  }
}

async function dispatchChild(pi: ExtensionAPI, ctx: ExtensionContext, args: DispatchArgs) {
  const root = frayRoot(ctx.cwd);
  const cfg = loadConfig(root);
  if (!cfg.enabled) throw new Error("fray is disabled in .fray/config.yml");
  if (Date.now() < cooldownUntil) throw new Error(`fray dispatch is cooling down after provider rate-limit until ${new Date(cooldownUntil).toISOString()}`);
  const liveCount = liveChildRuns(root).length;
  if (liveCount >= cfg.maxChildren) throw new Error(`fray has ${liveCount} live children; max_children is ${cfg.maxChildren}`);
  const thread = effectiveThread(root, args.thread);
  const childArgs = { ...args, thread };

  const runId = `fray-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${randomUUID().slice(0, 8)}`;
  pendingDispatchRunIds.add(runId);
  const intent: Intent = args.intent || "custom";
  const model = chooseModel(ctx, args.modelHint || (intent === "harvest" ? "cheap" : ["implement", "review", "design"].includes(intent) ? "strong" : "balanced"), args.model);
  const thinking = defaultThinking(intent, args.thinkingHint);
  const tools = defaultTools(intent, args.capabilities?.write, args.tools);
  const cwd = args.cwd || ctx.cwd;
  const childSessionManager = SessionManager.create(cwd, undefined, { id: runId });
  const now = new Date().toISOString();
  const record: RunRecord = { id: runId, thread, label: args.label || intent, intent, status: "starting", model: model ? `${model.provider}/${model.id}` : undefined, thinking, cwd, startedAt: now, updatedAt: now, reconciled: false, sessionId: childSessionManager.getSessionId(), sessionFile: childSessionManager.getSessionFile() };
  appendRunEvent(root, record);
  upsertThreadRunCard(root, record);

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

  const runUpdateTool = makeRunUpdateTool(root, runId, thread);
  const threadPatchTool = makeThreadPatchTool(root, runId, thread);
  const { session } = await createAgentSession({
    cwd: record.cwd,
    authStorage: ctx.modelRegistry.authStorage,
    modelRegistry: ctx.modelRegistry,
    model,
    thinkingLevel: thinking,
    noTools: "builtin",
    tools,
    customTools: childToolDefinitions(root, record.cwd, tools, runUpdateTool, threadPatchTool),
    resourceLoader: loader,
    sessionManager: childSessionManager,
  });

  const live: LiveRun = { ...record, status: "running", session, output: "", progress: [] };
  wireLiveRunSession(live, session);
  liveRuns.set(runId, live);
  pendingDispatchRunIds.delete(runId);
  appendRunEvent(root, { id: runId, status: "running", updatedAt: live.updatedAt, sessionId: record.sessionId, sessionFile: record.sessionFile });
  upsertThreadRunCard(root, live);
  ensureWidgetTimer(ctx);
  updateWidget(ctx);
  if (ctx.hasUI) ctx.ui.notify(`Fray dispatched ${runId}: ${record.label}`, "info");

  const prompt = childContract(childArgs, runId);
  void session.prompt(prompt).then(() => {
    completeRun(pi, root, runId, "completed");
  }).catch((err: any) => {
    completeRun(pi, root, runId, "failed", String(err?.message || err));
  });

  return { runId, thread, status: "running", model: record.model, thinking, tools, sessionId: record.sessionId, sessionFile: record.sessionFile };
  } catch (err: any) {
    pendingDispatchRunIds.delete(runId);
    appendRunEvent(root, { id: runId, status: "failed", updatedAt: new Date().toISOString(), completedAt: new Date().toISOString(), error: String(err?.message || err), reconciled: false, sessionId: record.sessionId, sessionFile: record.sessionFile });
    try { childSessionManager.getSessionFile() && fs.rmSync(childSessionManager.getSessionFile()!, { force: true }); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}

function runProgressLines(run: { progress?: string | string[] }): string[] {
  const progress = (run as any).progress;
  if (Array.isArray(progress)) return progress.length ? progress : ["none recorded"];
  return progress ? [String(progress)] : ["none recorded"];
}

function writeRunFindings(root: string, run: Omit<RunRecord, "progress"> & { progress?: string | string[] }, finalOutput: string): string {
  const dir = path.join(root, ".fray", `${run.thread || BACKLOG_THREAD}.findings`);
  ensureDir(dir);
  const findingsPath = path.join(dir, `${run.id}.md`);
  const relFindings = path.relative(root, findingsPath);
  const body = [
    `# ${run.label}`,
    "",
    `Run: \`${run.id}\``,
    `Status: ${run.status}`,
    `Intent: ${run.intent}`,
    run.model ? `Model: ${run.model}` : "",
    run.thinking ? `Thinking: ${run.thinking}` : "",
    run.external ? `External runner: ${run.externalRunner || "custom"}` : "",
    run.pid ? `PID: ${run.pid}` : "",
    run.command ? `Command: ${commandLine(run.command, run.args || [])}` : "",
    run.exitCode !== undefined ? `Exit code: ${run.exitCode === null ? "null" : run.exitCode}` : "",
    run.exitSignal ? `Exit signal: ${run.exitSignal}` : "",
    run.logPath ? `Log: ${run.logPath}` : "",
    run.finalOutputPath ? `Final output file: ${run.finalOutputPath}` : "",
    run.finalOutputSource ? `Final output source: ${run.finalOutputSource}` : "",
    run.incompleteReason ? `Incomplete reason: ${run.incompleteReason}` : "",
    run.error ? `Error: ${run.error}` : "",
    "",
    "## Progress",
    "",
    ...runProgressLines(run).map((p) => `- ${p}`),
    "",
    finalOutput ? "## Captured child final output" : "## Incomplete handoff",
    "",
    finalOutput || "No child final output could be captured or recovered. Treat this run as incomplete/needs-retry; use progress, sidecar metadata, and the child session file only as fallback evidence.",
    "",
  ].filter(Boolean).join("\n");
  fs.writeFileSync(findingsPath, body);
  return relFindings;
}

function finishLiveRun(pi: ExtensionAPI, root: string, run: LiveRun, status: RunStatus, error?: string, options: { notify?: boolean; queueReminder?: boolean } = {}) {
  const completedAt = new Date().toISOString();
  const resolution = resolveRunFinalOutput(root, run, run.session, run.output || run.currentAssistantText);
  const classification = classifySettledRunStatus(status, resolution.text, resolution.reason);
  run.status = classification.status;
  run.completedAt = completedAt;
  run.updatedAt = completedAt;
  run.output = resolution.text;
  run.finalOutput = resolution.text;
  run.finalOutputSource = resolution.source;
  run.incompleteReason = classification.incompleteReason;
  run.error = error || classification.incompleteReason;
  run.unsubscribe?.();
  run.findingsPath = writeRunFindings(root, run, resolution.text);
  appendRunEvent(root, {
    id: run.id,
    status: run.status,
    previousStatus: run.status !== status ? status : undefined,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    findingsPath: run.findingsPath,
    finalOutput: resolution.text || undefined,
    finalOutputSource: resolution.source,
    incompleteReason: run.incompleteReason,
    error: run.error,
    reconciled: false,
    sessionId: run.sessionId,
    sessionFile: run.sessionFile,
  });
  upsertThreadRunCard(root, run);
  try { run.session.dispose?.(); } catch { /* ignore cleanup failure */ }
  liveRuns.delete(run.id);
  syncWidgetTimer(lastCtx);
  updateWidget(lastCtx);
  if (options.notify !== false && lastCtx?.hasUI) lastCtx.ui.notify(`Fray child ${run.status}: ${run.id}`, run.status === "completed" ? "info" : "warning");
  if (options.queueReminder !== false) queueCompletionReminder(pi, root);
}

function completeRun(pi: ExtensionAPI, root: string, runId: string, status: RunStatus, error?: string) {
  const run = liveRuns.get(runId);
  if (!run) return;
  finishLiveRun(pi, root, run, status, error);
}

function markHandled(root: string, runId: string): boolean {
  const current = readRuns(root).find((run) => run.id === runId);
  if (current?.reconciled) return false;
  const now = new Date().toISOString();
  appendRunEvent(root, { id: runId, updatedAt: now, reconciled: true, reconciledAt: now });
  if (current) upsertThreadRunCard(root, { ...current, reconciled: true });
  return true;
}

function requireLiveRunForAction(root: string, runId: string, action: string): LiveRun {
  const run = liveRuns.get(runId);
  if (run) return run;
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
    const root = frayRoot(ctx.cwd);
    recoverExternalRuns(pi, root);
    markLostLiveHandles(root);
    repairCompletedRunsMissingFinalOutput(root);
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
      const report = dispatches.length ? "\nReport each dispatch in chat with purpose and run ID." : "";
      return { content: [{ type: "text", text: `created .fray/${params.slug}.md${suffix}${report}` }], details: { path: path.relative(root, file), dispatches } };
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
      return { content: [{ type: "text", text: `dispatched ${result.runId}${result.thread ? ` for .fray/${result.thread}.md` : ""} (${result.model || "default model"}, ${result.thinking})\nReport this dispatch in chat with purpose and run ID.` }], details: result };
    },
  });

  pi.registerTool({
    name: "fray_launch_external",
    label: "Fray Launch External",
    description: "Launch a detached external/ad hoc agent process, capture its log/final output, and surface completion through the Fray result queue.",
    parameters: Type.Object({
      thread: Type.Optional(Type.String({ description: "Optional fray thread slug; defaults to backlog." })),
      label: Type.String({ description: "Short purpose label for this external run." }),
      runner: Type.String({ enum: ["codex", "claude", "custom"], description: "Built-in runner defaults or custom argv mode." }),
      prompt: Type.Optional(Type.String({ description: "Prompt passed to the default codex/claude invocation." })),
      command: Type.Optional(Type.String({ description: "Command/binary override. Required for runner=custom." })),
      args: Type.Optional(Type.Array(Type.String(), { description: "Explicit argv. When provided, runner defaults do not add prompt/final-output flags." })),
      cwd: Type.Optional(Type.String({ description: "Working directory for the external process; defaults to the current Pi cwd." })),
      timeoutMs: Type.Optional(Type.Number({ description: "Optional timeout in milliseconds; sends SIGTERM then best-effort SIGKILL." })),
      env: Type.Optional({ type: "object", additionalProperties: { type: "string" }, description: "Extra environment variables for the external process." }),
      finalOutputPath: Type.Optional(Type.String({ description: "Optional path where the runner writes its final answer; defaults under the thread findings directory." })),
    }),
    renderCall(args: any, theme: any, context: any) {
      return compactCall("fray_launch_external", args, theme, context);
    },
    renderResult: compactRender("fray_launch_external"),
    async execute(_id, params: any, _signal, _update, ctx) {
      remember(ctx);
      const result = await launchExternalRun(pi, ctx, params);
      return { content: [{ type: "text", text: `launched external ${result.runId}${result.thread ? ` for .fray/${result.thread}.md` : ""} (pid ${result.pid})\nlog: ${result.logPath}\nfinal: ${result.finalOutputPath}\nfindings: ${result.findingsPath}\nReport this launch in chat with purpose and run ID.` }], details: result };
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
      const liveCount = liveChildRuns(root).length;
      if (liveCount + agents.length > cfg.maxChildren) throw new Error(`fray has ${liveCount} live children; dispatching ${agents.length} would exceed max_children ${cfg.maxChildren}`);
      for (const agent of agents) assertThread(root, agent.thread || params.thread);
      const dispatches = [];
      for (const agent of agents) dispatches.push(await dispatchChild(pi, ctx, { ...agent, thread: agent.thread || params.thread }));
      return { content: [{ type: "text", text: `dispatched ${dispatches.map((run) => run.runId).join(", ")}\nReport each dispatch in chat with purpose and run ID.` }], details: { dispatches } };
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
    description: "Return the oldest unhandled child result for recovery, debugging, or deliberate manual drain. Normal completions arrive as native follow-up prompts.",
    parameters: Type.Object({ thread: Type.Optional(Type.String()) }),
    renderResult: compactRender("fray_next"),
    async execute(_id, params: any, _signal, _update, ctx) {
      remember(ctx);
      const root = frayRoot(ctx.cwd);
      const queue = completionQueue(root, params.thread);
      const run = queue[0];
      if (!run) return { content: [{ type: "text", text: "fray result queue empty" }], details: { queue: [] } };
      return { content: [{ type: "text", text: formatRunResult(root, run) }], details: { run, remaining: queue.length } };
    },
  });

  pi.registerTool({
    name: "fray_steer",
    label: "Fray Steer",
    description: "Steer a fray child agent. If the child is live, send a steering message into it; if no live handle exists (e.g. after a parent reload) but its session was recorded, resume that exact session as a continuation run.",
    parameters: Type.Object({ runId: Type.String(), message: Type.String() }),
    async execute(_id, params: any, _signal, _update, ctx) {
      remember(ctx);
      const root = frayRoot(ctx.cwd);
      const live = liveRuns.get(params.runId);
      if (live) {
        await live.session.steer(params.message);
        appendRunEvent(root, { id: params.runId, updatedAt: new Date().toISOString(), steered: true });
        return { content: [{ type: "text", text: `steered ${params.runId}` }], details: { mode: "live", runId: params.runId } };
      }
      // The stale source itself has no live handle, but if it was already resumed and that
      // continuation is still live, steer the continuation. Opening a second resume here would
      // attach a second SDK session to the same recorded session file and corrupt it.
      const continuationId = findLiveContinuationId([...liveRuns.values()], readRuns(root), params.runId);
      if (continuationId) {
        const continuation = liveRuns.get(continuationId)!;
        await continuation.session.steer(params.message);
        appendRunEvent(root, { id: continuationId, updatedAt: new Date().toISOString(), steered: true, steeredVia: params.runId });
        return {
          content: [{ type: "text", text: `steered live continuation ${continuationId} of ${params.runId} (the stale source was already resumed; steering its live continuation instead of opening a second one against the same session file)` }],
          details: { mode: "live-continuation", runId: continuationId, sourceRunId: params.runId },
        };
      }
      return await resumeRun(pi, ctx, params.runId, params.message);
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
      const shouldMarkHandled = !!(params.markHandled || params.markReconciled);
      if (shouldMarkHandled) {
        const changed = markHandled(root, params.runId);
        const followUpQueued = queueCompletionReminder(pi, root);
        const nextRun = completionQueue(root)[0];
        updateWidget(ctx);
        const nextLine = nextRun
          ? `next unhandled: ${nextRun.id} [${nextRun.status}] ${nextRun.thread || "-"}: ${nextRun.label}${followUpQueued ? " (native follow-up queued)" : " (native follow-up already queued or pending)"}`
          : "fray result queue empty";
        const text = [
          `${changed ? "handled" : "already handled"} ${params.runId}`,
          nextLine,
          "No child output echoed. Do not call fray_next unless you are intentionally recovering, debugging, or manually draining the queue.",
        ].join("\n");
        return { content: [{ type: "text", text }], details: { run, markedHandled: true, alreadyHandled: !changed, nextRun, followUpQueued } };
      }
      const resultText = formatRunResult(root, run);
      updateWidget(ctx);
      return { content: [{ type: "text", text: resultText }], details: { run, markedHandled: false } };
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
    queueCompletionReminder(pi, frayRoot(ctx.cwd));
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    const root = frayRoot(ctx.cwd);
    for (const run of Array.from(liveRuns.values())) {
      liveRuns.delete(run.id);
      try { await run.session.abort(); } catch { /* ignore */ }
      finishLiveRun(pi, root, run, "aborted", "parent pi session shut down before child completed", { notify: false, queueReminder: false });
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
  pi.on("before_agent_start", async (event, ctx) => {
    remember(ctx);
    const root = frayRoot(ctx.cwd);
    const content = formatOrchestrationGuardrail(root, event.prompt);
    if (!content) return;
    return { message: { customType: "fray-orchestration-guardrail", content, display: false, details: { root } } };
  });
  pi.on("message_start", async (event, ctx) => {
    remember(ctx);
    if (event.message?.role !== "user") return;
    handleCompletionReminderMessage(pi, frayRoot(ctx.cwd), extractText(event.message.content));
  });
  pi.on("agent_end", async (_event, ctx) => {
    remember(ctx);
    const root = frayRoot(ctx.cwd);
    if (!(ctx as any).hasPendingMessages?.()) clearUndeliveredReminderSchedules(root);
    queueCompletionReminder(pi, root);
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
    // Completed child runs are durable in .fray/runs.jsonl and findings sidecars; embedded result reminders are delivered only as follow-up messages.
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
    const reminderAction = handleCompletionReminderInput(pi, root, event.text);
    if (reminderAction) return reminderAction;
    if (!event.text.startsWith("/fray ")) return;
    return { action: "continue" };
  });
}
