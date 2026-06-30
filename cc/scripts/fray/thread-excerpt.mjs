// @ts-check
/**
 * fray — thread-excerpt: read a `.fray/<slug>.md` and render a capped, key-section
 * excerpt for the ORCHESTRATOR to read.
 *
 * WHY THIS EXISTS / where it's used. When a dispatched sub-agent FINISHES and the
 * orchestrator goes idle, the Stop hook (fray-stop-reminder.mjs) rest-reconciliation
 * guard hands the orchestrator the CONTENTS of that agent's bound thread — so it can
 * square the agent's REPORTED results (the task return) against what the thread now
 * SAYS (the agent should have updated its own thread before resting; this is the
 * orchestrator's verification surface). We surface the thread HERE rather than via a
 * SubagentStop hook because a SubagentStop hook's additionalContext continues the
 * SUB-AGENT's turn, not the orchestrator's — the orchestrator's own Stop hook is the
 * only channel that actually lands thread text in the orchestrator's context.
 *
 * WHAT IT EXTRACTS — the at-a-glance current-truth of a thread, not the whole file:
 * the frontmatter status line (status + status_text + title) plus the `## Status`,
 * `## Decisions`, and `## Next step` sections (the single-voice current state). The
 * rest of the file (Steps checklists, long write-ups) stays behind the path pointer.
 *
 * CAPPING — a huge thread must never blow up the orchestrator's context: each thread
 * is capped to PER_THREAD_CAP chars and the combined surface to TOTAL_CAP; on either
 * cap we truncate and note the `.fray/<slug>.md` path for the full read.
 *
 * FAIL-OPEN ABSOLUTELY: a missing/unreadable file, an unresolved slug, or any parse
 * error yields no excerpt for that thread (the caller degrades to the bare pointer).
 * Never throws.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PER_THREAD_CAP = 1200; // max chars of excerpt body per thread
const TOTAL_CAP = 4000; // max chars across ALL just-finished threads combined

// The body sections that carry a thread's single-voice CURRENT truth — the same set
// the dispatch epilogue tells an agent to keep current. Order is the surfaced order.
const KEY_SECTIONS = ['Status', 'Decisions', 'Next step'];

/**
 * Pull the content under a `## <name>` heading up to the next h1/h2 (h3+ stays in the
 * section). Case-insensitive on the heading text; trailing blank lines trimmed.
 * @param {string} src
 * @param {string} name
 * @returns {string} the section body (no heading line), or '' if absent/empty
 */
function section(src, name) {
  const lines = src.split('\n');
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp(`^##\\s+${esc}\\s*$`, 'i');
  const i = lines.findIndex((l) => head.test(l));
  if (i === -1) return '';
  const body = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (/^#{1,2}\s/.test(lines[j])) break; // next h1/h2 ends the section
    body.push(lines[j]);
  }
  return body.join('\n').replace(/\s+$/, '').replace(/^\s*\n/, '');
}

/**
 * Parse the leading `--- … ---` frontmatter into a flat scalar map (same shape the
 * board parser reads). Returns {} when there's no frontmatter.
 * @param {string} src
 * @returns {Record<string,string>}
 */
function frontmatter(src) {
  /** @type {Record<string,string>} */
  const out = {};
  const m = src.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * Build a capped excerpt of one thread's current truth, or null if the file can't be
 * read / has no useful content. The returned string is the BODY only (the caller adds
 * the `--- .fray/<slug>.md ---` banner) so callers can frame it uniformly.
 * @param {string} projectDir
 * @param {string} slug
 * @returns {string|null}
 */
export function threadExcerpt(projectDir, slug) {
  if (!slug || typeof slug !== 'string') return null;
  const rel = `.fray/${slug}.md`;
  let src;
  try {
    src = readFileSync(join(projectDir, '.fray', `${slug}.md`), 'utf8');
  } catch {
    return null; // missing/unreadable → caller degrades to the bare pointer
  }

  const fm = frontmatter(src);
  const parts = [];
  // Compact frontmatter header — the at-a-glance status, never the whole block.
  const statusLine = [
    fm.status ? `status: ${fm.status}` : null,
    fm.status_text ? `status_text: ${fm.status_text}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  if (statusLine) parts.push(statusLine);

  for (const name of KEY_SECTIONS) {
    const body = section(src, name);
    if (body) parts.push(`## ${name}\n${body}`);
  }

  if (!parts.length) return null; // nothing useful to surface

  let body = parts.join('\n\n');
  if (body.length > PER_THREAD_CAP) {
    body = body.slice(0, PER_THREAD_CAP).replace(/\s+\S*$/, '') + `\n… [truncated — full thread at ${rel}]`;
  }
  return body;
}

/**
 * Render the combined "thread contents for the agent(s) that just finished" block for a
 * set of just-completed thread slugs — the orchestrator's verification surface. Dedupes
 * slugs, skips any that can't be excerpted, and caps the COMBINED size at TOTAL_CAP
 * (threads past the cap are listed by path only). Returns '' when nothing surfaces, so
 * the caller can append it unconditionally and degrade to the bare rest pointer.
 * @param {string} projectDir
 * @param {string[]} slugs
 * @returns {string}
 */
export function threadExcerptsBlock(projectDir, slugs) {
  try {
    const seen = new Set();
    /** @type {string[]} */
    const blocks = [];
    /** @type {string[]} */
    const overflow = [];
    let used = 0;
    for (const slug of slugs || []) {
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      const ex = threadExcerpt(projectDir, slug);
      const rel = `.fray/${slug}.md`;
      if (!ex) continue; // unreadable/empty → silently skip (bare pointer still names the thread)
      const rendered = `--- ${rel} ---\n${ex}`;
      if (used + rendered.length > TOTAL_CAP && blocks.length) {
        overflow.push(rel); // already surfaced at least one; defer the rest to a path list
        continue;
      }
      blocks.push(rendered);
      used += rendered.length;
    }
    if (!blocks.length) return '';
    let out =
      '\n\nfray — thread contents for the agent(s) that just finished (the agent should have updated its thread before resting; square its reported results against what the thread now says):\n\n' +
      blocks.join('\n\n');
    if (overflow.length) out += `\n\n… also finished (read in full): ${overflow.join(', ')}`;
    return out;
  } catch {
    return ''; // fail-open — never break the Stop hook over an excerpt
  }
}
