/*
 * Misskey の人気ノート（notes/featured）を集める。API キー不要。
 * Misskey の埋め込みページは他のサイトの iframe に表示できない（X-Frame-Options: SAMEORIGIN）ので、
 * 記事では本文・画像・投稿者を使った自前のカードで表示する。
 */
import { hoursBetween } from "./date.mjs"
import { filterWithReasons } from "./drops.mjs"
import { velocity } from "./score.mjs"

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)",
  "Content-Type": "application/json",
}

async function misskeyPost(host, endpoint, body) {
  const res = await fetch(`https://${host}/api/${endpoint}`, { method: "POST", headers: HEADERS, body: JSON.stringify(body) })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Misskey ${res.status} ${host}/api/${endpoint}: ${json.error?.message ?? ""}`)
  return json
}

const reactionCount = (n) => n.reactionCount ?? Object.values(n.reactions ?? {}).reduce((a, b) => a + b, 0)

export function toMisskeyCandidate(n, genre, host, now = new Date()) {
  const publishedAt = new Date(n.createdAt)
  const images = (n.files ?? []).filter((f) => f.type?.startsWith("image/"))
  return {
    key: `misskey:${n.id}`,
    source: "misskey",
    id: n.id,
    host,
    genre: genre.id,
    genreLabel: genre.label,
    url: `https://${host}/notes/${n.id}`,
    title: "",
    thumbnail: images[0]?.thumbnailUrl ?? images[0]?.url,
    // 自前のカードに出す画像（最大4枚）。クリックで元の大きさで見られるよう、縮小版ではなく元の画像
    images: images.slice(0, 4).map((f) => f.url),
    text: (n.text ?? "").slice(0, 400),
    author: {
      id: n.user.id,
      name: n.user.name || n.user.username,
      handle: n.user.username,
      avatar: n.user.avatarUrl,
    },
    publishedAt: publishedAt.toISOString(),
    metrics: { reactions: reactionCount(n), renotes: n.renoteCount ?? 0, replies: n.repliesCount ?? 0 },
    score: velocity(reactionCount(n) + (n.renoteCount ?? 0) * 2, publishedAt, now),
  }
}

/** 人気ノートのうち、対象期間の、センシティブでないノートを集める */
export async function searchMisskeyGenre(genre, window, now = new Date(), drops = {}) {
  const host = genre.host ?? "misskey.io"
  const notes = await misskeyPost(host, "notes/featured", { limit: genre.limit ?? 100 })
  const exclude = genre.exclude && new RegExp(genre.exclude, "im")
  const kept = filterWithReasons(
    notes,
    [
      ["公開範囲", (n) => n.visibility === "public" && !n.localOnly],
      // cw（注意書き付き）とセンシティブ指定のファイルは、閲覧注意の内容なので除く
      ["センシティブ", (n) => !n.cw && !(n.files ?? []).some((f) => f.isSensitive)],
      ["画像なし", (n) => !genre.requireImages || (n.files ?? []).some((f) => f.type?.startsWith("image/"))],
      ["除外語", (n) => !exclude || !exclude.test(`${n.text ?? ""}\n${n.user.username}\n${n.user.name ?? ""}`)],
      ["期間外", (n) => new Date(n.createdAt) >= window.start && hoursBetween(new Date(n.createdAt), now) >= 0],
      ["リアクション不足", (n) => reactionCount(n) >= (genre.minReactions ?? 0)],
    ],
    drops,
  )
  console.log(`[misskey] ${genre.id}: 人気ノート ${notes.length}件から ${kept.length}件`)
  return kept.map((n) => toMisskeyCandidate(n, genre, host, now))
}

/** 削除されたノートの ID を返す（notes/show がエラーになるもの） */
export async function findUnavailableNotes(ids, host = "misskey.io") {
  const missing = []
  for (const id of ids) {
    const res = await fetch(`https://${host}/api/notes/show`, { method: "POST", headers: HEADERS, body: JSON.stringify({ noteId: id }) })
    if (res.status === 400 || res.status === 404) missing.push(id)
    else if (!res.ok) throw new Error(`Misskey ${res.status} notes/show`)
  }
  return missing
}
