/*
 * 日ごとの選定（selection.json の adopt）を集計し、curation.yaml のルールにしてよさそうなものを提案する。
 * 採用・不採用は人間がプレビューで決めた結果なので、続けて不採用になるジャンル・投稿者は弱め、
 * 続けて採用される投稿者は強める、という提案になる。
 */

/**
 * days: [{ date, items: [{ key, genre, genreLabel, authorKey, authorName, adopt }] }]（候補一覧に出た候補ごと）
 * 返り値: ジャンル・投稿者ごとの { shown（候補一覧に出た回数）, adopted, days（出た日数） }
 */
export function aggregate(days) {
  const genres = new Map()
  const authors = new Map()
  const add = (map, id, extra, item, date) => {
    const s = map.get(id) ?? { id, ...extra, shown: 0, adopted: 0, dates: new Set() }
    s.shown++
    if (item.adopt) s.adopted++
    s.dates.add(date)
    map.set(id, s)
  }
  for (const { date, items } of days) {
    for (const i of items) {
      add(genres, i.genre, { label: i.genreLabel }, i, date)
      add(authors, i.authorKey, { name: i.authorName }, i, date)
    }
  }
  const out = (map) => [...map.values()].map(({ dates, ...s }) => ({ ...s, days: dates.size }))
  return { genres: out(genres), authors: out(authors) }
}

/**
 * ルールの提案。minDays 日以上出て一度も採用されないジャンル・投稿者は弱める／ブロック、
 * minDays 日以上採用された投稿者は強める。すでにルールがある対象は出さない
 */
export function suggest({ genres, authors }, { minDays = 3, hasRule = () => false } = {}) {
  const out = []
  for (const g of genres) {
    if (g.days >= minDays && g.adopted === 0 && !hasRule(`genre:${g.id}`)) {
      out.push({ target: `genre:${g.id}`, action: "weight", weight: 0.5, why: `${g.days}日・${g.shown}件出て採用 0件（${g.label}）` })
    }
  }
  for (const a of authors) {
    // Steam のように1つの投稿者にまとまるソースは、投稿者単位で見ても意味がない
    if (a.id === "steam:steam" || hasRule(`author:${a.id}`)) continue
    if (a.days >= minDays && a.adopted === 0) {
      out.push({ target: `author:${a.id}`, action: "block", why: `${a.days}日・${a.shown}件出て採用 0件（${a.name}）` })
    } else if (a.adopted >= minDays && a.adopted === a.shown) {
      out.push({ target: `author:${a.id}`, action: "weight", weight: 2, why: `${a.shown}件出てすべて採用（${a.name}）` })
    }
  }
  return out
}
