import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { TRANSCRIPT_META_LABEL_CLASS } from "../lib/transcriptMetaLabels.ts"

test("collapsed tool counts and thought events share one metadata-label rhythm", () => {
  assert.equal(TRANSCRIPT_META_LABEL_CLASS, "petite-caps text-[12px] leading-[18px] text-muted/55")

  const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
  const toolClass = source.match(/className=\{`\$\{TRANSCRIPT_META_LABEL_CLASS\}([^`]*)`\}/)?.[1]
  assert.ok(toolClass, "collapsed tool-count button must consume the shared metadata-label class")
  assert.doesNotMatch(toolClass, /(?:text-\[|leading-|text-muted\/)/, "tool-count button must not override the shared type rhythm")
  assert.match(source, /className=\{TRANSCRIPT_META_LABEL_CLASS\}>\{text\}<\/div>/)
  assert.match(source, /<ChevronRight[^>]*className=\{`relative -top-px shrink-0 transition-transform/)
})

test("codex reasoning toggle is a peer of the other metadata labels", () => {
  const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
  const block = source.match(/function ReasoningBlock[\s\S]*?\n}/)?.[0]
  assert.ok(block, "ReasoningBlock must exist")
  // Same petite-caps whisper as "N tool calls" / "Thought for Ns" — not a bespoke uppercase treatment.
  assert.match(block, /className=\{`\$\{TRANSCRIPT_META_LABEL_CLASS\}[^`]*self-start/, "reasoning toggle must consume the shared metadata-label class")
  assert.doesNotMatch(block, /uppercase|tracking-wide|text-\[12px\]|text-muted\/\d/, "reasoning toggle must not reintroduce a bespoke label type/color")
})
