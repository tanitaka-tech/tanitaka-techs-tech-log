import { hoursBetween } from "./date.mjs"
import { countDrop } from "./drops.mjs"
import { velocity, xEngagement } from "./score.mjs"
import { politeFetch } from "./http.mjs"

const API = "https://api.x.com/2"

export async function xGet(path, params, token) {
  const url = new URL(`${API}${path}`)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v))
  }
  const res = await politeFetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`X API ${res.status} ${path}: ${JSON.stringify(body).slice(0, 500)}`)
  }
  return body
}

const USER_FIELDS = "username,name,protected,profile_image_url,public_metrics,verified_type"

/**
 * 投稿が載せてよい条件を満たさない理由を返す。満たすなら null。
 * oldest より前の投稿は期間外（通常は対象期間の始まり。sampleRetweets では maxPostAgeHours）
 */
function ineligibleReason(t, user, genre, config, now, oldest) {
  const xc = config.x
  if (!user || user.protected || t.possibly_sensitive) return "非公開・センシティブ"
  const publishedAt = new Date(t.created_at)
  if (publishedAt < oldest) return "期間外"
  if (hoursBetween(publishedAt, now) < xc.minAgeHours) return "投稿直後"
  if (t.public_metrics.like_count < (genre.minLikes ?? xc.minLikes)) return "いいね不足"
  if ((user.public_metrics?.followers_count ?? 0) < (genre.minFollowers ?? xc.minFollowers ?? 0)) return "フォロワー不足"
  // 企業・団体の認証アカウント（business）は告知・宣伝が多いので、ジャンルによっては除く
  if (genre.excludeVerifiedTypes?.includes(user.verified_type)) return "企業アカウント"
  if (genre.exclude && new RegExp(genre.exclude, "im").test(`${t.text}\n${user.username}\n${user.name}`)) return "除外語"
  return null
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
export async function searchXGenre(genre, window, config, token, budget, now = new Date(), share = Infinity, drops = {}) {
  if (genre.sampleRetweets) return sampleRetweetedPosts(genre, window, config, token, budget, now, share, drops)
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
    .filter((t) => {
      const reason = ineligibleReason(t, users.get(t.author_id), genre, config, now, window.start)
      countDrop(drops, reason)
      return !reason
    })
    .map((t) => toXCandidate(t, users.get(t.author_id), genre, now))
}

/** 添付メディアの種類（photo / video / animated_gif）が mediaTypes に含まれるか。mediaTypes がなければ問わない */
function hasMediaType(t, media, mediaTypes) {
  if (!mediaTypes) return true
  return (t.attachments?.media_keys ?? []).some((k) => mediaTypes.includes(media.get(k)?.type))
}

/**
 * 人気の投稿を、リツイートを読んで拾う（sampleRetweets: true のジャンル）。
 * X の検索はいいね数順に並べられないが、リツイートを時間で区切って読むと、よくリツイートされている
 * 投稿ほど多く現れる。
 * - 新しい順に読むだけだと実行直前の数分ぶんしか見られないので、対象期間を sampleSlices 個の区間に分け、
 *   区間ごとに終わり際のリツイートを読む。何度も現れる投稿は、一日を通してリツイートされている
 * - 人気の投稿は数日かけて広まるので、リツイートが対象期間内なら、元の投稿は maxPostAgeHours 時間前まで許す
 *   （前日の記事に載せたものは review で自動的に外れる）
 * リツイート元は expansions で本文・いいね数ごと取れるので、追加の読み取りは要らない。
 * リツイート元も読み取りに数えて budget から引く。
 */
async function sampleRetweetedPosts(genre, window, config, token, budget, now, share, drops) {
  const limit = Math.min(genre.maxReads ?? config.x.maxResultsPerQuery, budget.remaining, share)
  // リツイートとリツイート元の両方を数えるので、読むリツイートは上限の半分まで。1回の検索は10件以上
  const maxRetweets = Math.floor(limit / 2)
  const slices = Math.min(genre.sampleSlices ?? 6, Math.floor(maxRetweets / 10))
  if (slices < 1) {
    console.warn(`[x] 読み取り上限に達したため ${genre.id} をスキップ`)
    return []
  }
  const perSlice = Math.min(100, Math.floor(maxRetweets / slices))
  const span = (window.end - window.start) / slices

  const retweets = []
  const originals = new Map()
  const users = new Map()
  const media = new Map()
  for (let i = 0; i < slices; i++) {
    const end = new Date(window.end.getTime() - span * i)
    const body = await xGet(
      "/tweets/search/recent",
      {
        query: `${genre.query} is:retweet ${config.x.retweetBaseQuery ?? "lang:ja"}`,
        start_time: new Date(end.getTime() - span).toISOString(),
        end_time: end.toISOString(),
        max_results: perSlice,
        sort_order: "recency",
        "tweet.fields": "created_at,public_metrics,possibly_sensitive,author_id,referenced_tweets,attachments",
        expansions: "referenced_tweets.id,referenced_tweets.id.author_id,referenced_tweets.id.attachments.media_keys",
        "media.fields": "type",
        "user.fields": USER_FIELDS,
      },
      token,
    )
    const page = body.data ?? []
    const pageOriginals = body.includes?.tweets ?? []
    budget.remaining -= page.length + pageOriginals.length
    retweets.push(...page)
    for (const t of pageOriginals) originals.set(t.id, t)
    for (const u of body.includes?.users ?? []) users.set(u.id, u)
    for (const m of body.includes?.media ?? []) media.set(m.media_key, m)
  }

  // 同じ投稿が何回リツイートされていたか（読んだ範囲での人気の目安）
  const sampled = new Map()
  for (const rt of retweets) {
    const id = rt.referenced_tweets?.find((r) => r.type === "retweeted")?.id
    if (id) sampled.set(id, (sampled.get(id) ?? 0) + 1)
  }
  const oldest = new Date(now.getTime() - (genre.maxPostAgeHours ?? 72) * 60 * 60 * 1000)
  const found = []
  for (const id of sampled.keys()) {
    const t = originals.get(id)
    if (!t) {
      countDrop(drops, "元の投稿が取れない")
      continue
    }
    if (!hasMediaType(t, media, genre.mediaTypes)) {
      countDrop(drops, "メディアの種類")
      continue
    }
    const user = users.get(t.author_id)
    const reason = ineligibleReason(t, user, genre, config, now, oldest)
    if (reason) {
      countDrop(drops, reason)
      continue
    }
    const c = toXCandidate(t, user, genre, now)
    c.metrics = { ...c.metrics, sampled_retweets: sampled.get(id) }
    // 複数の区間で現れた投稿（一日を通してリツイートされている投稿）を少し上げる
    c.score *= Math.sqrt(sampled.get(id))
    found.push(c)
  }
  console.log(
    `[x] ${genre.id}: ${slices}区間でリツイート ${retweets.length}件からリツイート元 ${sampled.size}件（条件に合う投稿: ${found.length}件）`,
  )
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
