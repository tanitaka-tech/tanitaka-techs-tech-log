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

/**
 * 指定日（JST）に公開された動画を再生数順に検索する。
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

  const videos = await fetchVideos(ids, key)
  return videos
    .filter((v) => v.status?.embeddable && v.status?.privacyStatus === "public")
    .filter((v) => Number(v.statistics?.viewCount ?? 0) >= yc.minViews)
    .map((v) => {
      const publishedAt = new Date(v.snippet.publishedAt)
      return {
        key: `youtube:${v.id}`,
        source: "youtube",
        id: v.id,
        genre: genre.id,
        genreLabel: genre.label,
        url: `https://www.youtube.com/watch?v=${v.id}`,
        title: v.snippet.title,
        text: (v.snippet.description ?? "").slice(0, 400),
        author: { name: v.snippet.channelTitle, handle: v.snippet.channelId },
        publishedAt: publishedAt.toISOString(),
        metrics: {
          views: Number(v.statistics.viewCount ?? 0),
          likes: Number(v.statistics.likeCount ?? 0),
        },
        score: velocity(youtubeEngagement(v.statistics), publishedAt, now),
      }
    })
}

/** 削除・非公開・埋め込み不可になった動画IDを返す */
export async function findUnavailableVideos(ids, key) {
  const videos = await fetchVideos(ids, key)
  const ok = new Set(
    videos
      .filter((v) => v.status?.embeddable && v.status?.privacyStatus === "public")
      .map((v) => v.id),
  )
  return ids.filter((id) => !ok.has(id))
}
