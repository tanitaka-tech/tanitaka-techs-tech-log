import assert from "node:assert/strict"
import { it } from "node:test"
import { classifySubscribedVideo, collectSubscribedVideos } from "../lib/youtube-subscriptions.mjs"

it("内容が明確な登録動画だけを既存カテゴリへ振り分ける", () => {
  const category = (title, channelTitle = "投稿者") => classifySubscribedVideo({ snippet: { title, channelTitle } })?.label ?? null
  assert.equal(category("MASSIVE Unity Save System Tutorial!"), "学習・講座")
  assert.equal(category("【＋Lライブ添削】キャラコース『全身後ろ姿』", "アニメ私塾　室井康雄"), "学習・講座")
  assert.equal(category("Matching Eyeline Height and Angle"), "表現の解説")
  assert.equal(category("Meet Gozen: The Godot-Powered Video Editor"), "最新技術")
  assert.equal(category("Heater v2 by NoiseAsh, FREE (100% off) until October 8"), "セール")
  assert.equal(category("【お絵描き配信】今日の作業"), "イラスト")
  assert.equal(category("【FE 万紫千紅│03】ゲーム実況"), null)
  assert.equal(category("【新作RPG/PR】イベント参加型"), null)
  assert.equal(category("【神谷宗幣】参政党街頭演説"), null)
  assert.equal(category("ゆる雑談"), null)
})

it("複数アカウントの登録を重複排除し、当日の動画をページ上限なしで集める", async () => {
  const publishedAt = "2026-09-29T00:00:00Z"
  const item = (id, date = publishedAt) => ({ contentDetails: { videoId: id, videoPublishedAt: date } })
  const calls = []
  const apiGet = async (resource, params, token) => {
    calls.push({ resource, params, token })
    if (resource === "subscriptions") {
      if (token === "account-a" && !params.pageToken) {
        return { items: [{ snippet: { resourceId: { channelId: "A" } } }], nextPageToken: "next" }
      }
      return { items: [{ snippet: { resourceId: { channelId: "B" } } }] }
    }
    if (resource === "channels") {
      return { items: ["A", "B"].map((id) => ({ contentDetails: { relatedPlaylists: { uploads: `${id}-uploads` } } })) }
    }
    if (resource === "playlistItems") {
      if (params.playlistId === "A-uploads" && !params.pageToken) {
        return { items: Array.from({ length: 50 }, (_, i) => item(`a${i}`)), nextPageToken: "next" }
      }
      if (params.playlistId === "A-uploads") {
        return { items: [item("a50"), item("old", "2026-09-28T00:00:00Z")] }
      }
      if (!params.pageToken) {
        return { items: [item("b0"), { contentDetails: { videoId: "undated" } }], nextPageToken: "next" }
      }
      return { items: [item("b1")] }
    }
    if (resource === "videos") {
      return {
        items: params.id.split(",").map((id) => ({
          id,
          snippet: { title: id === "a50" ? "イラストのライブ添削" : id === "b0" ? "お絵描き配信" : id === "b1" ? "ただの雑談" : `Unity 1.0 リリース ${id}`, channelId: "A", channelTitle: "投稿者", publishedAt, liveBroadcastContent: id === "a0" ? "upcoming" : "none" },
          status: { embeddable: true, privacyStatus: "public" },
          statistics: { viewCount: "10" },
        })),
      }
    }
    throw new Error(`unexpected resource: ${resource}`)
  }

  const result = await collectSubscribedVideos({ now: new Date("2026-09-29T03:00:00Z"), accessTokens: ["account-a", "account-b"], apiGet })
  assert.equal(result.subscriptions, 2)
  assert.equal(result.videos, 53)
  assert.equal(result.candidates.length, 51)
  assert.equal(result.candidates.filter((c) => c.genre === "subscribed-learning").length, 1)
  assert.equal(result.candidates.filter((c) => c.genre === "subscribed-tech").length, 49)
  assert.equal(result.candidates.filter((c) => c.genre === "subscribed-illustration").length, 1)
  assert.equal(result.discarded, 1)
  assert.ok(result.candidates.every((c) => c.origin === "subscriptions" && c.source === "youtube"))
  assert.equal(calls.filter((c) => c.resource === "subscriptions" && c.token === "account-a").length, 2)
  assert.equal(calls.filter((c) => c.resource === "playlistItems" && c.params.playlistId === "A-uploads").length, 2)
  assert.equal(calls.filter((c) => c.resource === "playlistItems" && c.params.playlistId === "B-uploads").length, 2)
  assert.equal(calls.filter((c) => c.resource === "videos").length, 2)
})
