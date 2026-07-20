import assert from "node:assert/strict"
import test from "node:test"
import { PROMPT_CONTROL_TYPOGRAPHY_CLASS } from "./promptControlTypography.ts"

test("prompt control typography has one non-responsive selected-value scale", () => {
  assert.equal(PROMPT_CONTROL_TYPOGRAPHY_CLASS, "prompt-control-type petite-caps")
  assert.doesNotMatch(PROMPT_CONTROL_TYPOGRAPHY_CLASS, /(?:text-|leading-|scale|sm:|md:|lg:)/)
})
