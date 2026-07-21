// The opaque overlay surface WITHOUT a z-index. Portal menus/popovers must be an opaque layer from
// their first painted frame — the older `pop-in` animation starts at opacity: 0, which makes a
// just-opened menu look transparent over the sidebar/composer. This base owns everything BUT the
// stacking level, so a caller applies EXACTLY ONE z utility on top (never two conflicting z-* classes
// on one element — Tailwind resolves same-property collisions by CSS source order, not class order,
// so stacking z-[110] and z-[250] would be a coin-flip). Motion-free (no pop-in) by contract.
export const OPAQUE_SURFACE_BASE =
  "isolate bg-elevated opacity-100 border border-border shadow-2xl shadow-black/40"

// THE STACKING ORDER, low → high. The sidebar/board rail deliberately has NO z-index (default
// stacking): it and the workpane are side-by-side columns that never overlap, and its old desktop
// z-[100] is what forced every overlay to escalate past it — the recurring "hidden underneath the
// prompt box" bug. Anything below is an OVERLAY and therefore already outranks the rail:
//   z-20  fixed corner chrome · z-50 modal dialogs/drawers · z-[60] ⌘K palette · z-[70] toasts
//   z-[110] portaled selector surfaces · z-[200] shared Dialog · z-[250] anchored popovers/tooltips
//   z-[300] restart scrim (alone must cover the whole app)
// Never re-elevate a persistent layer to "win" a collision — raise the specific overlay instead.

// The selector-surface contract for Select, DropdownMenu, and the profile grid: the opaque base at
// z-[110]. Portal content mounts at document.body, so it must clear the modal surfaces it can be
// opened from (a selector inside a z-50 dialog) rather than paint beneath them.
export const OPAQUE_PORTAL_SURFACE_CLASS = `z-[110] ${OPAQUE_SURFACE_BASE}`

// The z-index for ANCHORED transient overlays that pop off a trigger — tooltips and popovers. They
// must clear every surface they can be opened from: the opaque selector surface (z-[110]) and the
// modal Dialog (z-[200], so a popover opened from inside a dialog still shows). It sits just below
// the restart scrim (z-[300]). This is also the fix for the quota popover that used to render at
// z-50 and got clipped away "underneath the prompt box".
export const OVERLAY_Z_CLASS = "z-[250]"
