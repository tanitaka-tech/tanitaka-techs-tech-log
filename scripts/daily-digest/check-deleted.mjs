/*
 * 掲載済みの X 投稿・YouTube 動画・SoundCloud の曲が削除・非公開になっていないか確認し、
 * 取得できなくなった項目を記事から取り除く。
 *
 * 使い方: pnpm digest:check-deleted
 * 環境変数: X_BEARER_TOKEN, YOUTUBE_API_KEY（ローカルでは .env から読む）
 */
import fs from "node:fs"
import YAML from "yaml"
import { loadDotEnv } from "./lib/env.mjs"
import { listItemsByFile, removeItems } from "./lib/render.mjs"
import { findUnavailableBlueskyPosts } from "./lib/bluesky.mjs"
import { findUnavailableNotes } from "./lib/misskey.mjs"
import { findUnavailableTracks } from "./lib/soundcloud.mjs"
import { findUnavailableTweets } from "./lib/x.mjs"
import { findUnavailableVideos } from "./lib/youtube.mjs"

loadDotEnv()

const config = YAML.parse(fs.readFileSync("scripts/daily-digest/config.yaml", "utf8"))

async function main() {
  const files = listItemsByFile(config.article.dir)
  const all = files.flatMap((f) => f.keys)
  const idsOf = (source) =>
    [...new Set(all.filter((k) => k.startsWith(`${source}:`)).map((k) => k.slice(source.length + 1)))]

  const unavailable = new Set()
  const xIds = idsOf("x")
  // X API は従量課金なので、使わない設定（x.enabled: false）の間は確かめない
  if (xIds.length && config.x.enabled === false) console.log(`X の投稿 ${xIds.length}件は、x.enabled が false なので確かめません`)
  else if (xIds.length) {
    for (const id of await findUnavailableTweets(xIds, process.env.X_BEARER_TOKEN)) {
      unavailable.add(`x:${id}`)
    }
  }
  const ytIds = idsOf("youtube")
  if (ytIds.length) {
    for (const id of await findUnavailableVideos(ytIds, process.env.YOUTUBE_API_KEY)) {
      unavailable.add(`youtube:${id}`)
    }
  }

  const scIds = idsOf("soundcloud")
  if (scIds.length) {
    for (const id of await findUnavailableTracks(scIds)) {
      unavailable.add(`soundcloud:${id}`)
    }
  }

  const bskyIds = idsOf("bluesky")
  if (bskyIds.length) {
    for (const id of await findUnavailableBlueskyPosts(bskyIds)) unavailable.add(`bluesky:${id}`)
  }
  const misskeyIds = idsOf("misskey")
  if (misskeyIds.length) {
    for (const id of await findUnavailableNotes(misskeyIds)) unavailable.add(`misskey:${id}`)
  }

  console.log(`確認: X ${xIds.length}件 / YouTube ${ytIds.length}件 / SoundCloud ${scIds.length}件 / Bluesky ${bskyIds.length}件 / Misskey ${misskeyIds.length}件、取得できない項目: ${unavailable.size}件`)
  const lines = []
  for (const { file, keys } of files) {
    const hit = keys.filter((k) => unavailable.has(k))
    if (hit.length === 0) continue
    removeItems(file, unavailable)
    lines.push(`- ${file}: ${hit.join(", ")}`)
  }
  if (lines.length) {
    fs.mkdirSync(".digest-cache", { recursive: true })
    fs.writeFileSync(".digest-cache/removed.md", lines.join("\n"))
    console.log(lines.join("\n"))
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
