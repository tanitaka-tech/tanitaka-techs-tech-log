/*
 * SoundCloud の曲を、SoundCloud の検索から直接集める。
 *
 * 公式 API はアプリ登録に審査が要るので、soundcloud.com 自身が使っている api-v2 を使う。
 * client_id はトップページに埋め込まれている window.__sc_hydration（apiClient）から読む。
 * どちらも非公式なので、ページや API の作りが変わったらここを直す。
 *
 * ランキングの API はないので、タグ・キーワードで直近の曲を検索し、いいね数などの伸び率で並べる。
 * 日本の SoundCloud は24時間では再生が集まらないので、対象は直近7日（maxTrackAgeDays）の曲にしている
 * （掲載済みの曲は review で自動的に外れる）。
 */
import { hoursBetween } from "./date.mjs"
import { filterWithReasons } from "./drops.mjs"
import { velocity } from "./score.mjs"
import { KANA_RE } from "./youtube.mjs"

const HOST = "https://soundcloud.com"
const API = "https://api-v2.soundcloud.com"
// ブラウザ以外の User-Agent だとページの中身が変わることがあるので、ブラウザを名乗る
const HEADERS = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)" }

/** ページの HTML から hydration の JSON（配列）を取り出す。見つからなければ null */
export function parseHydration(html) {
  const m = html.match(/__sc_hydration\s*=\s*(\[[\s\S]*?\]);\s*<\/script>/)
  if (!m) return null
  try {
    return JSON.parse(m[1])
  } catch {
    return null
  }
}

let clientId
/** api-v2 の client_id。トップページの hydration（apiClient）から読み、実行中は使い回す */
async function getClientId() {
  if (clientId) return clientId
  const res = await fetch(HOST, { headers: HEADERS })
  if (!res.ok) throw new Error(`SoundCloud ${res.status} トップページ`)
  const id = parseHydration(await res.text())?.find((d) => d.hydratable === "apiClient")?.data?.id
  if (!id) throw new Error("SoundCloud の client_id が見つかりません（ページの作りが変わった可能性があります）")
  clientId = id
  return id
}

/** api-v2 の曲検索。next_href をたどって pages ページ（1ページ50曲）まで読む */
async function searchTracks(params, pages) {
  const id = await getClientId()
  let url = new URL(`${API}/search/tracks`)
  for (const [k, v] of Object.entries({ ...params, limit: 50 })) url.searchParams.set(k, v)
  const tracks = []
  for (let i = 0; i < pages && url; i++) {
    url.searchParams.set("client_id", id)
    const res = await fetch(url, { headers: HEADERS })
    if (!res.ok) throw new Error(`SoundCloud API ${res.status} /search/tracks`)
    const body = await res.json()
    tracks.push(...(body.collection ?? []))
    url = body.next_href ? new URL(body.next_href) : null
  }
  return tracks
}

/** 誰でも埋め込み・再生できる公開曲か。SNIP は Go+ 限定で30秒しか聴けない曲、BLOCK は地域制限 */
export function isPlayable(t) {
  return (
    t.kind === "track" &&
    t.sharing === "public" &&
    t.embeddable_by === "all" &&
    t.streamable !== false &&
    !["BLOCK", "SNIP"].includes(t.policy)
  )
}

export function trackHasKana(t) {
  return [t.title, t.user?.username, t.user?.full_name].some((s) => KANA_RE.test(s ?? ""))
}

/** 公開日。予約公開の曲は display_date が実際の公開日時になる */
export function trackPublishedAt(t) {
  return new Date(t.display_date ?? t.created_at)
}

/** アートワークの URL は 100px（-large）なので、大きいサイズに差し替える。アートワークがなければ投稿者のアイコン */
export function artworkUrl(t, size = "t500x500") {
  const url = t.artwork_url ?? t.user?.avatar_url
  return url?.replace(/-large\.(\w+)$/, `-${size}.$1`)
}

/** 反応数。再生は曲を開いただけでも増えるので、いいね・リポストを重く見る */
export function soundcloudEngagement(t) {
  return (t.playback_count ?? 0) + (t.likes_count ?? 0) * 10 + (t.reposts_count ?? 0) * 20
}

/** 説明文は HTML が混ざるので、タグを外して平文にする */
function plainText(html) {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
}

export function toSoundcloudCandidate(t, genre, now = new Date()) {
  const publishedAt = trackPublishedAt(t)
  return {
    key: `soundcloud:${t.id}`,
    source: "soundcloud",
    id: String(t.id),
    genre: genre.id,
    genreLabel: genre.label,
    url: t.permalink_url,
    title: t.title,
    thumbnail: artworkUrl(t),
    text: plainText(t.description ?? "").slice(0, 400),
    author: {
      id: String(t.user.id),
      name: t.user.username,
      handle: t.user.permalink,
      avatar: t.user.avatar_url,
    },
    publishedAt: publishedAt.toISOString(),
    metrics: {
      plays: t.playback_count ?? 0,
      likes: t.likes_count ?? 0,
      reposts: t.reposts_count ?? 0,
      comments: t.comment_count ?? 0,
      followers: t.user.followers_count ?? 0,
    },
    score: velocity(soundcloudEngagement(t), publishedAt, now),
  }
}

/**
 * ジャンルの tags（SoundCloud のジャンル・タグ）と queries（キーワード）で直近の曲を検索し、候補にする。
 * 検索は API キー不要で、X のような従量課金もない
 */
export async function searchSoundcloudGenre(genre, now = new Date(), drops = {}) {
  const pages = genre.pages ?? 2
  const created = genre.maxTrackAgeDays > 7 ? "last_month" : "last_week"
  const searches = [
    ...(genre.tags ?? []).map((tag) => ({ q: "*", "filter.genre_or_tag": tag })),
    ...(genre.queries ?? []).map((q) => ({ q })),
  ]
  const byId = new Map()
  for (const params of searches) {
    for (const t of await searchTracks({ ...params, "filter.created_at": created }, pages)) byId.set(t.id, t)
  }

  const maxAgeDays = genre.maxTrackAgeDays ?? 7
  const requireKana = genre.requireKana ?? true
  // 曲名・説明・タグ・投稿者名に対する除外の正規表現（AI で作った曲など）。大文字小文字は区別する
  const exclude = genre.exclude && new RegExp(genre.exclude)
  const trackText = (t) => [t.title, t.description, t.tag_list, t.genre, t.user?.username, t.user?.full_name].join("\n")
  const tracks = filterWithReasons(
    [...byId.values()],
    [
      ["再生・埋め込み不可", isPlayable],
      ["除外語", (t) => !exclude || !exclude.test(trackText(t))],
      ["仮名なし", (t) => !requireKana || trackHasKana(t)],
      ["古い曲", (t) => hoursBetween(trackPublishedAt(t), now) <= maxAgeDays * 24],
      ["いいね不足", (t) => (t.likes_count ?? 0) >= (genre.minLikes ?? 0)],
      ["フォロワー不足", (t) => (t.user?.followers_count ?? 0) >= (genre.minFollowers ?? 0)],
    ],
    drops,
  )
  console.log(`[soundcloud] ${genre.id}: ${searches.length}回の検索で ${byId.size}曲（条件に合う曲: ${tracks.length}曲）`)
  return tracks.map((t) => toSoundcloudCandidate(t, genre, now))
}

/** 削除・非公開になった曲の ID を返す。oEmbed は曲 ID の URL を受け付け、見られない曲には 404 を返す */
export async function findUnavailableTracks(ids) {
  const unavailable = []
  for (const id of ids) {
    const url = new URL(`${HOST}/oembed`)
    url.searchParams.set("format", "json")
    url.searchParams.set("url", `https://api.soundcloud.com/tracks/${id}`)
    const res = await fetch(url, { headers: HEADERS })
    if (res.status === 404 || res.status === 403) unavailable.push(id)
    else if (!res.ok) throw new Error(`SoundCloud oEmbed ${res.status} tracks/${id}`)
  }
  return unavailable
}
