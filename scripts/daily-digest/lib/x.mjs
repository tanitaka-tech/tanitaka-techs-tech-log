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

const USER_FIELDS = "username,name,protected,profile_image_url,public_metrics"

/** 投稿が載せてよい条件（公開アカウント・センシティブでない・いいね数・フォロワー数・期間）を満たすか */
function isEligible(t, user, genre, window, config, now) {
  const xc = config.x
  if (!user || user.protected || t.possibly_sensitive) return false
  if (t.public_metrics.like_count < (genre.minLikes ?? xc.minLikes)) return false
  if ((user.public_metrics?.followers_count ?? 0) < (genre.minFollowers ?? xc.minFollowers ?? 0)) return false
  if (genre.exclude && new RegExp(genre.exclude, "im").test(`${t.text}\n${user.username}\n${user.name}`)) return false
  const publishedAt = new Date(t.created_at)
  if (publishedAt < window.start || publishedAt > window.end) return false
  return hoursBetween(publishedAt, now) >= xc.minAgeHours
}

function toXCandidate(t, user, genre, now) {
  const publishedAt = new Date(t.created_at)
  return {
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
  }
}

/**
 * ジャンルのクエリで対象期間（window）の投稿を検索し、候補に変換する。
 * budget.remaining を超えて読み取らない（従量課金対策）。share はこのジャンルに割り当てた読み取り件数。
 */
export async function searchXGenre(genre, window, config, token, budget, now = new Date(), share = Infinity) {
  if (genre.sampleRetweets) return sampleRetweetedPosts(genre, window, config, token, budget, now, share)
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
      "user.fields": USER_FIELDS,
    },
    token,
  )

  const tweets = body.data ?? []
  budget.remaining -= tweets.length
  const users = new Map((body.includes?.users ?? []).map((u) => [u.id, u]))
  return tweets
    .filter((t) => isEligible(t, users.get(t.author_id), genre, window, config, now))
    .map((t) => toXCandidate(t, users.get(t.author_id), genre, now))
}

/**
 * 人気の投稿を、リツイートを新しい順に読んで拾う（sampleRetweets: true のジャンル）。
 * X の検索はいいね数順に並べられないが、リツイートを時間で区切って読むと、よくリツイートされている
 * 投稿ほど多く現れる。リツイート元は expansions で本文・いいね数ごと取れるので、追加の読み取りは要らない。
 * リツイート元も読み取りに数えて budget から引く。
 */
async function sampleRetweetedPosts(genre, window, config, token, budget, now, share) {
  const limit = Math.min(genre.maxReads ?? config.x.maxResultsPerQuery, budget.remaining, share)
  // リツイートとリツイート元の両方を数えるので、1回に読むリツイートは上限の半分まで
  const maxResults = Math.min(100, Math.floor(limit / 2))
  if (maxResults < 10) {
    console.warn(`[x] 読み取り上限に達したため ${genre.id} をスキップ`)
    return []
  }

  const body = await xGet(
    "/tweets/search/recent",
    {
      query: `${genre.query} is:retweet ${config.x.retweetBaseQuery ?? "lang:ja"}`,
      start_time: window.start.toISOString(),
      end_time: window.end.toISOString(),
      max_results: maxResults,
      sort_order: "recency",
      "tweet.fields": "created_at,public_metrics,possibly_sensitive,author_id,referenced_tweets,attachments",
      expansions: "referenced_tweets.id,referenced_tweets.id.author_id",
      "user.fields": USER_FIELDS,
    },
    token,
  )

  const retweets = body.data ?? []
  const originals = new Map((body.includes?.tweets ?? []).map((t) => [t.id, t]))
  budget.remaining -= retweets.length + originals.size
  const users = new Map((body.includes?.users ?? []).map((u) => [u.id, u]))

  // 同じ投稿が何回リツイートされていたか（読んだ範囲での人気の目安）
  const sampled = new Map()
  for (const rt of retweets) {
    const id = rt.referenced_tweets?.find((r) => r.type === "retweeted")?.id
    if (id) sampled.set(id, (sampled.get(id) ?? 0) + 1)
  }
  const found = [...sampled.keys()]
    .map((id) => originals.get(id))
    .filter((t) => t && (!genre.requireMedia || t.attachments?.media_keys?.length))
    .filter((t) => isEligible(t, users.get(t.author_id), genre, window, config, now))
    .map((t) => {
      const c = toXCandidate(t, users.get(t.author_id), genre, now)
      c.metrics = { ...c.metrics, sampled_retweets: sampled.get(t.id) }
      return c
    })
  console.log(`[x] ${genre.id}: リツイート ${retweets.length}件からリツイート元 ${sampled.size}件（条件に合う投稿: ${found.length}件）`)
  return found
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
