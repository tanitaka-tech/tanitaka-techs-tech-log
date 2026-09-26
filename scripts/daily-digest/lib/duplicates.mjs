/*
 * ソースをまたいで同じもの（同じ絵が pixiv と Bluesky に、同じゲームが Steam とはてなの記事に、など）らしい候補を見つける。
 * キーはソースごとに違うので、投稿者名とタイトルの近さで判定する。外しはせず、review とプレビューに印を出して人間が決める。
 */

/** 比べるための名前・タイトル。記号・空白・絵文字、イベントの告知（「@9/26 大阪…」「【C-15】」）などを落とす */
export function normalize(s) {
  return (s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[@＠].*$/, "")
    .replace(/[【［\[（(].*?[】］\])）]/g, "")
    .replace(/\b(feat|ft)\.?.*$/, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
}

/** タイトルのない投稿（Bluesky・Misskey）は本文の先頭がハッシュタグなどで似やすいので、タイトルでは比べない */
const titleOf = (c) => normalize(c.title)

/**
 * candidates のうち、同じカテゴリで、ソースが違い、次のどれかに当たる組を返す（キー → 重複かもしれない相手のキー）。
 *   - 投稿者名が同じ（3文字以上）
 *   - タイトルが同じ（4文字以上）
 *   - 一方のタイトルが他方のタイトルに含まれる（短い方が4文字以上。「ゲーム名」と「ゲーム名が発売」など）
 */
export function findDuplicates(candidates) {
  const out = new Map()
  const link = (a, b) => {
    for (const [x, y] of [
      [a, b],
      [b, a],
    ]) {
      if (!out.has(x.key)) out.set(x.key, [])
      if (!out.get(x.key).includes(y.key)) out.get(x.key).push(y.key)
    }
  }
  const info = candidates.map((c) => ({ c, author: normalize(c.author?.name), title: titleOf(c) }))
  for (let i = 0; i < info.length; i++) {
    for (let j = i + 1; j < info.length; j++) {
      const a = info[i]
      const b = info[j]
      if (a.c.source === b.c.source || a.c.genreLabel !== b.c.genreLabel) continue
      const sameAuthor = a.author.length >= 3 && a.author === b.author
      const [short, long] = a.title.length <= b.title.length ? [a.title, b.title] : [b.title, a.title]
      const sameTitle = short.length >= 4 && long.includes(short)
      if (sameAuthor || sameTitle) link(a.c, b.c)
    }
  }
  return out
}
