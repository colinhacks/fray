import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const STATUS = ['todo', 'planned', 'enqueued', 'active', 'blocked', 'needs-decision', 'done', 'dismissed'];
const TERMINAL = ['done', 'dismissed'];

export function readStdinJson() {
  try {
    const raw = readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function findProjectDir(cwd) {
  let dir = cwd || process.cwd();
  for (;;) {
    if (existsSync(join(dir, '.fray', 'config.yml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return cwd || process.cwd();
    dir = parent;
  }
}

export function ledgerPath(projectDir) {
  return join(projectDir, '.fray', '.dispatch-ledger.jsonl');
}

export function readLedger(projectDir) {
  const path = ledgerPath(projectDir);
  if (!existsSync(path)) return { rows: [], errors: [] };
  const rows = [];
  const errors = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  for (const [idx, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      errors.push(`invalid JSON in .fray/.dispatch-ledger.jsonl line ${idx + 1}`);
    }
  }
  return { rows, errors };
}

export function writeLedger(projectDir, rows) {
  writeFileSync(ledgerPath(projectDir), `${rows.map((row) => JSON.stringify(row)).join('\n')}${rows.length ? '\n' : ''}`);
}

export function getAgentId(input) {
  return String(input.agent_id || input.agentId || input.subagent_id || input.subagentId || input.agent?.id || '');
}

export function getAssistantMessage(input) {
  return String(
    input.last_assistant_message ||
      input.lastAssistantMessage ||
      input.assistant_message ||
      input.assistantMessage ||
      input.message ||
      input.output ||
      '',
  );
}

export function extractFrayPacket(message) {
  const match = String(message).match(/^##\s+Fray state packet\s*$([\s\S]*?)(?=^##\s+|(?![\s\S]))/im);
  if (!match) return { present: false, excerpt: '', hash: '', dispatchId: '' };
  const excerpt = match[1].trim().slice(0, 1200);
  const hash = createHash('sha256').update(excerpt).digest('hex').slice(0, 16);
  const dispatchId =
    excerpt.match(/^dispatch:\s*(\S+)/im)?.[1]?.trim() ||
    excerpt.match(/^FRAY_DISPATCH_ID:\s*(\S+)/im)?.[1]?.trim() ||
    '';
  return { present: true, excerpt, hash, dispatchId };
}

export function markReturnedByAgentId(projectDir, agentId, message) {
  if (!agentId) return { updated: 0, errors: ['missing agent_id in hook input'] };
  const { rows, errors } = readLedger(projectDir);
  if (errors.length) return { updated: 0, errors };
  const packet = extractFrayPacket(message);
  const returnedTs = new Date().toISOString();
  const candidates = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => String(row.agent_id || '') === agentId && row.reconciled !== true);

  let targetIndex = -1;
  let ambiguity = '';
  if (packet.dispatchId) {
    const exact = candidates.filter(({ row }) => String(row.dispatch_id || '') === packet.dispatchId);
    if (exact.length) targetIndex = exact[exact.length - 1].index;
    else ambiguity = `packet dispatch ${packet.dispatchId} did not match an unreconciled ledger row for agent ${agentId}`;
  } else if (candidates.length) {
    targetIndex = candidates[candidates.length - 1].index;
    if (candidates.length > 1) {
      ambiguity = `multiple unreconciled rows for agent ${agentId}; no dispatch id in packet; marked newest row only`;
    }
  }

  if (targetIndex === -1) {
    return { updated: 0, errors: ambiguity ? [ambiguity] : [`no unreconciled ledger row found for agent ${agentId}`] };
  }

  const next = rows.map((row) => {
    if (row !== rows[targetIndex]) return row;
    return {
      ...row,
      returned: true,
      returned_ts: returnedTs,
      packet_present: packet.present,
      ...(packet.excerpt && packet.present ? { packet_excerpt: packet.excerpt, packet_hash: packet.hash } : {}),
      ...(ambiguity ? { return_ambiguity: ambiguity } : {}),
    };
  });
  writeLedger(projectDir, next);
  return { updated: 1, errors: ambiguity ? [ambiguity] : [] };
}

export function returnedUnreconciled(projectDir) {
  const { rows, errors } = readLedger(projectDir);
  return {
    rows: rows.filter((row) => row.returned === true && row.reconciled !== true),
    errors,
  };
}

// PER-SESSION SENTINEL — enablement is keyed on the session id, not a config flag.
// `.fray/.session-state/<session_id>` with `off`/`on` is a per-session override; absent →
// default (active when `.fray/` exists). Mirrors the cc harness; dependency-free here.
function sessionOverride(projectDir, sessionId) {
  if (!projectDir || !sessionId) return null;
  try {
    const f = join(projectDir, '.fray', '.session-state', String(sessionId));
    if (!existsSync(f)) return null;
    const v = readFileSync(f, 'utf8').trim().toLowerCase();
    if (/^(off|false|no|0|disabled)$/.test(v)) return 'off';
    if (/^(on|true|yes|1|enabled)$/.test(v)) return 'on';
    return 'off';
  } catch {
    return null;
  }
}

export function loadFray(projectDir, sessionId) {
  const frayDir = join(projectDir, '.fray');
  // Bootstrapped iff `.fray/` exists (config.yml is no longer the enablement gate).
  if (!existsSync(frayDir)) return { enabled: false, pending: [], queued: [], unreconciled: [], unattached: [], errors: [] };

  // Per-session override: `off` silences this session; absent / `on` → active.
  if (sessionOverride(projectDir, sessionId) === 'off') {
    return { enabled: false, pending: [], queued: [], unreconciled: [], unattached: [], errors: [] };
  }

  const pending = [];
  const queued = [];
  const unreconciled = [];
  const returned = [];
  const unattached = [];
  const errors = [];
  try {
    for (const file of readdirSync(frayDir).sort()) {
      if (!file.endsWith('.md') || file.startsWith('_')) continue;
      const slug = file.replace(/\.md$/, '');
      const src = readFileSync(join(frayDir, file), 'utf8');
      const title = src.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? '';
      const status = src.match(/^status:\s*(\S+)/m)?.[1] ?? '';
      if (!title) errors.push(`${slug}: missing title`);
      if (!status) errors.push(`${slug}: missing status`);
      else if (!STATUS.includes(status)) errors.push(`${slug}: invalid status "${status}"`);
      if (!TERMINAL.includes(status)) {
        pending.push({ slug, title, status: status || '?' });
        if (/\bQUEUED\b/.test(src)) queued.push(slug);
      }
    }
  } catch {
    errors.push('unable to scan .fray threads');
  }

  try {
    const ledger = readLedger(projectDir);
    errors.push(...ledger.errors);
    for (const row of ledger.rows) {
      if (row.reconciled === true) continue;
      const item = {
        dispatch_id: String(row.dispatch_id || ''),
        thread: String(row.thread || ''),
        label: String(row.label || ''),
        agent_id: String(row.agent_id || ''),
        nickname: String(row.nickname || ''),
        packet_present: row.packet_present,
      };
      if (row.returned === true) returned.push(item);
      else if (item.agent_id) unreconciled.push(item);
      else if (row.tool === 'codex.spawn_agent') unattached.push(item);
    }
  } catch {
    errors.push('unable to read .fray/.dispatch-ledger.jsonl');
  }

  return { enabled: true, pending, queued, unreconciled, returned, unattached, errors };
}

export function contextMessage(projectDir, source = '', sessionId) {
  const fray = loadFray(projectDir, sessionId);
  if (!fray.enabled) return '';
  const pending = fray.pending.slice(0, 12).map((t) => `${t.slug} [${t.status}]`).join(', ');
  const suffix = fray.pending.length > 12 ? `, +${fray.pending.length - 12} more` : '';
  const trigger = source ? ` (${source})` : '';
  const queued = fray.queued.slice(0, 10).join(', ');
  const queuedSuffix = fray.queued.length > 10 ? `, +${fray.queued.length - 10} more` : '';
  const returned = fray.returned.slice(0, 10).map((d) => `${d.dispatch_id || d.agent_id}->${d.thread || '?'}${d.packet_present === false ? '[no packet]' : ''}`).join(', ');
  const returnedSuffix = fray.returned.length > 10 ? `, +${fray.returned.length - 10} more` : '';
  const unreconciled = fray.unreconciled.slice(0, 10).map((d) => `${d.dispatch_id || d.agent_id}->${d.thread || '?'}`).join(', ');
  const unreconciledSuffix = fray.unreconciled.length > 10 ? `, +${fray.unreconciled.length - 10} more` : '';
  const unattached = fray.unattached.slice(0, 10).map((d) => `${d.dispatch_id}->${d.thread || '?'}`).join(', ');
  const unattachedSuffix = fray.unattached.length > 10 ? `, +${fray.unattached.length - 10} more` : '';
  return [
    `FRAY ACTIVE${trigger}: load the Codex fray skill before task work.`,
    'This is Fray, not stale interactive-workflow memory; the active `.fray/config.yml` is the trigger to reactivate after startup/resume/clear/compact.',
    'Run `node .agents/plugins/fray-codex/scripts/codex-reminder.mjs` and `node .agents/plugins/fray-codex/scripts/fray/index.mjs` before meaningful work.',
    'Do not call `wait_agent` in Fray mode. Rely on sub-agent notifications, `codex-reminder`, and the dispatch ledger; if any subagent returns, update its owning .fray thread immediately.',
    'Every subagent final report must include `## Fray state packet` and `## Follow-ups`.',
    'Only the orchestrator edits `.fray/<slug>.md` and `.fray/config.yml`; subagents return findings or write sidecars.',
    pending ? `Pending threads: ${pending}${suffix}.` : 'No pending nonterminal threads found.',
    queued ? `Queued follow-ups by thread: ${queued}${queuedSuffix}. Drain them immediately when the named dependency returns.` : '',
    returned ? `RETURNED BUT UNRECONCILED dispatches: ${returned}${returnedSuffix}. Reconcile these before final answers or unrelated work.` : '',
    unreconciled ? `Unreconciled dispatch ledger rows: ${unreconciled}${unreconciledSuffix}. Fold returns into threads before marking reconciled.` : '',
    unattached ? `Unattached dispatch ledger rows: ${unattached}${unattachedSuffix}. Attach the spawned agent id or reconcile stale preflight rows.` : '',
    fray.errors.length ? `Fray validation issues: ${fray.errors.join('; ')}.` : '',
  ].filter(Boolean).join('\n');
}
