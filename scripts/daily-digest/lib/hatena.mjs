/*
 * はてなブックマークの人気エントリー（カテゴリ別の RSS）から、ニュース・記事を集める。
 * API キー不要。ブックマーク数が多いほど話題になっている記事として扱う。
 * 記事はリンクカード（タイトル・サイト名・はてなのエントリー画像）で載せる。
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
  for (const category of genre.categories ?? ["it"]) {
    for (const e of await fetchHotentries(category)) byUrl.set(e.url, e)
  }
  // 大文字小文字は区別する（i を付けると「AI」が EXPLAIN などの英単語の途中にも当たる）。
  // カテゴリ名（dc:subject の「アニメとゲーム」など）は全記事に付くので、判定には使わない
  const include = genre.include && new RegExp(genre.include)
  const exclude = genre.exclude && new RegExp(genre.exclude)
  const text = (e) => `${e.title}\n${e.description}`
  const entries = filterWithReasons(
    [...byUrl.values()],
    [
      ["ジャンル外", (e) => !include || include.test(text(e))],
      ["除外語", (e) => !exclude || !exclude.test(text(e))],
      ["古い記事", (e) => hoursBetween(new Date(e.date), now) <= (genre.maxAgeHours ?? 48)],
      ["ブックマーク不足", (e) => e.bookmarks >= (genre.minBookmarks ?? 20)],
    ],
    drops,
  )
  console.log(`[hatena] ${genre.id}: ${byUrl.size}件の人気エントリーから ${entries.length}件`)
  const candidates = []
  for (const e of entries) candidates.push(toHatenaCandidate(e, genre, now, await fetchOgImage(e.url)))
  return candidates
}
