/*
 * X で共有された SoundCloud の曲を集める。並べ方は x-youtube と同じく「何人が X で貼ったか」。
 *
 * SoundCloud の公式 API はアプリ登録に審査が要るので使わず、曲ページに埋め込まれている
 * window.__sc_hydration（ページ描画用の JSON）から公開日・再生数などを読む。
 * 非公式なので、ページの作りが変わったら parseHydration を直す。
 */
import { hoursBetween } from "./date.mjs"
import { aggregateShares, attachSharers, postUrls, readSharePosts } from "./x-youtube.mjs"
import { KANA_RE } from "./youtube.mjs"

const HOST = "https://soundcloud.com"
// ブラウザ以外の User-Agent だとページの中身が変わることがあるので、ブラウザを名乗る
const HEADERS = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)" }

// soundcloud.com/<1つ目> が曲の投稿者ではないページ
const RESERVED_USERS = new Set([
  "discover", "search", "stream", "you", "charts", "pages", "upload", "settings", "messages",
  "notifications", "people", "tags", "stations", "jobs", "imprint", "terms-of-use", "mobile", "apps", "popular",
])
// soundcloud.com/<投稿者>/<2つ目> が曲ではないページ
const RESERVED_TRACKS = new Set([
  "sets", "likes", "tracks", "reposts", "albums", "popular-tracks", "followers", "following", "comments", "spotlight",
])

/**
 * SoundCloud の URL から曲の permalink（"<投稿者>/<曲>"、小文字）を取り出す。
 * プレイリスト・プロフィール・限定公開（/s-xxxx）の URL などは null
 */
export function soundcloudPermalink(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.hostname.replace(/^(www|m)\./, "") !== "soundcloud.com") return null
  const parts = u.pathname.split("/").filter(Boolean)
  if (parts.length !== 2) return null
  const [user, track] = parts.map((p) => p.toLowerCase())
  if (RESERVED_USERS.has(user) || RESERVED_TRACKS.has(track)) return null
  return `${user}/${track}`
}

const isShortLink = (url) => {
  try {
    return new URL(url).hostname === "on.soundcloud.com"
  } catch {
    return false
  }
}

/** on.soundcloud.com の短縮 URL をリダイレクト先に解決する。解決できなければ Map に入れない */
async function resolveShortLinks(urls) {
  const resolved = new Map()
  for (const url of new Set(urls.filter(isShortLink))) {
    try {
      const res = await fetch(url, { headers: HEADERS })
      await res.body?.cancel()
      if (res.ok) resolved.set(url, res.url)
    } catch (e) {
      console.warn(`[soundcloud] 短縮 URL を解決できません: ${url} (${e.message})`)
    }
  }
  return resolved
}

/** 曲ページの HTML から hydration の曲データ（hydratable: "sound"）を取り出す。見つからなければ null */
export function parseHydration(html) {
  const m = html.match(/__sc_hydration\s*=\s*(\[[\s\S]*?\]);\s*<\/script>/)
  if (!m) return null
  let data
  try {
    data = JSON.parse(m[1])
  } catch {
    return null
  }
  return data.find((d) => d.hydratable === "sound")?.data ?? null
}

/** permalink の曲ページを読み、曲データを返す。削除・非公開などで曲データがなければ null */
export async function fetchTrack(permalink) {
  const res = await fetch(`${HOST}/${permalink}`, { headers: HEADERS })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`SoundCloud ${res.status} ${permalink}`)
  // 存在しない曲も 200 で空のページが返るので、曲データの有無で判定する
  return parseHydration(await res.text())
}

async function fetchTracks(permalinks, concurrency = 4) {
  const tracks = new Map()
  const queue = [...permalinks]
  const worker = async () => {
    while (queue.length) {
      const permalink = queue.shift()
      try {
        const t = await fetchTrack(permalink)
        if (t) tracks.set(permalink, t)
      } catch (e) {
        console.warn(`[soundcloud] ${e.message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
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

export function toSoundcloudCandidate(t, genre) {
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
    publishedAt: trackPublishedAt(t).toISOString(),
    metrics: {
      plays: t.playback_count ?? 0,
      likes: t.likes_count ?? 0,
      reposts: t.reposts_count ?? 0,
      comments: t.comment_count ?? 0,
    },
  }
}

export async function collectXSoundcloudGenre(genre, window, config, xToken, budget, now = new Date(), share = Infinity) {
  const read = await readSharePosts(genre, window, config, xToken, budget, share)
  if (!read) return []
  const { posts, users } = read

  const shortLinks = await resolveShortLinks(posts.flatMap(postUrls))
  const byTrack = aggregateShares(posts, users, window, (url) => soundcloudPermalink(shortLinks.get(url) ?? url))
  const minSharers = genre.minSharers ?? 1
  const permalinks = [...byTrack].filter(([, s]) => s.size >= minSharers).map(([p]) => p)
  console.log(`[x] ${genre.id}: ${posts.length}件の投稿から曲 ${byTrack.size}曲（${minSharers}人以上の共有: ${permalinks.length}曲）`)
  if (permalinks.length === 0) return []

  const maxAgeDays = genre.maxTrackAgeDays ?? 7
  const requireKana = genre.requireKana ?? false
  const tracks = await fetchTracks(permalinks)
  // 同じ曲が別の URL（大文字小文字違いなど）で貼られていても1件にする
  const byId = new Map()
  for (const [permalink, t] of tracks) {
    if (!isPlayable(t)) continue
    if (requireKana && !trackHasKana(t)) continue
    if (hoursBetween(trackPublishedAt(t), now) > maxAgeDays * 24) continue
    if ((t.playback_count ?? 0) < (genre.minPlays ?? 0)) continue
    const sharers = byTrack.get(permalink)
    const prev = byId.get(t.id)
    if (!prev) {
      byId.set(t.id, { t, sharers: new Map(sharers) })
      continue
    }
    for (const [id, s] of sharers) if (!prev.sharers.has(id)) prev.sharers.set(id, s)
  }
  return [...byId.values()].map(({ t, sharers }) => attachSharers(toSoundcloudCandidate(t, genre), sharers))
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
