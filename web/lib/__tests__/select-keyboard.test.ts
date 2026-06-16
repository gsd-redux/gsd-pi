import assert from "node:assert/strict"
import test from "node:test"

import {
  clampSelectIndex,
  getSingleSelectKeyAction,
  numberKeyToSelectIndex,
} from "../select-keyboard.ts"

test("numberKeyToSelectIndex maps visible option numbers to zero-based indexes", () => {
  assert.equal(numberKeyToSelectIndex("1", 3), 0)
  assert.equal(numberKeyToSelectIndex("2", 3), 1)
  assert.equal(numberKeyToSelectIndex("3", 3), 2)
})

test("numberKeyToSelectIndex ignores unavailable and non-number keys", () => {
  assert.equal(numberKeyToSelectIndex("4", 3), null)
  assert.equal(numberKeyToSelectIndex("0", 3), null)
  assert.equal(numberKeyToSelectIndex("a", 3), null)
  assert.equal(numberKeyToSelectIndex("1", 0), null)
})

test("getSingleSelectKeyAction moves within option bounds", () => {
  assert.deepEqual(getSingleSelectKeyAction("2", 0, 3), { type: "select", index: 1 })
  assert.deepEqual(getSingleSelectKeyAction("ArrowUp", 0, 3), { type: "select", index: 0 })
  assert.deepEqual(getSingleSelectKeyAction("ArrowDown", 0, 3), { type: "select", index: 1 })
  assert.deepEqual(getSingleSelectKeyAction("End", 0, 3), { type: "select", index: 2 })
  assert.deepEqual(getSingleSelectKeyAction("Home", 2, 3), { type: "select", index: 0 })
})

test("getSingleSelectKeyAction submits the active option on Enter or Space", () => {
  assert.deepEqual(getSingleSelectKeyAction("Enter", 2, 3), { type: "submit", index: 2 })
  assert.deepEqual(getSingleSelectKeyAction(" ", 1, 3), { type: "submit", index: 1 })
})

test("clampSelectIndex returns -1 when there are no options", () => {
  assert.equal(clampSelectIndex(0, 0), -1)
})
