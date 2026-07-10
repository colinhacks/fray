// @ts-check
/**
 * THIN SHIM — re-exports cc's `scripts/fray/agent-bindings.mjs` so the worker's PostToolUse
 * `agent-bind` hook writes `.fray/.agent-bindings.jsonl` records in the EXACT format cc's board
 * (`bindingsByThread`) + Stop-hook liveness consume. Keeping the writer shared is what lets a
 * worker's own THREAD-tagged sub-agent show up on the fray-ui board's per-thread liveness.
 * Never fork this — the record shape is a cross-plugin contract.
 */
export * from '../../../cc/scripts/fray/agent-bindings.mjs';
