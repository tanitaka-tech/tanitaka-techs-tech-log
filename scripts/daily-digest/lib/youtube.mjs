import { countDrop, filterWithReasons } from "./drops.mjs"
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
      { part: "snippet,statistics,status,contentDetails", id: ids.slice(i, i + 50).join(",") },
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
export const KANA_RE = /[\u3041-\u309f\u30a1-\u30ff]/

/** タイトルかチャンネル名に仮名が入っているか。海外の大型コンテンツを除いて日本の動画に寄せるため */
export function hasKana(v) {
  return KANA_RE.test(v.snippet?.title ?? "") || KANA_RE.test(v.snippet?.channelTitle ?? "")
}

/** contentDetails.duration（ISO 8601 の PT1H2M3S 形式）を秒にする */
export function durationSeconds(v) {
  const m = (v.contentDetails?.duration ?? "").match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/)
  if (!m) return null
  const [d, h, min, sec] = m.slice(1).map((n) => Number(n ?? 0))
  return ((d * 24 + h) * 60 + min) * 60 + sec
}

/**
 * ショート動画か。API では見分けられないので、/shorts/<ID> を開いて確かめる
 * （ショートならそのまま 200、通常の動画なら /watch へリダイレクトされる）
 */
async function isShort(id) {
  const res = await fetch(`https://www.youtube.com/shorts/${id}`, {
    redirect: "manual",
    headers: { "User-Agent": "Mozilla/5.0" },
  })
  await res.body?.cancel()
  return res.status === 200
}

/**
 * ショートと、長すぎる動画（歌枠・雑談などの配信アーカイブ）を除く。
 * ショートは3分まであるので、それ以下の長さの動画だけを確かめる
 */
export async function excludeShortsAndStreams(videos, yc, drops) {
  const maxSeconds = (yc.maxDurationMinutes ?? 15) * 60
  const kept = []
  for (const v of videos) {
    const sec = durationSeconds(v)
    if (sec != null && sec > maxSeconds) {
      countDrop(drops, "長い動画（配信）")
      continue
    }
    if (yc.excludeShorts !== false && (sec == null || sec <= 180) && (await isShort(v.id))) {
      countDrop(drops, "ショート")
      continue
    }
    kept.push(v)
  }
  return kept
}

/** タイトルが除外の正規表現（genre.excludeTitle か youtube.excludeTitle。PV・予告など）に当たらないか */
export function titleAllowed(v, genre, yc) {
  const pattern = genre.excludeTitle ?? yc.excludeTitle
  return !pattern || !new RegExp(pattern, "i").test(v.snippet?.title ?? "")
}

/**
 * チャンネル名・概要欄が除外の正規表現（youtube.excludeChannel / excludeDescription。AI で作った曲のチャンネルなど）に
 * 当たらないか。大文字小文字は区別する（「AI」が英単語の途中に当たらないように）
 */
export function channelAllowed(v, genre, yc) {
  const channel = genre.excludeChannel ?? yc.excludeChannel
  const description = genre.excludeDescription ?? yc.excludeDescription
  if (channel && new RegExp(channel).test(v.snippet?.channelTitle ?? "")) return false
  if (description && new RegExp(description).test(v.snippet?.description ?? "")) return false
  return true
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
export async function searchYoutubeGenre(genre, window, config, key, now = new Date(), drops = {}) {
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
  const videos = filterWithReasons(
    await fetchVideos(ids, key),
    [
      ["埋め込み不可", isEmbeddable],
      ["除外するタイトル", (v) => titleAllowed(v, genre, yc)],
      ["除外するチャンネル・概要欄", (v) => channelAllowed(v, genre, yc)],
      ["仮名なし", (v) => !requireKana || hasKana(v)],
      ["再生数不足", (v) => Number(v.statistics?.viewCount ?? 0) >= (genre.minViews ?? yc.minViews)],
    ],
    drops,
  )
  return (await excludeShortsAndStreams(videos, yc, drops)).map((v) => toYoutubeCandidate(v, genre, now))
}

/** 削除・非公開・埋め込み不可になった動画IDを返す */
export async function findUnavailableVideos(ids, key) {
  const videos = await fetchVideos(ids, key)
  const ok = new Set(videos.filter(isEmbeddable).map((v) => v.id))
  return ids.filter((id) => !ok.has(id))
}
