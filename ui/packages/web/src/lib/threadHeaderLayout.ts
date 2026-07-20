// Keep the drawer-header breakpoints in one importable contract: the sheet gets narrow well before
// the viewport does, so its title needs a second line for fixed controls at 640px, not 520px.
export const THREAD_HEADER_CLASS = "sticky top-0 z-10 flex min-w-0 shrink-0 items-center gap-2.5 border-b border-border bg-panel px-3 py-1.5 min-h-12 max-[640px]:flex-wrap max-[640px]:items-start max-[640px]:gap-y-2 max-[640px]:px-4 max-[640px]:py-2.5"
export const THREAD_HEADER_TITLE_CLASS = "min-w-0 flex-1 pl-1 max-[640px]:basis-full"
export const THREAD_HEADER_CONTROLS_CLASS = "flex shrink-0 items-center max-[640px]:w-full max-[640px]:justify-between"
