import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { render } from "../commands/render.mjs"
import { listItemsByFile, loadUsedKeys, removeItems, renderArticle } from "../lib/render.mjs"
import { makeCandidate, makeCtx } from "./helpers.mjs"

function article({ review = null, keepOrder = false, items, candidates, topicKey, draft = true } = {}) {
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
    draft,
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

  it("記事末尾の出典には、掲載した項目のソースだけを出す", () => {
    assert.match(article(), /この記事は、はてなブックマーク・YouTubeの公開データ/)
  })

  it("og:image のないはてなの記事は画像なしのカードにする", () => {
    const cs = [makeCandidate({ id: "h2", source: "hatena", genre: "hatena-ai", genreLabel: "最新技術" })]
    const md = article({ candidates: cs })
    assert.match(md, /digest-link-card/)
    assert.doesNotMatch(md, /<img[^>]*src="undefined"/)
  })

  it("タイトルなどの HTML を逃がす", () => {
    const cs = [makeCandidate({ id: "v1", title: '<b>"x"</b>' })]
    const md = article({ candidates: cs })
    assert.match(md, /&lt;b&gt;&quot;x&quot;&lt;\/b&gt;/)
    assert.doesNotMatch(md, /<b>"x"/)
  })
})

describe("掲載済みの項目の読み取りと削除", () => {
  it("下書きは掲載済み判定・削除確認から除外し、draft のない既存記事は対象にする", (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "digest-"))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    fs.writeFileSync(path.join(dir, "draft.md"), article({ candidates: [makeCandidate({ id: "draft" })] }))
    fs.writeFileSync(path.join(dir, "public.md"), article({ draft: false, candidates: [makeCandidate({ id: "public" })] }))
    fs.writeFileSync(path.join(dir, "legacy.md"), article({ candidates: [makeCandidate({ id: "legacy" })] }).replace("draft: true\n", ""))
    assert.deepEqual([...loadUsedKeys(dir)].sort(), ["youtube:legacy", "youtube:public"])
    assert.deepEqual(listItemsByFile(dir).flatMap((f) => f.keys).sort(), ["youtube:legacy", "youtube:public"])
  })

  it("記事ごとのキーを読み、消した項目だけのカテゴリは見出しごと消す", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "digest-"))
    fs.writeFileSync(path.join(dir, "2026-09-25.md"), article({ draft: false }))
    fs.writeFileSync(path.join(dir, "2026-09-26.md"), article({ draft: false, candidates: [makeCandidate({ id: "x9" })] }))

    assert.deepEqual([...loadUsedKeys(dir, { exclude: ["2026-09-26.md"] })], ["youtube:v1", "youtube:m1", "hatena:h1"])
    const file = path.join(dir, "2026-09-25.md")
    assert.equal(removeItems(file, new Set(["hatena:h1"])), 1)
    const text = fs.readFileSync(file, "utf8")
    assert.doesNotMatch(text, /## 最新技術/)
    assert.match(text, /## 音楽・MV/)
    const listed = listItemsByFile(dir).find((f) => f.file === file)
    assert.deepEqual(listed.keys, ["youtube:v1", "youtube:m1"])
    assert.equal(listed.urls.get("youtube:v1"), "https://example.com/v1")
  })
})

describe("render の公開状態", () => {
  it("再生成・final 整形では下書きを維持し、公開時だけ採用項目を draft: false で出力する", (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "digest-render-"))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const ctx = makeCtx()
    ctx.config.article.dir = path.join(dir, "posts")
    ctx.articlePath = path.join(ctx.config.article.dir, `${ctx.date}.md`)
    ctx.paths = Object.fromEntries(["candidates", "selection", "numbers", "shortlist", "collect"].map((name) => [name, path.join(dir, `${name}.json`)]))
    const cs = [makeCandidate({ id: "draft-test-keep" }), makeCandidate({ id: "draft-test-skip" })]
    fs.writeFileSync(ctx.paths.candidates, JSON.stringify(cs))
    fs.writeFileSync(ctx.paths.selection, JSON.stringify({ topic: "下書きの検証", items: cs.map((c, i) => ({ key: c.key, adopt: i === 0 })) }))
    const read = () => fs.readFileSync(ctx.articlePath, "utf8")

    render(ctx)
    assert.match(read(), /^draft: true$/m)
    assert.match(read(), /digest-review-banner/)
    assert.match(read(), /<!-- digest-item youtube:draft-test-skip -->/)
    render(ctx)
    assert.match(read(), /^draft: true$/m)
    render(ctx, { final: true })
    assert.match(read(), /^draft: true$/m)
    assert.doesNotMatch(read(), /digest-review-banner|<!-- digest-item youtube:draft-test-skip -->/)
    render(ctx, { final: true, draft: false })
    assert.match(read(), /^draft: false$/m)
    assert.match(read(), /<!-- digest-item youtube:draft-test-keep -->/)
    assert.doesNotMatch(read(), /digest-review-banner|<!-- digest-item youtube:draft-test-skip -->/)
    assert.throws(() => render(ctx, { draft: false }), /final/)
  })
})
