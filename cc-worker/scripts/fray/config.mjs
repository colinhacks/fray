// @ts-check
/**
 * THIN SHIM — do NOT fork config logic. cc-worker shares cc's single source of truth for the
 * activation gate, config schema, status vocab, and the per-session sentinel/heartbeat helpers.
 * This re-exports cc's `scripts/fray/config.mjs` verbatim so cc-worker hooks can `import ...
 * from '../scripts/fray/config.mjs'` with cc's exact idiom while the real code lives in ONE place.
 *
 * Coupling note: cc-worker assumes cc is a SIBLING dir (`../../cc/` from the plugin root) — the
 * same assumption fray-ui's server makes (see ui/ARCHITECTURE.md: it imports the board logic from
 * `../../cc/scripts/fray/*.mjs`). If that layout changes, this one path changes with it.
 */
export * from '../../../cc/scripts/fray/config.mjs';
