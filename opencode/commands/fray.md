---
description: Start or resume OpenCode fray orchestration
---

Load the `opencode-fray` skill, then reconcile returned tasks before doing new work.

Current fray board:

!`node .opencode/fray/index.mjs`

Validation:

!`node .opencode/fray/index.mjs --validate`

Use `.fray/` as the canonical tracker. Create or update the owning thread before dispatching sub-agents.
