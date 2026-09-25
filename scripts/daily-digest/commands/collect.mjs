/*
 * はてなブックマーク・Bluesky・Misskey・pixiv・YouTube・SoundCloud・Steam（と、使う設定なら X）から、実行時点までの直近24時間（config.yaml の collect.windowHours。SoundCloud は7日）の候補を集めて
 * .digest-cache/<date>/candidates.json に保存する。<date> は記事の日付（既定は今日）。
 * X は従量課金なので、保存済みなら --force を付けない限り取り直さない。
 * --genre a,b を付けると、そのジャンルだけを取り直して保存済みの候補と差し替える（失敗したジャンルの取り直し用）。
 * config.yaml の x.enabled が false の間は、X を使うジャンル（x / x-youtube）は集めない。
 */
import fs from "node:fs"
import { readJson, writeJson } from "../lib/context.mjs"
import { recentWindow, todayJst } from "../lib/date.mjs"
import { searchBlueskyGenre } from "../lib/bluesky.mjs"
import { searchHatenaGenre } from "../lib/hatena.mjs"
import { searchMisskeyGenre } from "../lib/misskey.mjs"
import { searchPixivGenre } from "../lib/pixiv.mjs"
import { searchSoundcloudGenre } from "../lib/soundcloud.mjs"
import { fetchSteamNewReleases, fetchSteamSales } from "../lib/steam.mjs"
import { searchXGenre } from "../lib/x.mjs"
import { collectXYoutubeGenre } from "../lib/x-youtube.mjs"
import { searchYoutubeGenre } from "../lib/youtube.mjs"

function requireEnv(name) {
  const v = process.env[name]
  if (!v) throw new Error(`環境変数 ${name} が空です（.env に書いてください）`)
  return v
}

const usesX = (g) => g.source === "x" || g.source === "x-youtube"

async function fetchAll(ctx, genres) {
  const { config, now } = ctx
  const window = recentWindow(now, config.collect?.windowHours ?? 24)
  const budget = { remaining: config.x.maxPostsPerRun }
  // 読み取り上限を先頭のジャンルが使い切らないよう、残りの X ジャンルで xWeight（既定1）の比で分ける
  let xWeightLeft = genres.filter(usesX).reduce((sum, g) => sum + (g.xWeight ?? 1), 0)
  const takeShare = (g) => {
    const w = g.xWeight ?? 1
    const share = Math.floor((budget.remaining * w) / xWeightLeft)
    xWeightLeft -= w
    return share
  }
  const candidates = []
  const errors = []
  // ジャンルごとの X 読み取り件数と候補数。review で歩留まりを出し、クエリの調整に使う
  const stats = {}
  for (const genre of genres) {
    const before = budget.remaining
    const drops = {}
    try {
      let found = []
      if (genre.source === "x") {
        found = await searchXGenre(genre, window, config, requireEnv("X_BEARER_TOKEN"), budget, now, takeShare(genre), drops)
      } else if (genre.source === "x-youtube") {
        const keys = { xToken: requireEnv("X_BEARER_TOKEN"), ytKey: requireEnv("YOUTUBE_API_KEY") }
        found = await collectXYoutubeGenre(genre, window, config, keys, budget, now, takeShare(genre), drops)
      } else if (genre.source === "hatena") {
        found = await searchHatenaGenre(genre, now, drops)
      } else if (genre.source === "bluesky") {
        found = await searchBlueskyGenre(genre, window, now, drops)
      } else if (genre.source === "misskey") {
        found = await searchMisskeyGenre(genre, window, now, drops)
      } else if (genre.source === "pixiv") {
        found = await searchPixivGenre(genre, now, drops)
      } else if (genre.source === "soundcloud") {
        found = await searchSoundcloudGenre(genre, now, drops)
      } else if (genre.source === "youtube") {
        // 音楽は24時間では再生数が集まらないので、youtube.windowHours（ジャンルごとに上書き可）までさかのぼる。
        // 掲載済みの動画は review で外れるので、翌日以降に同じ動画が載ることはない
        const hours = genre.windowHours ?? config.youtube.windowHours
        const ytWindow = hours ? recentWindow(now, hours) : window
        found = await searchYoutubeGenre(genre, ytWindow, config, requireEnv("YOUTUBE_API_KEY"), now, drops)
      } else if (genre.source === "steam-new" && config.steam.enabled) {
        found = await fetchSteamNewReleases(genre, now, drops)
      } else if (genre.source === "steam" && config.steam.enabled) {
        found = await fetchSteamSales(genre, config)
      }
      // 同じ記事・投稿が複数のジャンルに当たったときは、先のジャンルに入れる
      const seen = new Set(candidates.map((c) => c.key))
      found = found.filter((c) => !seen.has(c.key))
      console.log(`[collect] ${genre.id}: ${found.length}件`)
      candidates.push(...found)
      stats[genre.id] = { reads: before - budget.remaining, candidates: found.length, drops }
    } catch (e) {
      // 1ジャンルの失敗で全体を止めない
      console.error(`[collect] ${genre.id} 失敗: ${e.message}`)
      errors.push({ genre: genre.id, message: e.message })
    }
  }
  return { candidates, errors, stats, window, xReads: config.x.maxPostsPerRun - budget.remaining }
}

/** 集めるジャンル。only（--genre）があればそのジャンルだけ。X を使わない設定なら X のジャンルを除く */
function targetGenres(config, only) {
  let genres = config.genres
  if (only) {
    const ids = only.split(",").map((s) => s.trim())
    const unknown = ids.filter((id) => !genres.some((g) => g.id === id))
    if (unknown.length) throw new Error(`config.yaml にないジャンルです: ${unknown.join(", ")}`)
    genres = genres.filter((g) => ids.includes(g.id))
  }
  if (config.x.enabled === false) {
    const skipped = genres.filter(usesX).map((g) => g.id)
    if (skipped.length) console.log(`[collect] x.enabled が false なので X のジャンルは集めません: ${skipped.join(", ")}`)
    genres = genres.filter((g) => !usesX(g))
  }
  return genres
}

export async function collect(ctx, { force = false, fixture, genre: only } = {}) {
  const { paths } = ctx
  if (only && !fixture) return collectSome(ctx, only)
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

  // 集めるのは常に「今から24時間以内」なので、別の日付の記事用に集めると中身と日付が食い違う
  if (ctx.date !== todayJst(ctx.now)) {
    throw new Error(`収集は実行時点から直近の投稿が対象なので、--date には今日（${todayJst(ctx.now)}）しか指定できません`)
  }
  const { candidates, errors, stats, window, xReads } = await fetchAll(ctx, targetGenres(ctx.config, null))
  // すべて失敗したときに空の候補を保存すると、次回から取り直されなくなるので保存しない
  if (candidates.length === 0) throw new Error("候補が1件も集まりませんでした（保存していません）")
  writeJson(paths.candidates, candidates)
  writeJson(paths.collect, {
    collectedAt: new Date().toISOString(),
    window: { start: window.start.toISOString(), end: window.end.toISOString() },
    xReads,
    maxPostsPerRun: ctx.config.x.maxPostsPerRun,
    stats,
    errors,
  })
  console.log(`\n候補 ${candidates.length}件を ${paths.candidates} に保存しました（X 読み取り ${xReads} / ${ctx.config.x.maxPostsPerRun}）`)
  if (errors.length) console.log(`⚠️ 収集エラー: ${errors.map((e) => e.genre).join(", ")}`)
}

/** 指定したジャンルだけを取り直し、保存済みの候補・統計・エラーのそのジャンルの分を差し替える */
async function collectSome(ctx, only) {
  const { paths } = ctx
  if (!fs.existsSync(paths.candidates)) throw new Error("保存済みの候補がありません。先に --genre なしで collect を実行してください")
  if (ctx.date !== todayJst(ctx.now)) {
    throw new Error(`収集は実行時点から直近の投稿が対象なので、--date には今日（${todayJst(ctx.now)}）しか指定できません`)
  }
  const genres = targetGenres(ctx.config, only)
  if (genres.length === 0) throw new Error("取り直せるジャンルがありません")
  const ids = new Set(genres.map((g) => g.id))
  const { candidates, errors, stats, xReads } = await fetchAll(ctx, genres)

  const saved = readJson(paths.candidates)
  // 取り直したジャンルの分と、config.yaml から消したジャンルの分、取り直した候補と同じもの（別ジャンルで集めた分）は捨てる
  const known = new Set(ctx.config.genres.map((g) => g.id))
  const fresh = new Set(candidates.map((c) => c.key))
  const merged = [...saved.filter((c) => !ids.has(c.genre) && known.has(c.genre) && !fresh.has(c.key)), ...candidates]
  writeJson(paths.candidates, merged)
  const collected = readJson(paths.collect, {})
  writeJson(paths.collect, {
    ...collected,
    stats: { ...collected.stats, ...stats },
    errors: [...(collected.errors ?? []).filter((e) => !ids.has(e.genre)), ...errors],
    xReads: (collected.xReads ?? 0) + xReads,
    // 取り直した時刻は対象期間とずれるので記録しておく
    recollected: [...(collected.recollected ?? []), { genres: [...ids], at: new Date().toISOString() }],
  })
  console.log(`\n${[...ids].join(", ")} を取り直しました（${candidates.length}件）。候補は全部で ${merged.length}件です`)
  if (errors.length) console.log(`⚠️ 収集エラー: ${errors.map((e) => e.genre).join(", ")}`)
}
