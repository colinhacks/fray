import { existsSync, readFileSync, readdirSync, appendFileSync } from "node:fs"
import { dirname, join } from "node:path"

export const STATUS = ["todo", "planned", "enqueued", "active", "blocked", "needs-decision", "done", "dismissed"]
export const TERMINAL = ["done", "dismissed"]

export function frayRoot(directory = process.cwd(), worktree) {
  if (worktree && existsSync(join(worktree, ".fray"))) return worktree
  let current = directory
  while (current && current !== dirname(current)) {
    if (existsSync(join(current, ".fray")) || existsSync(join(current, ".opencode"))) return current
    current = dirname(current)
  }
  return directory
}

function scalar(raw) {
  return String(raw ?? "").replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "")
}

function bool(raw, fallback) {
  const value = scalar(raw).toLowerCase()
  if (["true", "on", "yes"].includes(value)) return true
  if (["false", "off", "no"].includes(value)) return false
  return fallback
}

export function loadConfig(root) {
  const config = { enabled: true, autonomousMode: false, state: {} }
  let src = ""
  try {
    src = readFileSync(join(root, ".fray", "config.yml"), "utf8")
  } catch {
    return config
  }
  let inState = false
  for (const line of src.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue
    const nested = line.match(/^[ \t]+([\w-]+):\s*(.*)$/)
    if (inState && nested) {
      config.state[nested[1]] = scalar(nested[2])
      continue
    }
    const top = line.match(/^([\w-]+):\s*(.*)$/)
    if (!top) continue
    if (top[1] === "state") {
      inState = true
      continue
    }
    inState = false
    if (top[1] === "enabled") config.enabled = bool(top[2], config.enabled)
    else if (top[1] === "autonomous_mode") config.autonomousMode = bool(top[2], config.autonomousMode)
  }
  return config
}

function frontmatter(src) {
  const match = src.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return null
  const out = {}
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/)
    if (kv) out[kv[1]] = scalar(kv[2])
  }
  return out
}

function nextStep(src) {
  const lines = src.split("\n")
  const start = lines.findIndex((line) => /^##\s+Next step\s*$/i.test(line))
  if (start === -1) return ""
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) break
    if (lines[i].trim()) return lines[i].trim()
  }
  return ""
}

export function readThreads(root) {
  const dir = join(root, ".fray")
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".md") && !name.startsWith("_"))
      .sort()
      .map((name) => {
        const id = name.replace(/\.md$/, "")
        const text = readFileSync(join(dir, name), "utf8")
        const fm = frontmatter(text)
        const errors = []
        if (!fm) errors.push("no YAML frontmatter")
        else {
          if (!fm.title) errors.push("missing required field: title")
          if (!fm.status) errors.push("missing required field: status")
          else if (!STATUS.includes(fm.status)) errors.push(`invalid status "${fm.status}" (expected one of: ${STATUS.join(", ")})`)
        }
        return { id, title: fm?.title || "", status: fm?.status || "?", next: nextStep(text), queued: /\bQUEUED\b/.test(text), text, errors }
      })
  } catch {
    return []
  }
}

export function validationErrors(root) {
  return readThreads(root).filter((thread) => thread.errors.length).map((thread) => `  ${thread.id}.md: ${thread.errors.join("; ")}`)
}

export function formatValidation(root) {
  const errors = validationErrors(root)
  return errors.length ? `fray frontmatter validation FAILED:\n${errors.join("\n")}` : "fray frontmatter OK"
}

export function formatBoard(root, only) {
  const cfg = loadConfig(root)
  const threads = readThreads(root)
  const errors = validationErrors(root)
  const out = [`fray board - autonomous_mode: ${cfg.autonomousMode ? "on" : "off"}${only ? ` - status:${only}` : ""}`]
  if (errors.length) out.push(`\nVALIDATION ERRORS:\n${errors.join("\n")}`)
  for (const status of only ? [only] : STATUS) {
    const group = threads.filter((thread) => thread.status === status)
    if (!group.length) continue
    out.push(`\n## ${status} (${group.length})`)
    for (const thread of group) out.push(`- ${thread.id} - ${thread.title}\n    -> ${thread.next}`)
  }
  const unknown = threads.filter((thread) => !STATUS.includes(thread.status))
  if (unknown.length) out.push(`\n## invalid status (${unknown.length})\n${unknown.map((thread) => `- ${thread.id} [${thread.status}]`).join("\n")}`)
  return out.join("\n")
}

export function formatJson(root) {
  const cfg = loadConfig(root)
  const threads = readThreads(root).map(({ text, ...thread }) => thread)
  return JSON.stringify({ config: cfg, threads, errors: validationErrors(root) }, null, 2)
}

export function searchThreads(root, query) {
  const q = String(query || "").toLowerCase()
  const hits = readThreads(root).filter((thread) => `${thread.id} ${thread.title} ${thread.text}`.toLowerCase().includes(q))
  return hits.length ? hits.map((thread) => `${thread.id} [${thread.status}] - ${thread.title}`).join("\n") : `no threads match "${query}"`
}

export function reminder(root) {
  const cfg = loadConfig(root)
  if (!cfg.enabled) return ""
  const threads = readThreads(root)
  const pending = threads.filter((thread) => !TERMINAL.includes(thread.status)).map((thread) => `${thread.id}[${thread.status}]`)
  const queued = threads.filter((thread) => !TERMINAL.includes(thread.status) && thread.queued).map((thread) => thread.id)
  const errors = validationErrors(root)
  const mode = cfg.autonomousMode ? "AUTONOMOUS MODE = ON. Do not stall for human input except for irreversible/destructive/published-external actions or human-owned default/security/product/brand/API-config-env decisions. Keep the OpenCode Task fleet busy and document reversible draft decisions in .fray/." : "autonomous_mode=off. Surface human-owned decisions, but keep autonomous investigation/fix/review work moving."
  const base = `FRAY OpenCode reminder: ${mode} Pending threads: ${pending.join(", ") || "none"}. Reconcile returned Task agents before new chat work; fold facts into .fray/<thread>.md, record/clear task_id handles, drain queued follow-ups, and dispatch autonomous follow-ups this turn. Completed agents can be resumed by task_id when continuity matters; there is no live SendMessage/fork-current-chat primitive, so running agents cannot be steered mid-flight.`
  const queuedText = queued.length ? ` Undrained QUEUED follow-ups: ${queued.join(", ")}. Re-read those thread files on the owning agent's return and dispatch the queued work immediately.` : ""
  const errorText = errors.length ? ` Validation errors: ${errors.join("; ")}.` : ""
  return `${base}${queuedText}${errorText}`
}

export function appendLedger(root, row) {
  try {
    appendFileSync(join(root, ".fray", ".dispatch-ledger.jsonl"), `${JSON.stringify(row)}\n`)
  } catch {
    // The thread file is authoritative; ledger failures must never block work.
  }
}

export function threadPath(root, thread) {
  return join(root, ".fray", `${thread}.md`)
}
