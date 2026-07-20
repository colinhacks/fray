import type { BoardSnapshot, ThreadView } from "@fray-ui/shared"

export type ThreadRouteResolution =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "found"; ownership: "owned" | "foreign" | "legacy"; thread: ThreadView }

// A routed slug has three honest phases. Until the first authoritative board arrives it is loading,
// not an empty chat. Once authoritative, absence is an explicit not-found state. A present row keeps
// its ownership classification so foreign/legacy deep links can never inherit an owned Terminal.
export function resolveThreadRoute(board: BoardSnapshot | null, slug: string): ThreadRouteResolution {
  if (!board) return { kind: "loading" }
  const thread = board.threads.find((candidate) => candidate.id === slug)
  if (!thread) return { kind: "missing" }
  const ownership = thread.kind !== "session" ? "legacy" : thread.foreign === true ? "foreign" : "owned"
  return { kind: "found", ownership, thread }
}
