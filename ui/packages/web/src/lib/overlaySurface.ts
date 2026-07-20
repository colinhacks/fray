// The opaque overlay surface WITHOUT a z-index. Portal menus/popovers must be an opaque layer from
// their first painted frame — the older `pop-in` animation starts at opacity: 0, which makes a
// just-opened menu look transparent over the sidebar/composer. This base owns everything BUT the
// stacking level, so a caller applies EXACTLY ONE z utility on top (never two conflicting z-* classes
// on one element — Tailwind resolves same-property collisions by CSS source order, not class order,
// so stacking z-[110] and z-[250] would be a coin-flip). Motion-free (no pop-in) by contract.
export const OPAQUE_SURFACE_BASE =
  "isolate bg-elevated opacity-100 border border-border shadow-2xl shadow-black/40"

// The selector-surface contract for Select, DropdownMenu, and the profile grid: the opaque base at
// z-[110]. The desktop queue/sidebar is intentionally a z-[100] sticky layer, and portal content
// mounts at document.body, so it must establish a higher paint layer or an open selector is visibly
// and interactively hidden beneath queue rows where the two overlap.
export const OPAQUE_PORTAL_SURFACE_CLASS = `z-[110] ${OPAQUE_SURFACE_BASE}`

// The z-index for ANCHORED transient overlays that pop off a trigger — tooltips and popovers. They
// must clear EVERY persistent app layer they can overlap: the sidebar/board rail (z-[100]), the opaque
// selector surface (z-[110]), and the modal Dialog (z-[200], so a popover opened from inside a dialog
// still shows). It sits just below the restart scrim (z-[300]), which alone must cover the whole app.
// This is the fix for the quota popover that used to render at z-50 — beneath the sidebar and the
// composer, so it was clipped away or hidden "underneath the prompt box".
export const OVERLAY_Z_CLASS = "z-[250]"
