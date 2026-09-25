/*
 * X・YouTube・Steam から対象日の候補を集めて .digest-cache/<date>/candidates.json に保存する。
 * X は従量課金なので、保存済みなら --force を付けない限り取り直さない。
 */
import fs from "node:fs"
import { writeJson } from "../lib/context.mjs"
import { dayWindowJst } from "../lib/date.mjs"
import { fetchSteamSales } from "../lib/steam.mjs"
import { searchXGenre } from "../lib/x.mjs"
import { collectXYoutubeGenre } from "../lib/x-youtube.mjs"
import { searchYoutubeGenre } from "../lib/youtube.mjs"

function requireEnv(name) {
  const v = process.env[name]
  if (!v) throw new Error(`環境変数 ${name} が空です（.env に書いてください）`)
  return v
}

async function fetchAll(ctx) {
  const { config, now } = ctx
  const window = dayWindowJst(ctx.date, now)
  const budget = { remaining: config.x.maxPostsPerRun }
  // 読み取り上限を先頭のジャンルが使い切らないよう、残りの X ジャンルで xWeight（既定1）の比で分ける
  const usesX = (g) => g.source === "x" || g.source === "x-youtube"
  let xWeightLeft = config.genres.filter(usesX).reduce((sum, g) => sum + (g.xWeight ?? 1), 0)
  const takeShare = (g) => {
    const w = g.xWeight ?? 1
    const share = Math.floor((budget.remaining * w) / xWeightLeft)
    xWeightLeft -= w
    return share
  }
  const candidates = []
  const errors = []
  for (const genre of config.genres) {
    try {
      let found = []
      if (genre.source === "x") {
        found = await searchXGenre(genre, window, config, requireEnv("X_BEARER_TOKEN"), budget, now, takeShare(genre))
      } else if (genre.source === "x-youtube") {
        const keys = { xToken: requireEnv("X_BEARER_TOKEN"), ytKey: requireEnv("YOUTUBE_API_KEY") }
        found = await collectXYoutubeGenre(genre, window, config, keys, budget, now, takeShare(genre))
      } else if (genre.source === "youtube") {
        found = await searchYoutubeGenre(genre, window, config, requireEnv("YOUTUBE_API_KEY"), now)
      } else if (genre.source === "steam" && config.steam.enabled) {
        found = await fetchSteamSales(genre, config)
      }
      console.log(`[collect] ${genre.id}: ${found.length}件`)
      candidates.push(...found)
    } catch (e) {
      // 1ジャンルの失敗で全体を止めない
      console.error(`[collect] ${genre.id} 失敗: ${e.message}`)
      errors.push({ genre: genre.id, message: e.message })
    }
  }
  return { candidates, errors, window, xReads: config.x.maxPostsPerRun - budget.remaining }
}

export async function collect(ctx, { force = false, fixture } = {}) {
  const { paths } = ctx
  if (fs.existsSync(paths.candidates) && !force && !fixture) {
    const n = JSON.parse(fs.readFileSync(paths.candidates, "utf8")).length
    console.log(`${paths.candidates} は保存済みです（${n}件）。取り直すときは --force を付けてください`)
    return
  }

  if (fixture) {
    const candidates = JSON.parse(fs.readFileSync(fixture, "utf8"))
    writeJson(paths.candidates, candidates)
    writeJson(paths.collect, { fixture, collectedAt: new Date().toISOString(), errors: [], xReads: 0 })
    console.log(`${fixture} を ${paths.candidates} にコピーしました（${candidates.length}件）`)
    return
  }

  const { candidates, errors, window, xReads } = await fetchAll(ctx)
  writeJson(paths.candidates, candidates)
  writeJson(paths.collect, {
    collectedAt: new Date().toISOString(),
    window: { start: window.start.toISOString(), end: window.end.toISOString() },
    xReads,
    maxPostsPerRun: ctx.config.x.maxPostsPerRun,
    errors,
  })
  console.log(`\n候補 ${candidates.length}件を ${paths.candidates} に保存しました（X 読み取り ${xReads} / ${ctx.config.x.maxPostsPerRun}）`)
  if (errors.length) console.log(`⚠️ 収集エラー: ${errors.map((e) => e.genre).join(", ")}`)
}
