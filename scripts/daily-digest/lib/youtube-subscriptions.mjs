import fs from "node:fs"
import path from "node:path"
import { todayJst } from "./date.mjs"
import { headers } from "./http.mjs"
import { isEmbeddable, toYoutubeCandidate } from "./youtube.mjs"

const API = "https://www.googleapis.com/youtube/v3"
const TOKEN_FILES = /^token(?:-[\w-]+)?\.json$/
const GENRES = {
  music: { id: "subscribed-music", label: "音楽・MV" },
  tech: { id: "subscribed-tech", label: "最新技術" },
  learning: { id: "subscribed-learning", label: "学習・講座" },
  expression: { id: "subscribed-expression", label: "表現の解説" },
  games: { id: "subscribed-games", label: "最新ゲーム" },
  motivation: { id: "subscribed-motivation", label: "やる気が出る・元気になる" },
  sale: { id: "subscribed-sale", label: "セール" },
  illustration: { id: "subscribed-illustration", label: "イラスト" },
  landscape: { id: "subscribed-landscape", label: "風景写真" },
}
const RELEVANT = /AI|Claude|ChatGPT|Gemini|LLM|プロンプト|Unity|Godot|Blender|Excel|JetBrains|プログラミング|コード|開発|動画編集|映像|撮影|カメラ|イラスト|お絵描き|作画|漫画|キャラコース|アニメ私塾|ブラシ|デザイン|DTM|音楽制作|音声|プラグイン|NoiseAsh|Heater|Suno|MV|Game|ゲーム|RPG|Steam|Eyeline|Saturation/i
const TUTORIAL = /講座|授業|学習|勉強|レッスン|チュートリアル|入門|初心者|基礎|使い方|作り方|描き方|やり方|解説|添削|実演|手順|ガイド|簡単作成|作成方法|tutorial|lesson|course|how to|walkthrough/i
const UNRELATED = /政治|政党|選挙|街頭演説|参政党|中国当局|人口減|タワマン|事件|事故|炎上|なりすまし|ボランティア.*面談|\bPR\b|案件/i
const STREAM = /雑談|歌枠|カラオケ|BGM|ラジオ|睡眠|耐久|朝活|ウォーミングアップ/i

/** タイトルから内容が明確に分かる動画だけ、既存のセクションへ振り分ける。 */
export function classifySubscribedVideo(video) {
  const title = video.snippet?.title ?? ""
  const channel = video.snippet?.channelTitle ?? ""
  if (!title || UNRELATED.test(title) || UNRELATED.test(channel)) return null

  if (/(?:100%|\d+%)\s*off|無料配布|無料化|期間限定無料|\bfree\b/i.test(title) && RELEVANT.test(title)) return GENRES.sale
  if (/eyeline|構図|色彩|映像表現|演出技法|カメラアングル|撮影技法/i.test(title) && /解説|比較|考え方|技法|angle|height|matching/i.test(title)) return GENRES.expression
  if (TUTORIAL.test(title) && RELEVANT.test(`${title} ${channel}`)) return GENRES.learning
  if (/DTMしてBlenderで映像を付ける/i.test(title)) return GENRES.learning
  if (/なぜ.*(ブラシ|構図|色|描)/.test(title) && RELEVANT.test(title)) return GENRES.learning

  if (/お絵描き|イラストメイキング|作画配信|イラストレーター|#イラスト|#illustration/i.test(title)) return GENRES.illustration
  if (/漫画家|イラストレーター/i.test(channel) && /作業|制作/.test(title)) return GENRES.illustration
  if (/風景写真|星景写真|野鳥撮影|写真作品|landscape photography|nature photography/i.test(title)) return GENRES.landscape
  if (!STREAM.test(title) && /(?:\bMV\b|Music Video|オリジナル曲|新曲|公式音源|Official Audio)/i.test(title)) return GENRES.music

  if (/新作|新ゲーム|発売|リリース|配信開始|大型アップデート|新機能/i.test(title) && /ゲーム|RPG|Steam|Switch|PlayStation|PS5|Xbox/i.test(title)) return GENRES.games
  if (/クリエイター|制作|開発/.test(title) && /挑戦|成長|乗り越え|成功体験/.test(title)) return GENRES.motivation
  if (/Claude|ChatGPT|Gemini|Anthropic|OpenAI|Godot|Unity|Blender|Excel|JetBrains|AIツール|動画編集|Video Editor|NoiseAsh/i.test(title) && /公開|発表|登場|リリース|アプデ|アップデート|新機能|新モデル|Powered|開始/i.test(title)) return GENRES.tech
  return null
}

const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function responseJson(url, init = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, { ...init, headers: headers(init.headers) })
    const body = await response.json().catch(() => ({}))
    if (response.ok) return body
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      await sleep(500 * 2 ** attempt)
      continue
    }
    // URL には認可情報やトークンを入れない。エラー本文もログに含めない。
    const reason = body.error?.errors?.[0]?.reason ?? "request failed"
    const error = new Error(`YouTube API ${response.status}: ${reason}`)
    error.status = response.status
    error.reason = reason
    throw error
  }
}

export async function youtubeApiGet(resource, params, token) {
  const url = new URL(`${API}/${resource}`)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  return responseJson(url, { headers: { Authorization: `Bearer ${token}` } })
}

async function readAccessTokens(dir) {
  const client = JSON.parse(fs.readFileSync(path.join(dir, "client_secret.json"), "utf8")).installed
  const files = fs.readdirSync(dir).filter((name) => TOKEN_FILES.test(name)).sort()
  if (files.length === 0) throw new Error(`${dir} に YouTube の認可トークンがありません`)
  const tokens = []
  const errors = []
  for (const file of files) {
    try {
      const location = path.join(dir, file)
      const saved = JSON.parse(fs.readFileSync(location, "utf8"))
      if (saved.access_token && Date.now() < (saved.created_at + saved.expires_in - 60) * 1000) {
        tokens.push(saved.access_token)
        continue
      }
      const fresh = await responseJson("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.client_id,
          client_secret: client.client_secret,
          refresh_token: saved.refresh_token,
          grant_type: "refresh_token",
        }),
      })
      const updated = { ...saved, ...fresh, created_at: Math.floor(Date.now() / 1000) }
      const temporary = `${location}.${process.pid}.tmp`
      fs.writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600, flag: "wx" })
      fs.renameSync(temporary, location)
      tokens.push(updated.access_token)
    } catch (error) {
      errors.push(`${file}: ${error.message}`)
    }
  }
  if (tokens.length === 0) throw new Error(`YouTube の認可がすべて失効しました: ${errors.join(" / ")}`)
  return { tokens, errors }
}

async function allPages(resource, params, token, apiGet) {
  const items = []
  let pageToken
  do {
    const body = await apiGet(resource, { ...params, pageToken }, token)
    items.push(...(body.items ?? []))
    pageToken = body.nextPageToken
  } while (pageToken)
  return items
}

async function mapConcurrent(items, count, fn) {
  let next = 0
  const results = Array(items.length)
  await Promise.all(Array.from({ length: Math.min(items.length, count) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }))
  return results
}

/** 登録チャンネルの今日の公開動画を全件読む。件数の上限は置かず、古い動画に達するまでページをたどる。 */
export async function collectSubscribedVideos({ now = new Date(), credentialsDir = process.env.YOUTUBE_OAUTH_DIR ?? ".digest-cache/google-oauth", apiGet = youtubeApiGet, accessTokens } = {}) {
  const auth = accessTokens ? { tokens: accessTokens, errors: [] } : await readAccessTokens(credentialsDir)
  const start = new Date(`${todayJst(now)}T00:00:00+09:00`)
  const subscribedIds = new Set()
  for (const token of auth.tokens) {
    const subscriptions = await allPages("subscriptions", { part: "snippet", mine: true, maxResults: 50 }, token, apiGet)
    for (const subscription of subscriptions) {
      const id = subscription.snippet?.resourceId?.channelId
      if (id) subscribedIds.add(id)
    }
  }

  const token = auth.tokens[0]
  const uploads = []
  for (const ids of chunks([...subscribedIds], 50)) {
    const body = await apiGet("channels", { part: "contentDetails", id: ids.join(","), maxResults: 50 }, token)
    for (const channel of body.items ?? []) {
      const playlistId = channel.contentDetails?.relatedPlaylists?.uploads
      if (playlistId) uploads.push(playlistId)
    }
  }

  const failures = []
  const found = await mapConcurrent(uploads, 8, async (playlistId) => {
    const ids = []
    let pageToken
    try {
      do {
        const body = await apiGet("playlistItems", { part: "contentDetails", playlistId, maxResults: 50, pageToken }, token)
        const items = body.items ?? []
        let reachedEarlier = false
        for (const item of items) {
          const value = item.contentDetails?.videoPublishedAt
          if (!value) continue
          const published = new Date(value)
          if (Number.isNaN(published.getTime())) continue
          if (published >= start && published <= now && item.contentDetails?.videoId) ids.push(item.contentDetails.videoId)
          if (published < start) reachedEarlier = true
        }
        // uploads プレイリストは新しい投稿から並ぶ。日付を越えたら、そのチャンネルの探索を終える。
        pageToken = reachedEarlier ? undefined : body.nextPageToken
      } while (pageToken)
    } catch (error) {
      if (!(error.status === 404 && error.reason === "playlistNotFound")) failures.push(`${playlistId}: ${error.message}`)
    }
    return ids
  })

  const ids = [...new Set(found.flat())]
  const videos = []
  for (const batch of chunks(ids, 50)) {
    const body = await apiGet("videos", { part: "snippet,statistics,status,contentDetails", id: batch.join(","), maxResults: 50 }, token)
    videos.push(...(body.items ?? []))
  }
  const published = videos.filter((video) => isEmbeddable(video) && video.snippet?.liveBroadcastContent !== "upcoming" && new Date(video.snippet?.publishedAt) >= start && new Date(video.snippet?.publishedAt) <= now)
  const candidates = published.flatMap((video) => {
    const genre = classifySubscribedVideo(video)
    return genre ? [{ ...toYoutubeCandidate(video, genre, now), origin: "subscriptions" }] : []
  })
  return { candidates, subscriptions: subscribedIds.size, channels: uploads.length, videos: ids.length, discarded: published.length - candidates.length, failures: [...auth.errors, ...failures] }
}
