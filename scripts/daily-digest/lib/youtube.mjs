import { velocity, youtubeEngagement } from "./score.mjs"

const API = "https://www.googleapis.com/youtube/v3"

async function ytGet(path, params, key) {
  const url = new URL(`${API}${path}`)
  for (const [k, v] of Object.entries({ ...params, key })) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v))
  }
  const res = await fetch(url)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    // エラーメッセージにキーが含まれないよう、URLは出さない
    throw new Error(`YouTube API ${res.status} ${path}: ${body.error?.message ?? ""}`)
  }
  return body
}

/** ids の動画情報を取得（50件ずつ） */
export async function fetchVideos(ids, key) {
  const items = []
  for (let i = 0; i < ids.length; i += 50) {
    const body = await ytGet(
      "/videos",
      { part: "snippet,statistics,status", id: ids.slice(i, i + 50).join(",") },
      key,
    )
    items.push(...(body.items ?? []))
  }
  return items
}

function bestThumbnail(t = {}) {
  return (t.maxres ?? t.standard ?? t.high ?? t.medium ?? t.default)?.url
}

// ひらがな・カタカナ（長音符を含む）。漢字だけだと中国語圏の動画も通ってしまうので仮名で判定する
const KANA_RE = /[\u3041-\u309f\u30a1-\u30ff]/

/** タイトルかチャンネル名に仮名が入っているか。海外の大型コンテンツを除いて日本の動画に寄せるため */
export function hasKana(v) {
  return KANA_RE.test(v.snippet?.title ?? "") || KANA_RE.test(v.snippet?.channelTitle ?? "")
}

export function isEmbeddable(v) {
  return v.status?.embeddable && v.status?.privacyStatus === "public"
}

/** YouTube の URL から動画IDを取り出す。動画以外（チャンネル・プレイリストなど）は null */
export function youtubeVideoId(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const host = u.hostname.replace(/^(www|m|music)\./, "")
  let id = null
  if (host === "youtu.be") {
    id = u.pathname.split("/")[1]
  } else if (host === "youtube.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v")
    else id = u.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/)?.[1]
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null
}

/** videos.list の結果を候補に変換する。score は再生数と高評価の伸び率 */
export function toYoutubeCandidate(v, genre, now = new Date()) {
  const publishedAt = new Date(v.snippet.publishedAt)
  return {
    key: `youtube:${v.id}`,
    source: "youtube",
    id: v.id,
    genre: genre.id,
    genreLabel: genre.label,
    url: `https://www.youtube.com/watch?v=${v.id}`,
    title: v.snippet.title,
    thumbnail: bestThumbnail(v.snippet.thumbnails),
    text: (v.snippet.description ?? "").slice(0, 400),
    author: { id: v.snippet.channelId, name: v.snippet.channelTitle, handle: v.snippet.channelId },
    publishedAt: publishedAt.toISOString(),
    metrics: {
      views: Number(v.statistics?.viewCount ?? 0),
      likes: Number(v.statistics?.likeCount ?? 0),
    },
    score: velocity(youtubeEngagement(v.statistics ?? {}), publishedAt, now),
  }
}

/**
 * 対象期間（window）に公開された動画を再生数順に検索する。
 * search.list は1回100ユニット消費するので、ジャンルごとに1回だけ呼ぶ。
 */
export async function searchYoutubeGenre(genre, window, config, key, now = new Date()) {
  const yc = config.youtube
  const search = await ytGet(
    "/search",
    {
      part: "id",
      type: "video",
      order: "viewCount",
      publishedAfter: window.start.toISOString(),
      publishedBefore: window.end.toISOString(),
      regionCode: yc.regionCode,
      relevanceLanguage: yc.relevanceLanguage,
      videoCategoryId: genre.videoCategoryId,
      q: genre.q,
      maxResults: yc.maxResults,
    },
    key,
  )
  const ids = (search.items ?? []).map((i) => i.id.videoId).filter(Boolean)
  if (ids.length === 0) return []

  const requireKana = genre.requireKana ?? yc.requireKana
  const videos = await fetchVideos(ids, key)
  return videos
    .filter(isEmbeddable)
    .filter((v) => !requireKana || hasKana(v))
    .filter((v) => Number(v.statistics?.viewCount ?? 0) >= (genre.minViews ?? yc.minViews))
    .map((v) => toYoutubeCandidate(v, genre, now))
}

/** 削除・非公開・埋め込み不可になった動画IDを返す */
export async function findUnavailableVideos(ids, key) {
  const videos = await fetchVideos(ids, key)
  const ok = new Set(videos.filter(isEmbeddable).map((v) => v.id))
  return ids.filter((id) => !ok.has(id))
}
