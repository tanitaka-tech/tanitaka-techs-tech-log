import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { aggregate, suggest } from "../lib/stats.mjs"

const item = (genre, authorKey, adopt) => ({ key: `${authorKey}-${Math.random()}`, genre, genreLabel: genre, authorKey, authorName: authorKey, adopt })

describe("stats", () => {
  const days = ["2026-09-24", "2026-09-25", "2026-09-26"].map((date) => ({
    date,
    items: [item("dead", "youtube:spam", false), item("good", "youtube:fav", true), item("good", "steam:steam", false)],
  }))

  it("ジャンル・投稿者ごとに出た件数・採用・日数を数える", () => {
    const { genres } = aggregate(days)
    assert.deepEqual(genres.find((g) => g.id === "good"), { id: "good", label: "good", shown: 6, adopted: 3, days: 3 })
  })

  it("続けて採用されないものは弱める・ブロック、すべて採用された投稿者は強める。ルールがあれば出さない", () => {
    const s = suggest(aggregate(days), { minDays: 3 })
    assert.deepEqual(
      s.map((x) => `${x.action} ${x.target}`),
      ["weight genre:dead", "block author:youtube:spam", "weight author:youtube:fav"],
    )
    const without = suggest(aggregate(days), { minDays: 3, hasRule: (t) => t === "genre:dead" })
    assert.ok(!without.some((x) => x.target === "genre:dead"))
  })
})
