import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { assignNumbers, buildReview, resolveKey, runReview } from "../lib/review.mjs"
import { makeCandidate, makeCtx } from "./helpers.mjs"

describe("buildReview", () => {
  it("登録チャンネルの候補は通常ジャンルの件数上限を受けない", () => {
    const ctx = makeCtx({
      candidatesPerGenre: 2,
      genres: [
        { id: "subscribed-videos", label: "登録チャンネル", source: "youtube-subscriptions" },
        { id: "mv", label: "音楽・MV", source: "youtube" },
      ],
    })
    const cs = [
      ...Array.from({ length: 12 }, (_, i) => makeCandidate({ id: `sub-${i}`, genre: "subscribed-videos", genreLabel: "登録チャンネル", origin: "subscriptions", score: i })),
      ...Array.from({ length: 12 }, (_, i) => makeCandidate({ id: `normal-${i}`, genre: "mv", score: i })),
    ]
    const entries = buildReview(ctx, cs, { rules: [], usedKeys: new Set() })
    assert.equal(entries.filter((e) => e.c.genre === "subscribed-videos" && e.shortlisted).length, 12)
    assert.equal(entries.filter((e) => e.c.genre === "mv" && e.shortlisted).length, 2)
  })

  it("ジャンルごとに上位だけを候補一覧に入れ、pin は別枠で入れる", () => {
    const ctx = makeCtx({ candidatesPerGenre: 2 })
    const cs = [1, 2, 3, 4].map((score) => makeCandidate({ score, id: `v${score}` }))
    const rules = [{ match: { key: "youtube:v1" }, action: "pin", reason: "推し", added: "2026-09-26" }]
    const entries = buildReview(ctx, cs, { rules, usedKeys: new Set() })
    const shortlisted = entries.filter((e) => e.shortlisted).map((e) => e.c.id)
    assert.deepEqual(shortlisted.sort(), ["v1", "v3", "v4"])
  })

  it("掲載済みとブロックしたものは除外の理由を付ける", () => {
    const ctx = makeCtx()
    const cs = [makeCandidate({ id: "used" }), makeCandidate({ id: "blocked" })]
    const rules = [{ match: { key: "youtube:blocked" }, action: "block", reason: "不要", added: "2026-09-26" }]
    const entries = buildReview(ctx, cs, { rules, usedKeys: new Set(["youtube:used"]) })
    const byId = Object.fromEntries(entries.map((e) => [e.c.id, e.excluded]))
    assert.deepEqual(byId, { used: "掲載済み", blocked: "block: 不要" })
  })

  it("カテゴリ → step → スコアの順に並べ、保存済みの表示名は今の設定に合わせる", () => {
    const ctx = makeCtx()
    const cs = [
      makeCandidate({ id: "ai", source: "hatena", genre: "hatena-ai", genreLabel: "古い名前", score: 100 }),
      makeCandidate({ id: "mv", genre: "mv", score: 50 }),
      makeCandidate({ id: "voc1", genre: "vocaloid", score: 1 }),
      makeCandidate({ id: "voc2", genre: "vocaloid", score: 2 }),
    ]
    const entries = buildReview(ctx, cs, { rules: [], usedKeys: new Set() })
    assert.deepEqual(
      entries.map((e) => e.c.id),
      ["voc2", "voc1", "mv", "ai"],
    )
    assert.equal(entries.at(-1).c.genreLabel, "最新技術")
  })

  it("同じキーが複数のジャンルにあればスコアの高い方だけ残す", () => {
    const ctx = makeCtx()
    const cs = [makeCandidate({ id: "same", genre: "vocaloid", score: 1 }), makeCandidate({ id: "same", genre: "mv", score: 5 })]
    const entries = buildReview(ctx, cs, { rules: [], usedKeys: new Set() })
    assert.equal(entries.length, 1)
    assert.equal(entries[0].c.genre, "mv")
  })
})

describe("assignNumbers", () => {
  it("振った番号は変えず、新しい候補に続きの番号を振る。候補一覧に入ったものから振る", () => {
    const e = (key, shortlisted, excluded) => ({ c: { key }, shortlisted, excluded })
    const entries = [e("a", false), e("b", true), e("c", true), e("d", false, "掲載済み")]
    const numbers = assignNumbers(entries, { c: 5 })
    assert.deepEqual(numbers, { c: 5, b: 6, a: 7 })
    assert.equal(entries[3].no, undefined)
  })
})

describe("resolveKey", () => {
  it("#番号・番号をキーにし、キーはそのまま返す", () => {
    const numbers = { "youtube:a": 3 }
    assert.equal(resolveKey("#3", numbers), "youtube:a")
    assert.equal(resolveKey("3", numbers), "youtube:a")
    assert.equal(resolveKey("steam:1", numbers), "steam:1")
    assert.throws(() => resolveKey("#4", numbers), /#4/)
  })
})

it("候補一覧に登録チャンネル由来の印を残す", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "digest-review-subscriptions-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const ctx = makeCtx({ genres: [{ id: "subscribed-tech", label: "最新技術", source: "youtube-subscriptions" }] })
  ctx.config.article.dir = path.join(dir, "posts")
  ctx.paths = Object.fromEntries(["candidates", "selection", "numbers", "shortlist", "collect"].map((name) => [name, path.join(dir, `${name}.json`)]))
  fs.writeFileSync(ctx.paths.candidates, JSON.stringify([makeCandidate({ id: "subscription-origin", genre: "subscribed-tech", genreLabel: "最新技術", origin: "subscriptions" })]))
  runReview(ctx)
  const shortlist = JSON.parse(fs.readFileSync(ctx.paths.shortlist, "utf8"))
  assert.equal(shortlist[0].origin, "subscriptions")
})
