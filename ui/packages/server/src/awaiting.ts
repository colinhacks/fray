import { createHash } from "node:crypto"
import { isValidAwaitingTimer, isValidGithubReviewTarget, type AwaitingHint } from "@fray-ui/shared"

export interface PrRef {
  owner: string
  repo: string
  number: number
}

const PR_REF_RE = /(?:https?:\/\/github\.com\/)?([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*?)(?:\/pull\/|\/pulls\/|#)(\d+)/

export function parsePrRef(value: string): PrRef | undefined {
  if (!isValidGithubReviewTarget(value)) return undefined
  const match = value.trim().match(PR_REF_RE)
  if (!match) return undefined
  const number = Number.parseInt(match[3], 10)
  if (!Number.isFinite(number) || number <= 0) return undefined
  return { owner: match[1], repo: match[2].replace(/\.git$/, ""), number }
}

export function prRefKey(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`
}

export function isActionableAwaitingHint(hint: AwaitingHint | undefined): hint is AwaitingHint {
  if (!hint) return false
  if (hint.kind === "timer") return isValidAwaitingTimer(hint.value)
  return parsePrRef(hint.value) !== undefined
}

export function awaitingFenceIdentity(hint: AwaitingHint, fenceAt: string): string {
  return createHash("sha256")
    .update(fenceAt)
    .update("\0")
    .update(hint.kind)
    .update("\0")
    .update(hint.value)
    .digest("hex")
}
