import { hoursBetween } from "./date.mjs"
import { velocity, xEngagement } from "./score.mjs"

const API = "https://api.x.com/2"

export async function xGet(path, params, token) {
  const url = new URL(`${API}${path}`)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v))
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`X API ${res.status} ${path}: ${JSON.stringify(body).slice(0, 500)}`)
  }
  return body
}

/**
 * ジャンルのクエリで対象期間（window）の投稿を検索し、候補に変換する。
 * budget.remaining を超えて読み取らない（従量課金対策）。share はこのジャンルに割り当てた読み取り件数。
 */
export async function searchXGenre(genre, window, config, token, budget, now = new Date(), share = Infinity) {
  const xc = config.x
  const maxResults = Math.min(xc.maxResultsPerQuery, budget.remaining, share)
  if (maxResults < 10) {
    console.warn(`[x] 読み取り上限に達したため ${genre.id} をスキップ`)
    return []
  }

  const body = await xGet(
    "/tweets/search/recent",
    {
      query: `${genre.query} ${xc.baseQuery}`,
      start_time: window.start.toISOString(),
      end_time: window.end.toISOString(),
      max_results: maxResults,
      sort_order: "relevancy",
      "tweet.fields": "created_at,public_metrics,lang,possibly_sensitive,author_id",
      expansions: "author_id",
      "user.fields": "username,name,protected,profile_image_url",
    },
    token,
  )

  const tweets = body.data ?? []
  budget.remaining -= tweets.length
  const users = new Map((body.includes?.users ?? []).map((u) => [u.id, u]))
  const minLikes = genre.minLikes ?? xc.minLikes

  return tweets
    .map((t) => {
      const user = users.get(t.author_id)
      const publishedAt = new Date(t.created_at)
      return { t, user, publishedAt }
    })
    .filter(({ t, user, publishedAt }) => {
      if (!user || user.protected) return false
      if (t.possibly_sensitive) return false
      if (t.public_metrics.like_count < minLikes) return false
      if (publishedAt < window.start || publishedAt > window.end) return false
      return hoursBetween(publishedAt, now) >= xc.minAgeHours
    })
    .map(({ t, user, publishedAt }) => ({
      key: `x:${t.id}`,
      source: "x",
      id: t.id,
      genre: genre.id,
      genreLabel: genre.label,
      url: `https://x.com/${user.username}/status/${t.id}`,
      title: "",
      text: t.text,
      // handle は変更できるので、ルール（curation.yaml）には変わらない id を使う
      author: { id: user.id, name: user.name, handle: user.username, avatar: user.profile_image_url },
      publishedAt: publishedAt.toISOString(),
      metrics: t.public_metrics,
      score: velocity(xEngagement(t.public_metrics), publishedAt, now),
    }))
}

/**
 * 投稿IDの存在確認。削除・非公開・凍結などで取得できなかったIDを返す。
 */
export async function findUnavailableTweets(ids, token) {
  const missing = []
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const body = await xGet("/tweets", { ids: chunk.join(",") }, token)
    const found = new Set((body.data ?? []).map((t) => t.id))
    for (const id of chunk) {
      if (!found.has(id)) missing.push(id)
    }
  }
  return missing
}
