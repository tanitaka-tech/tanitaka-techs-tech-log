import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { findDuplicates, normalize } from "../lib/duplicates.mjs"
import { makeCandidate } from "./helpers.mjs"

describe("findDuplicates", () => {
  it("名前のイベント告知・記号・大文字小文字の違いを無視する", () => {
    assert.equal(normalize("NONNKI @9/26-27 大阪メルメリィマーケット"), "nonnki")
    assert.equal(normalize("えびら【C-15】"), "えびら")
    assert.equal(normalize("Pastel (feat. うらる)"), "pastel")
  })

  it("同じカテゴリで、ソースが違い、投稿者名かタイトルが同じものを組にする", () => {
    const pixiv = makeCandidate({ source: "pixiv", genreLabel: "イラスト", author: { name: "えびら" } })
    const bsky = makeCandidate({ source: "bluesky", genreLabel: "イラスト", title: "", author: { name: "えびら@新刊" } })
    const steam = makeCandidate({ source: "steam", genreLabel: "最新ゲーム", title: "ドレスメーカー", author: { name: "Steam" } })
    const news = makeCandidate({ source: "hatena", genreLabel: "最新ゲーム", title: "『ドレスメーカー』が発売", author: { name: "automaton-media.com" } })
    // 同じソース・違うカテゴリは組にしない
    const pixiv2 = makeCandidate({ source: "pixiv", genreLabel: "イラスト", author: { name: "えびら" } })
    const other = makeCandidate({ source: "misskey", genreLabel: "風景写真", title: "", author: { name: "えびら" } })
    const d = findDuplicates([pixiv, bsky, steam, news, pixiv2, other])
    assert.deepEqual(d.get(bsky.key), [pixiv.key, pixiv2.key])
    assert.deepEqual(d.get(steam.key), [news.key])
    assert.equal(d.get(other.key), undefined)
  })
})
