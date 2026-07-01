// @ts-check
/**
 * fray — per-thread SESSION OWNERSHIP. A thread carries an optional `owner_session: <id>`
 * frontmatter field naming the Claude Code session RESPONSIBLE for it, so multiple fray
 * sessions can share one repo, each driving its own set of threads without stepping on the
 * others. This module is the read/write + state-derivation layer; the `fray claim/disown/
 * owners` subcommands (index.mjs) and the board annotation sit on top.
 *
 * TWO HARD DESIGN CHOICES (both deliberate — see the fray thread / report):
 *
 *   1. LIVENESS IS DERIVED, ownership is only WRITTEN by an explicit gesture. Whether an owner
 *      is alive comes from its heartbeat freshness (config.mjs `sessionLive`), NOT a stored
 *      flag. The `owner_session` STRING is physically written ONLY by `fray claim`/`disown`
 *      (a human/orchestrator action) and cleared by `fray owners --gc` — NEVER by an automatic
 *      per-turn hook. That is the safety guarantee: no hook ever rewrites a thread `.md` body,
 *      so there is no clobber race against a sub-agent editing the same thread. A dead owner's
 *      lingering `owner_session` string is INERT — derivation reads it as orphaned/claimable,
 *      and the next `claim` overwrites it.
 *
 *   2. OWNERSHIP IS ADVISORY, not a hard lock. It surfaces "another live session is on this,
 *      don't touch" and "this is orphaned, take it" — it does not physically prevent an edit.
 *      A hard lock would let a crashed session permanently freeze its threads; advisory +
 *      heartbeat-staleness + `--force` is the safe shape.
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/** The frontmatter key that records a thread's owning session id. */
export const OWNER_KEY = 'owner_session';

/**
 * A session id is a bare, filesystem-safe token (uuid-ish: word chars, dots, hyphens). Reject
 * anything else so a stray value can never inject frontmatter or a newline.
 * @param {string} sid
 * @returns {boolean}
 */
export function isValidSessionId(sid) {
  return typeof sid === 'string' && /^[\w.-]+$/.test(sid) && sid.length <= 200;
}

/**
 * Read a thread's `owner_session` (or null when unset/empty/missing thread). Reads only the
 * frontmatter block, matching the board's flat `key: value` shape.
 * @param {string} projectDir
 * @param {string} slug
 * @returns {string|null}
 */
export function readOwner(projectDir, slug) {
  try {
    const src = readFileSync(join(projectDir, '.fray', `${slug}.md`), 'utf8');
    const fmEnd = src.indexOf('\n---', 4); // frontmatter is `---\n … \n---`
    const fm = fmEnd === -1 ? src : src.slice(0, fmEnd);
    const m = fm.match(/^owner_session:[ \t]*(.*)$/m);
    if (!m) return null;
    const v = m[1].trim().replace(/^["']|["']$/g, '');
    return v || null;
  } catch {
    return null;
  }
}

/**
 * Set (or, with `sid === null`, REMOVE) a thread's `owner_session` frontmatter field, atomically
 * and byte-for-byte-preserving everything else — the SAME split/rename discipline as the thread
 * updater. Throws on a missing thread / no frontmatter / an invalid session id (callers report).
 * @param {string} projectDir
 * @param {string} slug
 * @param {string|null} sid  the owning session id, or null to clear ownership
 */
export function setOwner(projectDir, slug, sid) {
  if (sid !== null && !isValidSessionId(sid)) throw new Error(`invalid session id: ${sid}`);
  const path = join(projectDir, '.fray', `${slug}.md`);
  const original = readFileSync(path, 'utf8');
  const lines = original.split('\n');
  if (lines[0] !== '---') throw new Error(`thread ${slug}.md has no YAML frontmatter block`);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { end = i; break; }
  }
  if (end === -1) throw new Error(`thread ${slug}.md frontmatter is not closed`);

  // Locate an existing owner_session line within [1, end).
  let ownerAt = -1;
  for (let i = 1; i < end; i++) {
    if (/^owner_session:/.test(lines[i])) { ownerAt = i; break; }
  }
  if (sid === null) {
    if (ownerAt !== -1) lines.splice(ownerAt, 1); // remove the line entirely
  } else if (ownerAt !== -1) {
    lines[ownerAt] = `owner_session: ${sid}`; // update in place, preserving order
  } else {
    lines.splice(end, 0, `owner_session: ${sid}`); // append as the last frontmatter line
  }

  const out = lines.join('\n');
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, out);
  renameSync(tmp, path);
}

/**
 * @typedef {'unowned'|'mine'|'other-live'|'orphaned'} OwnershipState
 */

/**
 * Derive the EFFECTIVE ownership state of a thread for the current session.
 *   - no owner            → `unowned`
 *   - owner === me        → `mine`
 *   - owner alive (other) → `other-live`   (don't touch; `--force` to take it)
 *   - owner dead  (other) → `orphaned`     (freely claimable)
 * @param {string|null} owner        the thread's `owner_session`
 * @param {string|null} currentSid   this session's id
 * @param {boolean} ownerLive        whether `owner` is currently live (heartbeat-derived)
 * @returns {OwnershipState}
 */
export function effectiveOwnership(owner, currentSid, ownerLive) {
  if (!owner) return 'unowned';
  if (currentSid && owner === currentSid) return 'mine';
  return ownerLive ? 'other-live' : 'orphaned';
}
