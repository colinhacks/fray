import type { BoardSnapshot } from "@fray-ui/shared"

export type SidebarPresence = {
  projectDir: string | null
  hasBeenVisible: boolean
}

// A board keyframe is a point-in-time transport snapshot, not a declaration that the workspace lost
// its navigation. In particular, a reconnect/rebuild can briefly report no Fray-owned rows while a
// live delta or the next keyframe repopulates them. Keep the desktop rail mounted after this project
// has had something to navigate; only a genuinely fresh project retains the centered first-task view.
export function nextSidebarPresence(
  previous: SidebarPresence,
  board: Pick<BoardSnapshot, "projectDir" | "threads" | "plans"> | null,
): SidebarPresence {
  if (!board) return previous
  const projectChanged = previous.projectDir !== board.projectDir
  const hasWorkspaceContent = board.threads.some((thread) => thread.foreign !== true) || (board.plans?.length ?? 0) > 0
  return {
    projectDir: board.projectDir,
    hasBeenVisible: projectChanged ? hasWorkspaceContent : previous.hasBeenVisible || hasWorkspaceContent,
  }
}
