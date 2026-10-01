import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { draftSelection } from "../lib/draft.mjs"
import { mockSelect } from "../lib/llm.mjs"

let no = 0
const c = (genreLabel, lane, score, extra = {}) => ({ no: ++no, key: `youtube:${no}`, source: "youtube", genreLabel, genre: lane, score, ...extra })

describe("draftSelection", () => {
  it("すべての候補を入れ、おすすめはカテゴリの上限まで、列（step・ジャンル）を順番に回して選ぶ", () => {
    const list = [c("音楽", "a", 100), c("音楽", "a", 90), c("音楽", "a", 80), c("音楽", "b", 1), c("技術", "t", 5)]
    const { selection } = draftSelection(list, { maxItems: 10, categoryLimit: (l) => (l === "音楽" ? 3 : 1) })
    assert.equal(selection.items.length, 5)
    const adopted = selection.items.filter((i) => i.adopt).map((i) => i.key)
    // a の上位2件と、スコアの単位が違う b の1件
    assert.deepEqual(adopted, [`#${list[0].no}`, `#${list[1].no}`, `#${list[3].no}`, `#${list[4].no}`])
    assert.equal(selection.topic, "")
  })

  it("pin した候補を先に選び、記事全体の上限を超えたら多いカテゴリから外す", () => {
    const list = [c("音楽", "a", 100), c("音楽", "a", 1, { pinned: true }), c("音楽", "a", 50), c("技術", "t", 5)]
    const { selection } = draftSelection(list, { maxItems: 2, categoryLimit: () => 3 })
    const adopted = selection.items.filter((i) => i.adopt).map((i) => i.key)
    assert.deepEqual(adopted, [`#${list[1].no}`, `#${list[3].no}`])
  })

  it("登録チャンネルはカテゴリと記事の上限を消費せず、通常候補の後に追加する", () => {
    const list = [c("音楽", "a", 100), c("音楽", "subscribed-music", 2, { origin: "subscriptions" }), c("音楽", "subscribed-music", 1, { origin: "subscriptions" })]
    const { selection } = draftSelection(list, { maxItems: 1, categoryLimit: () => 1 })
    assert.deepEqual(selection.items.filter((i) => i.adopt).map((i) => i.key), list.map((v) => `#${v.no}`))
    const previous = { topic: "既存", items: [{ key: list[0].key, note: "", adopt: true }] }
    const updated = draftSelection(list, { maxItems: 1, categoryLimit: () => 1, previous })
    assert.ok(updated.selection.items.slice(1).every((i) => i.adopt))
  })

  it("保存済みの選定があれば、note・adopt・タイトルを残して、まだない候補を不採用で足す", () => {
    const list = [c("音楽", "a", 1), c("音楽", "a", 2)]
    const previous = { topic: "見出し", items: [{ key: list[0].key, note: "要確認", adopt: true }] }
    const { selection, added } = draftSelection(list, { maxItems: 10, categoryLimit: () => 3, previous })
    assert.equal(added, 1)
    assert.equal(selection.topic, "見出し")
    assert.deepEqual(selection.items, [
      { key: list[0].key, note: "要確認", adopt: true },
      { key: `#${list[1].no}`, note: "", adopt: false },
    ])
  })
})

it("mock 選定でも登録チャンネルは通常の件数上限に含めない", () => {
  const list = [c("音楽", "a", 100), c("音楽", "subscribed-music", 2, { origin: "subscriptions" }), c("音楽", "subscribed-music", 1, { origin: "subscriptions" })]
  const selection = mockSelect(list, { maxItems: 1, categoryLimit: () => 1 })
  assert.deepEqual(selection.items.map((i) => i.key), list.map((v) => v.key))
})
