/*
 * はてなブックマークと、各サイトの RSS からニュース・記事を集める。API キー不要。
 *   categories: 人気エントリー（カテゴリ別の RSS）
 *   tags:       タグ検索の RSS（そのタグが付いた記事。ツール名など、人気エントリーに入りにくい話題向け）
 *   feeds:      各サイトの RSS / Atom（公式ブログ・ニュースサイト）。人気の目安にブックマーク数を数え直す
 * ブックマーク数の伸び率で並べ、記事の og:image を使ったリンクカードで載せる。
 */
import { createHash } from "node:crypto"
import { hoursBetween } from "./date.mjs"
import { filterWithReasons } from "./drops.mjs"

const HEADERS = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)" }

/** RSS の文字参照（&#x3042; など）を戻す */
function decode(s) {
  return (s ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

const tag = (xml, name) => xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]

/** カテゴリ（it / game / knowledge など）の人気エントリーを読む */
export async function fetchHotentries(category) {
  const res = await fetch(`https://b.hatena.ne.jp/hotentry/${category}.rss`, { headers: HEADERS })
  if (!res.ok) throw new Error(`はてなブックマーク ${res.status} hotentry/${category}`)
  const xml = await res.text()
  return [...xml.matchAll(/<item [\s\S]*?<\/item>/g)].map(([item]) => ({
    url: decode(tag(item, "link")),
    title: decode(tag(item, "title")),
    description: decode(tag(item, "description")),
    date: tag(item, "dc:date"),
    bookmarks: Number(tag(item, "hatena:bookmarkcount") ?? 0),
    subjects: [...item.matchAll(/<dc:subject>([\s\S]*?)<\/dc:subject>/g)].map((m) => decode(m[1])),
  }))
}

/** 記事ページの og:image（リンクカードの画像）を読む。取れなければ undefined */
export async function fetchOgImage(url) {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) })
    if (!res.ok) return undefined
    const html = (await res.text()).slice(0, 300_000)
    const m =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ??
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
    return m ? new URL(decode(m[1]), url).href : undefined
  } catch {
    return undefined
  }
}

/** タグ検索の RSS（新しい順、ブックマーク minUsers 以上）を読む */
export async function fetchTagEntries(tagName, minUsers = 3) {
  const url = `https://b.hatena.ne.jp/q/${encodeURIComponent(tagName)}?target=tag&sort=recent&users=${minUsers}&safe=on&mode=rss`
  const res = await fetch(url, { headers: HEADERS })
  if (!res.ok) throw new Error(`はてなブックマーク ${res.status} タグ検索 ${tagName}`)
  const xml = await res.text()
  return [...xml.matchAll(/<item [\s\S]*?<\/item>/g)].map(([item]) => ({
    url: decode(tag(item, "link")),
    title: decode(tag(item, "title")),
    description: decode(tag(item, "description")),
    date: tag(item, "dc:date"),
    bookmarks: Number(tag(item, "hatena:bookmarkcount") ?? 0),
    subjects: [],
  }))
}

/** サイトの RSS 1.0 / 2.0 / Atom を読む。ブックマーク数はあとで数える */
export async function fetchFeed(feedUrl) {
  const res = await fetch(feedUrl, { headers: HEADERS })
  if (!res.ok) throw new Error(`RSS ${res.status} ${feedUrl}`)
  const xml = await res.text()
  const text = (s) => decode((s ?? "").replace(/^<!\[CDATA\[|\]\]>$/g, "").replace(/<[^>]+>/g, "")).trim()
  return [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/g)].map(([item]) => ({
    url: decode(item.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? item.match(/<link[^>]*href="([^"]+)"/)?.[1] ?? "").trim(),
    title: text(item.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1]),
    description: text(item.match(/<(description|summary)[^>]*>([\s\S]*?)<\/\1>/)?.[2]).slice(0, 300),
    date: (item.match(/<(dc:date|pubDate|published|updated)>([\s\S]*?)<\//)?.[2] ?? "").trim(),
    bookmarks: 0,
    subjects: [],
  }))
}

/** 記事の URL ごとのブックマーク数（50件ずつ） */
export async function fetchBookmarkCounts(urls) {
  const counts = new Map()
  for (let i = 0; i < urls.length; i += 50) {
    const api = new URL("https://bookmark.hatenaapis.com/count/entries")
    for (const u of urls.slice(i, i + 50)) api.searchParams.append("url", u)
    const res = await fetch(api, { headers: HEADERS })
    if (!res.ok) throw new Error(`はてなブックマーク件数 API ${res.status}`)
    for (const [u, n] of Object.entries(await res.json())) counts.set(u, n)
  }
  return counts
}

/** URL から、記事のキーに使う短い ID を作る（URL をそのままキーにすると長く、記号も混ざるため） */
export function hatenaId(url) {
  return createHash("sha1").update(url).digest("hex").slice(0, 16)
}

export function toHatenaCandidate(e, genre, now = new Date(), image) {
  const publishedAt = new Date(e.date)
  const site = new URL(e.url).hostname.replace(/^www\./, "")
  return {
    key: `hatena:${hatenaId(e.url)}`,
    source: "hatena",
    id: hatenaId(e.url),
    genre: genre.id,
    genreLabel: genre.label,
    url: e.url,
    title: e.title,
    // 記事の og:image。はてなの entry/image はブックマーク数のバッジ画像なので使わない
    thumbnail: image,
    text: e.description.slice(0, 400),
    author: { id: site, name: site, handle: site },
    publishedAt: publishedAt.toISOString(),
    metrics: { bookmarks: e.bookmarks },
    // ブックマーク数の伸び率。最初のブックマークからの経過時間で割る
    score: e.bookmarks / Math.max(hoursBetween(publishedAt, now), 1),
  }
}

/**
 * ジャンルの categories の人気エントリーから、include（正規表現）に当たる記事を集める。
 * dc:date（最初にブックマークされた時刻）が maxAgeHours 時間以内のものだけ
 */
export async function searchHatenaGenre(genre, now = new Date(), drops = {}) {
  const byUrl = new Map()
  for (const category of genre.categories ?? []) {
    for (const e of await fetchHotentries(category)) byUrl.set(e.url, e)
  }
  // タグ検索で見つけた記事は、タグで話題が決まっているので include で絞らない
  for (const t of genre.tags ?? []) {
    for (const e of await fetchTagEntries(t, genre.minBookmarks ?? 3)) byUrl.set(e.url, { ...e, fromTag: true })
  }
  // サイトの RSS はブックマーク数を持たないので、件数 API で数える
  const fromFeeds = []
  for (const f of genre.feeds ?? []) {
    try {
      fromFeeds.push(...(await fetchFeed(f)))
    } catch (e) {
      console.warn(`[hatena] ${genre.id}: ${e.message}`)
    }
  }
  const counts = await fetchBookmarkCounts(fromFeeds.map((e) => e.url).filter(Boolean))
  for (const e of fromFeeds) if (e.url && !byUrl.has(e.url)) byUrl.set(e.url, { ...e, bookmarks: counts.get(e.url) ?? 0 })
  // 大文字小文字は区別する（i を付けると「AI」が EXPLAIN などの英単語の途中にも当たる）。
  // カテゴリ名（dc:subject の「アニメとゲーム」など）は全記事に付くので、判定には使わない
  const include = genre.include && new RegExp(genre.include)
  const exclude = genre.exclude && new RegExp(genre.exclude)
  const text = (e) => `${e.title}\n${e.description}`
  const entries = filterWithReasons(
    [...byUrl.values()],
    [
      ["ジャンル外", (e) => e.fromTag || !include || include.test(text(e))],
      ["除外語", (e) => !exclude || !exclude.test(text(e))],
      ["古い記事", (e) => e.date && hoursBetween(new Date(e.date), now) <= (genre.maxAgeHours ?? 48)],
      ["ブックマーク不足", (e) => e.bookmarks >= (genre.minBookmarks ?? 20)],
    ],
    drops,
  )
  console.log(`[hatena] ${genre.id}: ${byUrl.size}件の人気エントリーから ${entries.length}件`)
  const candidates = []
  for (const e of entries) candidates.push(toHatenaCandidate(e, genre, now, await fetchOgImage(e.url)))
  return candidates
}
