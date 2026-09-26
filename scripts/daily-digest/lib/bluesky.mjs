/*
 * Bluesky の投稿を、人気順の検索（app.bsky.feed.searchPosts の sort=top）で集める。
 * 今のところアカウントなしで使える（public.api.bsky.app は 403 を返すので api.bsky.app を使う）。
 * 記事では Bluesky 公式の埋め込み（embed.bsky.app）で表示する。
 */
import { hoursBetween } from "./date.mjs"
import { filterWithReasons } from "./drops.mjs"
import { velocity } from "./score.mjs"
import { politeFetch } from "./http.mjs"

const API = "https://api.bsky.app/xrpc"
// 性的・暴力的な内容に付くラベル。投稿か投稿者に付いていれば除く
const SENSITIVE_LABELS = new Set(["porn", "sexual", "nudity", "graphic-media", "gore", "!warn"])

async function bskyGet(path, params) {
  const url = new URL(`${API}/${path}`)
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v))
  const res = await politeFetch(url)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Bluesky API ${res.status} ${path}: ${body.message ?? ""}`)
  return body
}

/** at://did/app.bsky.feed.post/rkey から「did/rkey」（記事のキーに使う ID）を作る */
export function blueskyId(uri) {
  const [, did, , rkey] = uri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/) ?? []
  return did && rkey ? `${did}/${rkey}` : null
}

// 投稿者が「ログインしていない人・外部サイトには表示しない」と設定している（埋め込みも表示されない）
const refusesExternal = (p) => (p.author?.labels ?? []).some((l) => l.val === "!no-unauthenticated")
const hasSensitiveLabel = (p) => [...(p.labels ?? []), ...(p.author?.labels ?? [])].some((l) => SENSITIVE_LABELS.has(l.val))
const imageCount = (p) => p.embed?.images?.length ?? p.embed?.media?.images?.length ?? 0

export function toBlueskyCandidate(p, genre, now = new Date()) {
  const publishedAt = new Date(p.record?.createdAt ?? p.indexedAt)
  const [did, rkey] = blueskyId(p.uri).split("/")
  const image = p.embed?.images?.[0] ?? p.embed?.media?.images?.[0]
  const engagement = (p.likeCount ?? 0) + (p.repostCount ?? 0) * 2 + (p.quoteCount ?? 0) * 2
  return {
    key: `bluesky:${did}/${rkey}`,
    source: "bluesky",
    id: `${did}/${rkey}`,
    // 公式の埋め込みに要る値
    uri: p.uri,
    cid: p.cid,
    genre: genre.id,
    genreLabel: genre.label,
    url: `https://bsky.app/profile/${p.author.handle}/post/${rkey}`,
    title: "",
    thumbnail: image?.thumb,
    text: (p.record?.text ?? "").slice(0, 400),
    author: { id: did, name: p.author.displayName || p.author.handle, handle: p.author.handle, avatar: p.author.avatar },
    publishedAt: publishedAt.toISOString(),
    metrics: { likes: p.likeCount ?? 0, reposts: p.repostCount ?? 0, replies: p.replyCount ?? 0 },
    score: velocity(engagement, publishedAt, now),
  }
}

/**
 * ジャンルの queries を人気順で検索し、対象期間（window）の投稿を集める。
 * exclude は本文・投稿者名に対する正規表現（AI 絵のタグなど）
 */
export async function searchBlueskyGenre(genre, window, now = new Date(), drops = {}) {
  const byUri = new Map()
  for (const query of genre.queries ?? []) {
    // q に # を含めると 400 になるので、ハッシュタグは tag で絞る（q は空にできないので同じ語を入れる）
    const tag = query.startsWith("#") ? query.slice(1) : undefined
    const body = await bskyGet("app.bsky.feed.searchPosts", {
      q: tag ?? query,
      tag,
      sort: "top",
      // lang: any なら言語で絞らない（海外の写真など）
      lang: genre.lang === "any" ? undefined : (genre.lang ?? "ja"),
      since: window.start.toISOString(),
      until: window.end.toISOString(),
      limit: genre.limit ?? 50,
    })
    for (const p of body.posts ?? []) byUri.set(p.uri, p)
  }
  const exclude = genre.exclude && new RegExp(genre.exclude, "im")
  const posts = filterWithReasons(
    [...byUri.values()],
    [
      ["外部表示を拒否", (p) => !refusesExternal(p)],
      ["センシティブ", (p) => !hasSensitiveLabel(p)],
      ["画像なし", (p) => !genre.requireImages || imageCount(p) > 0],
      ["除外語", (p) => !exclude || !exclude.test(`${p.record?.text ?? ""}\n${p.author.handle}\n${p.author.displayName ?? ""}`)],
      ["いいね不足", (p) => (p.likeCount ?? 0) >= (genre.minLikes ?? 0)],
      ["期間外", (p) => hoursBetween(new Date(p.record?.createdAt ?? p.indexedAt), now) <= (genre.maxAgeHours ?? 24)],
    ],
    drops,
  )
  console.log(`[bluesky] ${genre.id}: ${genre.queries?.length ?? 0}回の検索で ${byUri.size}件（条件に合う投稿: ${posts.length}件）`)
  return posts.map((p) => toBlueskyCandidate(p, genre, now))
}

/** 削除された投稿の ID（did/rkey）を返す */
export async function findUnavailableBlueskyPosts(ids) {
  const missing = []
  for (let i = 0; i < ids.length; i += 25) {
    const chunk = ids.slice(i, i + 25)
    const uris = chunk.map((id) => {
      const [did, rkey] = id.split("/")
      return `at://${did}/app.bsky.feed.post/${rkey}`
    })
    const url = new URL(`${API}/app.bsky.feed.getPosts`)
    for (const u of uris) url.searchParams.append("uris", u)
    const res = await politeFetch(url)
    if (!res.ok) throw new Error(`Bluesky API ${res.status} getPosts`)
    const found = new Set(((await res.json()).posts ?? []).map((p) => blueskyId(p.uri)))
    for (const id of chunk) if (!found.has(id)) missing.push(id)
  }
  return missing
}
