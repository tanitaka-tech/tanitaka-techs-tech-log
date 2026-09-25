/*
 * 候補一覧（shortlist）のすべてを入れた selection.json の下書きを作る。
 * おすすめ（adopt: true）はカテゴリの上限と記事全体の上限に収まるように機械的に選び、それ以外は adopt: false にする。
 * Claude はこの下書きに note（注意）とおすすめの入れ替え、タイトル・説明を書き足すだけでよい。
 */

/**
 * カテゴリの中からおすすめを選ぶ。ソースが違うとスコアの単位が違うので、
 * step（なければジャンル）ごとの列からスコア順に1件ずつ順番に取り、偏らないようにする。pin した候補は先に取る
 */
function pickInCategory(list, limit) {
  const lanes = new Map()
  for (const c of list) {
    const lane = c.step ?? c.genre
    if (!lanes.has(lane)) lanes.set(lane, [])
    lanes.get(lane).push(c)
  }
  const queues = [...lanes.values()].map((l) => [...l].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.score - a.score))
  const picked = []
  for (const c of list.filter((c) => c.pinned)) if (picked.length < limit) picked.push(c)
  while (picked.length < limit && queues.some((q) => q.length)) {
    for (const q of queues) {
      while (q.length && picked.includes(q[0])) q.shift()
      const c = q.shift()
      if (c && picked.length < limit) picked.push(c)
    }
  }
  return picked
}

/**
 * shortlist: shortlist.json の中身（review の表示順）
 * previous:  保存済みの selection.json。あれば、書いてある項目の note・adopt・並び、タイトル・説明はそのまま残し、
 *            まだない候補を adopt: false で足す
 */
export function draftSelection(shortlist, { maxItems, categoryLimit, previous = null, resolve = (k) => k }) {
  if (previous) {
    const have = new Set((previous.items ?? []).map((i) => resolve(i.key)))
    const added = shortlist.filter((c) => !have.has(c.key)).map((c) => ({ key: `#${c.no}`, note: "", adopt: false }))
    return { selection: { ...previous, items: [...(previous.items ?? []), ...added] }, added: added.length }
  }

  const byCategory = new Map()
  for (const c of shortlist) {
    if (!byCategory.has(c.genreLabel)) byCategory.set(c.genreLabel, [])
    byCategory.get(c.genreLabel).push(c)
  }
  const picks = new Map([...byCategory].map(([label, list]) => [label, pickInCategory(list, categoryLimit(label))]))
  // 記事全体の上限を超えたら、おすすめの多いカテゴリの、選んだ順で最後の候補から外す
  let total = [...picks.values()].reduce((n, l) => n + l.length, 0)
  while (total > maxItems) {
    const [, most] = [...picks].sort((a, b) => b[1].length - a[1].length)[0]
    most.pop()
    total--
  }
  const adopted = new Set([...picks.values()].flat().map((c) => c.key))
  const items = shortlist.map((c) => ({ key: `#${c.no}`, note: "", adopt: adopted.has(c.key) }))
  // 記事のサムネイルには画像のある項目を使う（X・Bluesky・pixiv の項目は記事の画像にならない）
  const top = shortlist.find((c) => adopted.has(c.key) && ["youtube", "soundcloud", "steam", "hatena"].includes(c.source))
  return {
    selection: { topic: "", topicKey: top ? `#${top.no}` : "", description: "", items },
    added: items.length,
  }
}
