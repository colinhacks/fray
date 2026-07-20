import type { SubAgentView } from "@fray-ui/shared"
import { runningOperations } from "./operationIndicators.ts"

export function runningQueueSubAgents(subAgents: readonly SubAgentView[]): readonly SubAgentView[] {
  return runningOperations(subAgents)
}
