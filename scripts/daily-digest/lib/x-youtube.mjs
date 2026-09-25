/*
 * X で共有された YouTube 動画を集める。
 * 再生数の絶対値ではなく「何人が X で貼ったか」で並べるので、海外の大型コンテンツより
 * 日本のオタク界隈で話題になっている曲・動画が上がりやすい。
 *
 * 投稿の取り方は2通り:
 *   - query:  検索（/tweets/search/recent）。界隈の広い反応を拾う
 *   - listId: X リストのタイムライン（/lists/:id/tweets）。好みのアカウントだけを見る
 */
import { hoursBetween } from "./date.mjs"
import { xGet } from "./x.mjs"
import { fetchVideos, hasKana, isEmbeddable, toYoutubeCandidate, youtubeVideoId } from "./youtube.mjs"

const TWEET_PARAMS = {
  "tweet.fields": "created_at,public_metrics,author_id,entities,possibly_sensitive",
  expansions: "author_id",
  "user.fields": "username,name,protected",
}

/** 検索結果をページ送りしながら limit 件まで読む */
async function searchPosts(genre, window, config, token, limit) {
  const posts = []
  const users = new Map()
  let next
  while (limit - posts.length >= 10) {
    const body = await xGet(
      "/tweets/search/recent",
      {
        query: `${genre.query} ${genre.baseQuery ?? config.x.baseQuery}`,
        start_time: window.start.toISOString(),
        end_time: window.end.toISOString(),
        max_results: Math.min(100, limit - posts.length),
        sort_order: "relevancy",
        next_token: next,
        ...TWEET_PARAMS,
      },
      token,
    )
    posts.push(...(body.data ?? []))
    for (const u of body.includes?.users ?? []) users.set(u.id, u)
    next = body.meta?.next_token
    if (!next) break
  }
  return { posts, users }
}

/** リストのタイムライン（新しい順）を、対象日より古い投稿が出てくるか limit 件に達するまで読む */
async function listPosts(genre, window, token, limit) {
  const posts = []
  const users = new Map()
  let next
  while (limit - posts.length >= 1) {
    const body = await xGet(
      `/lists/${genre.listId}/tweets`,
      { max_results: Math.min(100, limit - posts.length), pagination_token: next, ...TWEET_PARAMS },
      token,
    )
    const page = body.data ?? []
    posts.push(...page)
    for (const u of body.includes?.users ?? []) users.set(u.id, u)
    next = body.meta?.next_token
    const oldest = page.at(-1)
    if (!next || !oldest || new Date(oldest.created_at) < window.start) break
  }
  return { posts, users }
}

/** 動画IDごとに、共有したアカウント（重複なし）とその投稿のいいね数を集計する */
export function aggregateShares(posts, users, window) {
  const byVideo = new Map()
  for (const t of posts) {
    const user = users.get(t.author_id)
    if (!user || user.protected || t.possibly_sensitive) continue
    const at = new Date(t.created_at)
    if (at < window.start || at > window.end) continue
    const ids = new Set(
      (t.entities?.urls ?? []).map((u) => youtubeVideoId(u.unwound_url ?? u.expanded_url ?? "")).filter(Boolean),
    )
    for (const id of ids) {
      const sharers = byVideo.get(id) ?? new Map()
      // 同じ人が何度貼っても1人として数え、いいね数は一番伸びた投稿のものを使う
      const likes = t.public_metrics?.like_count ?? 0
      const prev = sharers.get(user.id)
      if (!prev || prev.likes < likes) sharers.set(user.id, { handle: user.username, likes, tweetId: t.id })
      byVideo.set(id, sharers)
    }
  }
  return byVideo
}

/** 共有者数を主に、いいね数の合計を同数のときの差として使う */
export function shareScore(sharers) {
  const list = sharers instanceof Map ? [...sharers.values()] : sharers
  const totalLikes = list.reduce((sum, s) => sum + s.likes, 0)
  return list.length + Math.log10(1 + totalLikes) / 10
}

export async function collectXYoutubeGenre(genre, window, config, { xToken, ytKey }, budget, now = new Date(), share = Infinity) {
  const limit = Math.min(genre.maxReads ?? config.x.maxResultsPerQuery, budget.remaining, share)
  if (genre.listId !== undefined && !genre.listId) {
    console.warn(`[x] ${genre.id}: listId が未設定なのでスキップ`)
    return []
  }
  if (limit < 10) {
    console.warn(`[x] 読み取り上限に達したため ${genre.id} をスキップ`)
    return []
  }

  const { posts, users } = genre.listId
    ? await listPosts(genre, window, xToken, limit)
    : await searchPosts(genre, window, config, xToken, limit)
  budget.remaining -= posts.length

  const byVideo = aggregateShares(posts, users, window)
  const minSharers = genre.minSharers ?? 1
  const ids = [...byVideo].filter(([, s]) => s.size >= minSharers).map(([id]) => id)
  console.log(`[x] ${genre.id}: ${posts.length}件の投稿から動画 ${byVideo.size}本（${minSharers}人以上の共有: ${ids.length}本）`)
  if (ids.length === 0) return []

  const maxAgeDays = genre.maxVideoAgeDays ?? 7
  const requireKana = genre.requireKana ?? config.youtube.requireKana
  const videos = await fetchVideos(ids, ytKey)
  return videos
    .filter(isEmbeddable)
    .filter((v) => !requireKana || hasKana(v))
    .filter((v) => hoursBetween(new Date(v.snippet.publishedAt), now) <= maxAgeDays * 24)
    .map((v) => {
      const sharers = byVideo.get(v.id)
      const c = toYoutubeCandidate(v, genre, now)
      c.metrics.sharers = sharers.size
      // 共有者の id を残しておき、curation.yaml の ignore-sharer で後から除けるようにする
      c.sharers = [...sharers]
        .map(([id, s]) => ({ id, ...s }))
        .sort((a, b) => b.likes - a.likes)
      c.sharedBy = c.sharers.map((s) => `@${s.handle}`)
      c.score = shareScore(sharers)
      return c
    })
}
