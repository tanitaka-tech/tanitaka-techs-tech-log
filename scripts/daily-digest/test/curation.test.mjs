import assert from "node:assert/strict"
import { describe, it } from "node:test"
import YAML from "yaml"
import { activeRules, addRule, applyRules, authorKey, describeRule, removeRules, validateRule } from "../lib/curation.mjs"
import { makeCandidate } from "./helpers.mjs"

const rule = (r) => ({ reason: "テスト", added: "2026-09-26", ...r })

describe("applyRules", () => {
  it("weight は当たったものをすべて掛け合わせる", () => {
    const c = makeCandidate({ score: 10, text: "新曲 #PR" })
    const rules = [
      rule({ match: { text: "#PR" }, action: "weight", weight: 0.5 }),
      rule({ match: { genre: "vocaloid" }, action: "weight", weight: 3 }),
    ]
    const r = applyRules(c, rules)
    assert.equal(r.weight, 1.5)
    assert.equal(r.c.score, 15)
    // 元の候補は変えない
    assert.equal(c.score, 10)
  })

  it("block は理由付きで外し、pin されていれば残す", () => {
    const c = makeCandidate()
    const block = rule({ match: { key: c.key }, action: "block", reason: "いらない" })
    assert.equal(applyRules(c, [block]).blocked, "block: いらない")
    const pinned = applyRules(c, [block, rule({ match: { author: authorKey(c) }, action: "pin" })])
    assert.equal(pinned.blocked, null)
    assert.equal(pinned.pinned, true)
  })

  it("text はタイトルと本文を大文字小文字を区別せずに見る", () => {
    const c = makeCandidate({ title: "Song (COVER)" })
    assert.ok(applyRules(c, [rule({ match: { text: "cover" }, action: "block" })]).blocked)
  })

  it("ignore-sharer は共有者を除いてスコアを計算し直す", () => {
    const c = makeCandidate({
      sharers: [
        { id: "1", handle: "a", likes: 0 },
        { id: "2", handle: "b", likes: 0 },
      ],
      metrics: { sharers: 2 },
    })
    const r = applyRules(c, [rule({ match: { sharer: "x:1" }, action: "ignore-sharer" })], { minSharers: 2 })
    assert.equal(r.c.metrics.sharers, 1)
    assert.deepEqual(r.c.sharedBy, ["@b"])
    assert.match(r.blocked, /共有者が 2 人未満/)
  })
})

describe("activeRules", () => {
  it("until を過ぎたルールを除く（当日は有効）", () => {
    const rules = [rule({ match: { genre: "a" }, action: "block", until: "2026-09-26" }), rule({ match: { genre: "b" }, action: "block", until: "2026-09-25" })]
    assert.deepEqual(
      activeRules(rules, "2026-09-26").map((r) => r.match.genre),
      ["a"],
    )
  })
})

describe("validateRule", () => {
  it("不正なルールを弾く", () => {
    assert.throws(() => validateRule(rule({ match: {}, action: "block" })), /match/)
    assert.throws(() => validateRule(rule({ match: { genre: "a" }, action: "weight" })), /weight/)
    assert.throws(() => validateRule(rule({ match: { text: "(" }, action: "block" })), /正規表現/)
    assert.throws(() => validateRule(rule({ match: { genre: "a" }, action: "ignore-sharer" })), /sharer/)
    assert.throws(() => validateRule({ match: { genre: "a" }, action: "block", added: "2026-09-26" }), /reason/)
  })
})

describe("addRule / removeRules", () => {
  it("YAML のコメントを残したまま足し引きできる", () => {
    const doc = YAML.parseDocument("# 説明\nrules:\n  - match:\n      genre: a\n    action: block\n    reason: x\n    added: 2026-09-26\n")
    addRule(doc, rule({ match: { genre: "b" }, action: "pin" }))
    const removed = removeRules(doc, (r) => r.match.genre === "a")
    assert.equal(removed.length, 1)
    assert.match(doc.toString(), /^# 説明/)
    assert.deepEqual(
      doc.toJS().rules.map((r) => describeRule(r)),
      ["pin(genre=b)"],
    )
  })
})
