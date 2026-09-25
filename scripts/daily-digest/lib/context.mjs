import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"
import { resolveTargetDate } from "./date.mjs"

export const CONFIG_PATH = "scripts/daily-digest/config.yaml"

/** 各サブコマンドで共通に使う設定・記事の日付・キャッシュのパス */
export function loadContext({ date: input, xLimit } = {}) {
  const config = YAML.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
  for (const g of config.genres) {
    if (!config.article.categoryOrder.includes(g.label)) {
      throw new Error(`config.yaml の article.categoryOrder にジャンル ${g.id} のラベル「${g.label}」がありません`)
    }
  }
  if (xLimit) config.x.maxPostsPerRun = Number(xLimit)

  const now = new Date()
  const date = resolveTargetDate(input, now)
  const dir = path.join(".digest-cache", date)
  const { maxItemsPerCategory, maxItemsByCategory = {} } = config.article
  return {
    config,
    now,
    date,
    dir,
    articlePath: path.join(config.article.dir, `${date}.md`),
    paths: {
      candidates: path.join(dir, "candidates.json"),
      collect: path.join(dir, "collect.json"),
      numbers: path.join(dir, "numbers.json"),
      shortlist: path.join(dir, "shortlist.json"),
      selection: path.join(dir, "selection.json"),
    },
    genreById: new Map(config.genres.map((g) => [g.id, g])),
    // カルーセル内の区切りの表示順。genres に最初に出てくる順
    stepOrder: [...new Set(config.genres.map((g) => g.step).filter(Boolean))],
    categoryLimit: (label) => maxItemsByCategory[label] ?? maxItemsPerCategory,
  }
}

export function readJson(file, fallback) {
  if (!fs.existsSync(file)) {
    if (fallback !== undefined) return fallback
    throw new Error(`${file} がありません`)
  }
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

export function readCandidates(ctx) {
  if (!fs.existsSync(ctx.paths.candidates)) {
    throw new Error(`${ctx.date} の候補がまだありません。先に pnpm digest collect --date ${ctx.date} を実行してください`)
  }
  return readJson(ctx.paths.candidates)
}
