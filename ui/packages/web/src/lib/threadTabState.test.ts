import assert from "node:assert/strict"
import test from "node:test"
import {
  clampThreadTab,
  parseThreadTab,
  readThreadTab,
  resolveThreadTabCapabilities,
  threadTabStorageKey,
  writeThreadTab,
} from "./threadTabState.ts"

test("parseThreadTab accepts only the remaining thread surfaces and degrades legacy terminal values", () => {
  assert.equal(parseThreadTab("chat"), "chat")
  assert.equal(parseThreadTab("terminal"), null)
  assert.equal(parseThreadTab("scratch"), "scratch")
  assert.equal(parseThreadTab(""), null)
  assert.equal(parseThreadTab("settings"), null)
  assert.equal(parseThreadTab(null), null)
})

test("thread tab storage is scoped to both the project and thread slug", () => {
  assert.equal(threadTabStorageKey("/work/nub", "fix-ci"), "fray-thread-tab:%2Fwork%2Fnub:fix-ci")
  assert.notEqual(threadTabStorageKey("/work/nub", "fix-ci"), threadTabStorageKey("/work/fray", "fix-ci"))
})

test("clampThreadTab refuses surfaces the current row cannot own", () => {
  const owned = { scratch: true }
  assert.equal(clampThreadTab("scratch", owned), "scratch")
  assert.equal(clampThreadTab("scratch", { scratch: false }), "chat", "rows without a scratchpad cannot inherit Doc")
  assert.equal(clampThreadTab("bogus", owned), "chat")
})

test("thread tab capabilities survive only a transient gap in the same project+slug scope", () => {
  const owned = { scratch: true }
  const first = resolveThreadTabCapabilities("/repo\0thread", owned, undefined)
  assert.equal(first.authoritative, true)
  assert.deepEqual(first.capabilities, owned)

  const transient = resolveThreadTabCapabilities("/repo\0thread", undefined, first.remembered)
  assert.equal(transient.authoritative, false)
  assert.deepEqual(transient.capabilities, owned, "a missing delta must not unmount an active owned Terminal")

  const foreign = resolveThreadTabCapabilities("/repo\0thread", { scratch: false }, first.remembered)
  assert.equal(foreign.authoritative, true)
  assert.deepEqual(foreign.capabilities, { scratch: false }, "a concrete foreign row revokes Doc")

  const otherProject = resolveThreadTabCapabilities("/other\0thread", undefined, first.remembered)
  assert.deepEqual(otherProject.capabilities, { scratch: false }, "capabilities never cross project/slug scope")
})

test("legacy terminal intent degrades to Chat", () => {
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  })

  const project = "/work/nub"
  const slug = "merge-pr"
  sessionStorage.setItem(threadTabStorageKey(project, slug), "terminal")
  const requested = readThreadTab(project, slug)
  assert.equal(requested, "chat")

  const owned = resolveThreadTabCapabilities(`${project}\0${slug}`, { scratch: false }, undefined)
  const missing = resolveThreadTabCapabilities(`${project}\0${slug}`, undefined, owned.remembered)
  assert.equal(clampThreadTab(requested, missing.capabilities), "chat")
  assert.equal(clampThreadTab(requested, { scratch: false }), "chat", "foreign and legacy rows render Chat")
  assert.equal(readThreadTab(project, slug), "chat")

  writeThreadTab(project, slug, "chat")
  assert.equal(readThreadTab(project, slug), "chat", "an explicit Chat selection is persisted")
  assert.equal(readThreadTab("/work/fray", slug), "chat", "another project never inherits this project's request")
})
