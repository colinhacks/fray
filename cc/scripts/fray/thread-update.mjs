#!/usr/bin/env node
// @ts-check
// Structured fray-thread updater. A superset of the single-op Edit tool: structured
// frontmatter inputs (--status/--status-text/--set) + a multi-patch body editor
// (--patch, repeatable) + --append. Writes the project's .fray/<slug>.md atomically,
// preserving every byte outside the keys/regions it touches.
//
// Exposed as the `fray-update` command (bin/fray-update is on the Bash PATH while the
// plugin is enabled). The project root is resolved from CLAUDE_PROJECT_DIR (exported to
// bin/hook processes), matching how bin/fray + index.mjs find the project's .fray/.
//
// Enforced invariant: setting `status: blocked` on a HUMAN-blocked thread (no `blocking_threads`/
// `depends_on` and no `revalidate_at`) REQUIRES a non-empty status_text (the decision write-up).
// The ⚖ awaiting-you queue DERIVES from those status_text fields (see decisions.mjs), so a
// human-blocked thread without a write-up would surface as an empty queue row. A MACHINE/timer-
// blocked thread carries its mechanism field instead and needs no write-up. After every edit
// this tool prints the FULL queue (collectDecisions) so a pending decision is never silently
// buried. Legacy status spellings (todo/plan → planned; enqueued/needs-decision → blocked) are
// ACCEPTED and normalized to canonical on write.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { collectDecisions } from './decisions.mjs';
import { STATUS, ACCEPTED_STATUSES, isValidStatus, normalizeStatus, parseDeps } from './config.mjs';

// The status vocabulary is the SINGLE shared source from config.mjs (the same set the
// board validates against) — importing it keeps the updater and the board from drifting.
// The usage line shows the CANONICAL set; the legacy aliases are accepted but not advertised.
const STATUSES = STATUS;
const PATCH_SEP = '===>>';
// The decision write-up lives in the `status_text` frontmatter key — the single canonical
// spelling, read and written everywhere (the board reads the same key).
const STATUS_TEXT_KEY = 'status_text';

// The project root comes from the environment, NOT this script's own path: the tool
// ships inside the fray PLUGIN, so a script-relative root would point at the PLUGIN,
// never the project. CLAUDE_PROJECT_DIR is exported to bin/hook processes; when run by
// hand from the repo root, process.cwd() is correct.
const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const usage = `usage: fray-update <slug> [options]
  --status <s>              set status; one of: ${STATUSES.join(' · ')}
                            (legacy todo/plan/enqueued/needs-decision accepted → normalized to canonical)
                            (human-blocked — blocked with no blocking_threads/revalidate_at — REQUIRES a status_text)
  --status-text "<text>"    set the status_text field (decision write-up / gloss)
  --set key=value           set any other frontmatter scalar (repeatable)
  --patch "<find>${PATCH_SEP}<replace>"  body find/replace, must match EXACTLY once (repeatable, applied in order, atomic)
  --append "<text>"         append text to the body`;

function parseArgs(argv) {
  const out = { slug: undefined, status: undefined, status_text: undefined, sets: [], patches: [], appends: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    const needVal = (name) => {
      if (i + 1 >= argv.length) die(`${name} requires a value`);
      return argv[++i];
    };
    switch (a) {
      case '--status': out.status = needVal('--status'); break;
      case '--status-text': out.status_text = needVal('--status-text'); break;
      case '--set': out.sets.push(needVal('--set')); break;
      case '--patch': out.patches.push(needVal('--patch')); break;
      case '--append': out.appends.push(needVal('--append')); break;
      case '-h': case '--help': console.log(usage); process.exit(0); break;
      default:
        if (a.startsWith('-')) die(`unknown flag: ${a}`);
        if (out.slug !== undefined) die(`unexpected positional: ${a} (slug already set to "${out.slug}")`);
        out.slug = a;
    }
  }
  return out;
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Quote a frontmatter scalar value the way the existing threads do: double-quoted
// with inner double-quotes escaped. Bare safe scalars (the empty-bracket list,
// plain dates/words) are left unquoted to match the on-disk convention.
function quoteValue(v) {
  if (/^\[.*\]$/.test(v.trim())) return v.trim(); // list literal, e.g. depends_on: []
  if (/^[\w./#:+-]+$/.test(v)) return v; // bare safe scalar (date, single word, slug)
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Split the file into [frontmatter-lines, body-string]. Frontmatter is the block
// between the leading `---` and the next `---`. Returns null fm if absent.
function splitFrontmatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { fm: null, fmEnd: 0, body: text };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { end = i; break; }
  }
  if (end === -1) return { fm: null, fmEnd: 0, body: text };
  const fm = lines.slice(1, end);
  const body = lines.slice(end + 1).join('\n');
  return { fm, fmEnd: end, body };
}

function fmGet(fm, key) {
  const re = new RegExp(`^${key}:\\s*(.*)$`);
  for (const line of fm) {
    const m = line.match(re);
    if (m) return m[1];
  }
  return undefined;
}

// Set a frontmatter key in place (preserving line order); append if absent.
function fmSet(fm, key, rawValue) {
  const value = quoteValue(rawValue);
  const re = new RegExp(`^${key}:\\s*`);
  for (let i = 0; i < fm.length; i++) {
    if (re.test(fm[i])) { fm[i] = `${key}: ${value}`; return fm; }
  }
  fm.push(`${key}: ${value}`);
  return fm;
}

// Write the decision write-up to the canonical `status_text` key — the only key the board
// (index.mjs) reads to render the `» gloss` line and to gate the drop-risk warning.
function setStatusText(fm, rawValue) {
  return fmSet(fm, STATUS_TEXT_KEY, rawValue);
}

function getStatusText(fm) {
  return fmGet(fm, STATUS_TEXT_KEY);
}

// A status_text value counts as "present" only if it's a non-empty string.
function isStatusTextNonEmpty(raw) {
  if (raw === undefined) return false;
  let v = raw.trim();
  const m = v.match(/^"((?:[^"\\]|\\.)*)"$/);
  if (m) v = m[1].replace(/\\(.)/g, '$1');
  return v.trim().length > 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.slug) { console.log(usage); process.exit(args.slug === undefined && process.argv.length <= 2 ? 0 : 1); }

  const path = join(root, '.fray', `${args.slug}.md`);
  if (!existsSync(path)) die(`no thread at ${path}`);

  const original = readFileSync(path, 'utf8');
  const { fm, body } = splitFrontmatter(original);
  if (fm === null) die(`thread ${args.slug}.md has no YAML frontmatter block`);

  // --- Validate status + the needs-human/status_text invariant BEFORE writing ---
  // Accept canonical OR a legacy alias, then NORMALIZE to canonical so the on-disk value is
  // always canonical going forward (e.g. `--status needs-decision` writes `needs-human`,
  // `--status enqueued` writes `blocked`).
  if (args.status !== undefined && !isValidStatus(args.status)) {
    die(`invalid status "${args.status}"; must be one of: ${ACCEPTED_STATUSES.join(' · ')}`);
  }
  const canonicalStatus = args.status !== undefined ? normalizeStatus(args.status) : undefined;
  // A `needs-human` thread — OR a `blocked` thread with NO machine field, which READS as
  // needs-human (config.effectiveStatus) — IS the ⚖ awaiting-you queue entry, so it REQUIRES a
  // status_text ask. A `blocked` thread WITH a `blocking_threads`/`revalidate_at` field is a
  // machine/timer wait and needs no write-up. We look at the fields being SET this call PLUS
  // what's already on the thread.
  if (canonicalStatus === 'needs-human' || canonicalStatus === 'blocked') {
    // A key counts as a machine field only when its EFFECTIVE post-write value is non-empty —
    // the `--set` value if this call sets the key, else what's already on disk. Checking mere
    // key-PRESENCE would let `--set blocking_threads=[]` / `--set revalidate_at=` bypass the
    // invariant. Empty string, `[]`, and `[ ]` are all "no machine field."
    // Deps: a `--set` on this call wins (inline value); otherwise read the ON-DISK deps via the
    // shared block-form-aware parseDeps (a flat fmGet would miss a YAML block-form list and falsely
    // refuse a legitimately machine-blocked thread — matches the board/decisions readers).
    const setDep = args.sets.find((kv) => {
      const k = kv.slice(0, kv.indexOf('=')).trim();
      return k === 'blocking_threads' || k === 'depends_on';
    });
    const hasDeps =
      setDep !== undefined
        ? (() => {
            const v = setDep.slice(setDep.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '').trim();
            return v !== '' && v.replace(/\s+/g, '') !== '[]';
          })()
        : parseDeps(original).length > 0;
    const setRv = args.sets.find((kv) => kv.slice(0, kv.indexOf('=')).trim() === 'revalidate_at');
    const rvRaw = setRv !== undefined ? setRv.slice(setRv.indexOf('=') + 1) : fmGet(fm, 'revalidate_at');
    const hasTimerField = (rvRaw ?? '').trim().replace(/^["']|["']$/g, '').trim() !== '';
    const hasMachineField = hasDeps || hasTimerField;
    // Effective needs-human = the word `needs-human`, OR `blocked` with no machine field.
    if (canonicalStatus === 'needs-human' || !hasMachineField) {
      const willHaveStatusText = args.status_text !== undefined
        ? isStatusTextNonEmpty(`"${args.status_text}"`) || args.status_text.trim().length > 0
        : isStatusTextNonEmpty(getStatusText(fm));
      if (!willHaveStatusText) {
        die(canonicalStatus === 'needs-human'
          ? 'a `needs-human` thread REQUIRES a status_text stating the ask — pass --status-text "<the decision/ask needed>"'
          : 'a `blocked` thread with no `blocking_threads`/`revalidate_at` reads as needs-human and REQUIRES a status_text — pass --status-text "<the ask>", add a machine field to make it a real machine wait, or use --status needs-human');
      }
    }
  }

  // --- Apply body patches (atomic: validate all, then apply) ---
  const patchOps = args.patches.map((p, idx) => {
    const sepAt = p.indexOf(PATCH_SEP);
    if (sepAt === -1) die(`--patch #${idx + 1} missing "${PATCH_SEP}" separator`);
    return { find: p.slice(0, sepAt), replace: p.slice(sepAt + PATCH_SEP.length), idx };
  });
  for (const op of patchOps) {
    if (op.find === '') die(`--patch #${op.idx + 1} has an empty find string`);
    const count = body.split(op.find).length - 1;
    if (count === 0) die(`--patch #${op.idx + 1} find string not found in body (no patches applied)`);
    if (count > 1) die(`--patch #${op.idx + 1} find string occurs ${count} times, must be unique (no patches applied)`);
  }
  let newBody = body;
  for (const op of patchOps) newBody = newBody.replace(op.find, op.replace);

  // --- Apply appends ---
  for (const text of args.appends) {
    const sep = newBody.endsWith('\n') ? '' : '\n';
    newBody = `${newBody}${sep}${text}${text.endsWith('\n') ? '' : '\n'}`;
  }

  // --- Apply frontmatter edits ---
  let lastUpdateExplicit = false;
  if (args.status !== undefined) fmSet(fm, 'status', canonicalStatus); // write CANONICAL, never the legacy alias
  if (args.status_text !== undefined) setStatusText(fm, args.status_text);
  for (const kv of args.sets) {
    const eq = kv.indexOf('=');
    if (eq === -1) die(`--set requires key=value (got "${kv}")`);
    const key = kv.slice(0, eq).trim();
    const value = kv.slice(eq + 1);
    if (!key) die(`--set has an empty key (got "${kv}")`);
    if (key === 'last_update') lastUpdateExplicit = true;
    fmSet(fm, key, value);
  }
  // Auto-stamp last_update unless explicitly set. Only when SOMETHING changed.
  const mutated = args.status !== undefined || args.status_text !== undefined || args.sets.length || patchOps.length || args.appends.length;
  if (mutated && !lastUpdateExplicit) fmSet(fm, 'last_update', today());

  // body is everything after the closing `---` line (its join started at end+1),
  // so it carries its own leading newline(s) — emit it verbatim after `---\n` to
  // preserve the exact blank-line layout byte-for-byte.
  const out = `---\n${fm.join('\n')}\n---\n${newBody}`;

  // Atomic write: temp file in the same dir, then rename.
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, out);
  renameSync(tmp, path);

  // --- Report ---
  const finalStatus = fmGet(fm, 'status') ?? '(unset)';
  const finalStatusText = getStatusText(fm);
  console.log(`updated .fray/${args.slug}.md`);
  console.log(`  status: ${finalStatus}`);
  if (finalStatusText !== undefined) {
    const display = finalStatusText.replace(/^"(.*)"$/, '$1');
    console.log(`  status_text: ${display.length > 120 ? display.slice(0, 117) + '…' : display}`);
  }
  if (patchOps.length) console.log(`  patches applied: ${patchOps.length}`);
  if (args.appends.length) console.log(`  appended: ${args.appends.length} block(s)`);

  // Always surface the FULL decisions queue after ANY thread edit — so every fray
  // edit-tool call prints the current decision write-ups straight to the terminal,
  // not just a one-line summary of the thread that changed.
  const decisions = collectDecisions();
  console.log('');
  if (decisions.length === 0) {
    console.log('⚖ no pending decisions');
  } else {
    console.log(`⚖ ${decisions.length} decision(s) awaiting you:\n`);
    decisions.forEach((d, i) => {
      console.log(`[${d.slug}]`);
      console.log(d.status_text || '(no status_text written up)');
      if (i < decisions.length - 1) console.log('');
    });
  }
}

main();
