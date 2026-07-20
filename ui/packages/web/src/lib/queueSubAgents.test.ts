import assert from "node:assert/strict"
import test from "node:test"
import type { SubAgentView } from "@fray-ui/shared"
import { runningQueueSubAgents } from "./queueSubAgents.ts"

const agents: SubAgentView[] = [
  { id: "live", label: "Verify queue behavior", startedAt: "2026-07-13T10:00:00.000Z", state: "running" },
  { id: "stale", label: "Old investigation", startedAt: "2026-07-13T09:00:00.000Z", state: "stale" },
]

test("queue sub-agent lines include only children still running", () => {
  assert.deepEqual(runningQueueSubAgents(agents), [agents[0]])
  assert.deepEqual(runningQueueSubAgents([]), [])
})
