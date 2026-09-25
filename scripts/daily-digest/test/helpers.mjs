/** テスト用の設定・候補を作る */

export function makeCtx({ genres, categoryOrder, candidatesPerGenre = 10, maxItemsPerCategory = 4, maxItemsByCategory = {} } = {}) {
  const gs = genres ?? [
    { id: "vocaloid", label: "音楽・MV", step: "ボカロ", source: "youtube" },
    { id: "mv", label: "音楽・MV", step: "MV", source: "youtube" },
    { id: "hatena-ai", label: "最新技術", source: "hatena" },
    { id: "bluesky-illust", label: "イラスト", source: "bluesky" },
  ]
  const config = {
    genres: gs,
    review: { candidatesPerGenre },
    article: {
      categoryOrder: categoryOrder ?? [...new Set(gs.map((g) => g.label))],
      maxItems: 40,
      minItems: 1,
      maxItemsPerCategory,
      maxItemsByCategory,
      category: "デイリーダイジェスト",
      tags: ["自動生成"],
    },
  }
  return {
    config,
    date: "2026-09-26",
    genreById: new Map(gs.map((g) => [g.id, g])),
    stepOrder: [...new Set(gs.map((g) => g.step).filter(Boolean))],
    categoryLimit: (label) => maxItemsByCategory[label] ?? maxItemsPerCategory,
  }
}

let seq = 0

/** 候補1件。source ごとに埋め込みに要る項目を埋める */
export function makeCandidate({ source = "youtube", genre = "vocaloid", genreLabel = "音楽・MV", score = 1, ...rest } = {}) {
  const id = rest.id ?? `id${++seq}`
  return {
    key: `${source}:${id}`,
    source,
    id,
    genre,
    genreLabel,
    url: `https://example.com/${id}`,
    title: `タイトル ${id}`,
    text: "",
    author: { id: `author-${id}`, name: `作者 ${id}`, handle: `handle${id}` },
    publishedAt: "2026-09-26T00:00:00.000Z",
    metrics: {},
    score,
    ...rest,
  }
}
