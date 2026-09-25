import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { listItemsByFile, loadUsedKeys, removeItems, renderArticle } from "../lib/render.mjs"
import { makeCandidate, makeCtx } from "./helpers.mjs"

function article({ review = null, keepOrder = false, items, candidates, topicKey } = {}) {
  const ctx = makeCtx()
  const cs =
    candidates ??
    [
      makeCandidate({ id: "v1", genre: "vocaloid", step: "ボカロ", score: 1 }),
      makeCandidate({ id: "m1", genre: "mv", step: "MV", score: 9 }),
      makeCandidate({ id: "h1", source: "hatena", genre: "hatena-ai", genreLabel: "最新技術", thumbnail: "https://example.com/og.png" }),
    ]
  return renderArticle({
    date: "2026-09-26",
    selection: {
      topic: "見出し",
      topicKey: topicKey ?? cs[0].key,
      description: "説明",
      items: items ?? cs.map((c) => ({ key: c.key, note: "", adopt: true })),
    },
    candidatesByKey: new Map(cs.map((c) => [c.key, c])),
    category: ctx.config.article.category,
    fixedTags: ctx.config.article.tags,
    categoryOrder: ctx.config.article.categoryOrder,
    stepOrder: ctx.stepOrder,
    review,
    keepOrder,
  })
}

describe("renderArticle", () => {
  it("frontmatter に日付入りのタイトル・カテゴリのタグ・サムネイルを書く", () => {
    const md = article()
    assert.match(md, /^title: "見出し 2026-09-26"$/m)
    assert.match(md, /^tags: \["自動生成","デイリーダイジェスト","音楽・MV","最新技術"\]$/m)
    assert.match(md, /^image: "https:\/\/i\.ytimg\.com\/vi\/v1\/hqdefault\.jpg"$/m)
  })

  it("step の順に並べ、keepOrder なら selection の順のまま", () => {
    const order = (md) => [...md.matchAll(/<!-- digest-item (\S+) -->/g)].map((m) => m[1])
    // step の順（ボカロ → MV）
    assert.deepEqual(order(article()), ["youtube:v1", "youtube:m1", "hatena:h1"])
    const cs = [makeCandidate({ id: "m1", genre: "mv", step: "MV" }), makeCandidate({ id: "v1", genre: "vocaloid", step: "ボカロ" })]
    assert.deepEqual(order(article({ candidates: cs, keepOrder: true })), ["youtube:m1", "youtube:v1"])
  })

  it("プレビューにだけ警告・note・採用の印を出す", () => {
    const cs = [makeCandidate({ id: "v1" })]
    const items = [{ key: "youtube:v1", note: "要確認", adopt: false }]
    const preview = article({ candidates: cs, items, review: ["警告A"] })
    assert.match(preview, /digest-review-banner/)
    assert.match(preview, /<li>警告A<\/li>/)
    assert.match(preview, /⚠️ 要確認/)
    assert.match(preview, /data-adopt="false"/)
    const final = article({ candidates: cs, items })
    assert.doesNotMatch(final, /digest-review|data-adopt|要確認/)
  })

  it("タイトルなどの HTML を逃がす", () => {
    const cs = [makeCandidate({ id: "v1", title: '<b>"x"</b>' })]
    const md = article({ candidates: cs })
    assert.match(md, /&lt;b&gt;&quot;x&quot;&lt;\/b&gt;/)
    assert.doesNotMatch(md, /<b>"x"/)
  })
})

describe("掲載済みの項目の読み取りと削除", () => {
  it("記事ごとのキーを読み、消した項目だけのカテゴリは見出しごと消す", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "digest-"))
    fs.writeFileSync(path.join(dir, "2026-09-25.md"), article())
    fs.writeFileSync(path.join(dir, "2026-09-26.md"), article({ candidates: [makeCandidate({ id: "x9" })] }))

    assert.deepEqual([...loadUsedKeys(dir, { exclude: ["2026-09-26.md"] })], ["youtube:v1", "youtube:m1", "hatena:h1"])
    const file = path.join(dir, "2026-09-25.md")
    assert.equal(removeItems(file, new Set(["hatena:h1"])), 1)
    const text = fs.readFileSync(file, "utf8")
    assert.doesNotMatch(text, /## 最新技術/)
    assert.match(text, /## 音楽・MV/)
    assert.deepEqual(listItemsByFile(dir).find((f) => f.file === file).keys, ["youtube:v1", "youtube:m1"])
  })
})
