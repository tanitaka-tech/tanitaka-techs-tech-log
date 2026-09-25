/*
 * 掲載済みの投稿・動画・曲・作品・記事・ゲームが削除・非公開になっていないか確認し、
 * 取得できなくなった項目を記事から取り除く。
 *
 * 使い方: pnpm digest:check-deleted
 * 環境変数: YOUTUBE_API_KEY（X を確かめる設定なら X_BEARER_TOKEN も。ローカルでは .env から読む）
 */
import fs from "node:fs"
import YAML from "yaml"
import { loadDotEnv } from "./lib/env.mjs"
import { findUnavailableBlueskyPosts } from "./lib/bluesky.mjs"
import { findUnavailableArticles } from "./lib/hatena.mjs"
import { findUnavailableNotes } from "./lib/misskey.mjs"
import { findUnavailableWorks } from "./lib/pixiv.mjs"
import { listItemsByFile, removeItems } from "./lib/render.mjs"
import { findUnavailableTracks } from "./lib/soundcloud.mjs"
import { SOURCES } from "./lib/sources.mjs"
import { findUnavailableApps } from "./lib/steam.mjs"
import { findUnavailableTweets } from "./lib/x.mjs"
import { findUnavailableVideos } from "./lib/youtube.mjs"

loadDotEnv()

const config = YAML.parse(fs.readFileSync("scripts/daily-digest/config.yaml", "utf8"))

/**
 * ソースごとの確認。ids（キーの <ID> の部分）のうち取得できないものを返す。urls は キー → 項目のリンク先。
 * 確かめないソースは null を返し、理由を skip に書く
 */
const CHECKERS = {
  x: {
    // X API は従量課金なので、使わない設定（x.enabled: false）の間は確かめない
    skip: () => (config.x.enabled === false ? "x.enabled が false" : null),
    find: (ids) => findUnavailableTweets(ids, process.env.X_BEARER_TOKEN),
  },
  youtube: { find: (ids) => findUnavailableVideos(ids, process.env.YOUTUBE_API_KEY) },
  soundcloud: { find: findUnavailableTracks },
  bluesky: { find: findUnavailableBlueskyPosts },
  misskey: { find: (ids) => findUnavailableNotes(ids) },
  pixiv: { find: findUnavailableWorks },
  steam: { find: findUnavailableApps },
  hatena: { find: (ids, urls) => findUnavailableArticles(ids.map((id) => [id, urls.get(`hatena:${id}`)]).filter(([, url]) => url)) },
}

async function main() {
  const files = listItemsByFile(config.article.dir)
  const all = files.flatMap((f) => f.keys)
  const urls = new Map(files.flatMap((f) => [...f.urls]))
  const idsOf = (source) => [...new Set(all.filter((k) => k.startsWith(`${source}:`)).map((k) => k.slice(source.length + 1)))]

  const unavailable = new Set()
  const summary = []
  for (const { id: source, name } of SOURCES) {
    const ids = idsOf(source)
    if (ids.length === 0) continue
    const checker = CHECKERS[source]
    const skipped = checker ? checker.skip?.() : "確かめる方法がない"
    if (skipped) {
      console.log(`${name} の ${ids.length}件は確かめません（${skipped}）`)
      continue
    }
    const missing = await checker.find(ids, urls)
    for (const id of missing) unavailable.add(`${source}:${id}`)
    summary.push(`${name} ${ids.length}件`)
  }

  console.log(`確認: ${summary.join(" / ") || "なし"}、取得できない項目: ${unavailable.size}件`)
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
