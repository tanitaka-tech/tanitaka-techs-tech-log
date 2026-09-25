/*
 * selection.json（Claude Code か select コマンドが書いた選定結果）から記事の Markdown を作る。
 * タイトル・説明の添削も selection.json の topic / description を直して render し直す。
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import { readJson } from "../lib/context.mjs"
import { renderArticle } from "../lib/render.mjs"
import { resolveKey, runReview } from "../lib/review.mjs"

/** 公開済み（develop にコミット済み）の記事を誤って上書きしないよう、git で追跡中か調べる */
function isTracked(file) {
  return spawnSync("git", ["ls-files", "--error-unmatch", file], { stdio: "ignore" }).status === 0
}

export function render(ctx, { force = false } = {}) {
  const { config, date, articlePath, categoryLimit } = ctx
  if (isTracked(articlePath) && !force) {
    throw new Error(`${articlePath} はコミット済みです。上書きするときは --force を付けてください`)
  }

  const { entries, numbers } = runReview(ctx)
  const available = new Map(entries.filter((e) => !e.excluded).map((e) => [e.c.key, e]))
  const raw = readJson(ctx.paths.selection)

  const warnings = []
  const perCategory = new Map()
  const seen = new Set()
  const items = []
  for (const item of raw.items ?? []) {
    let key
    try {
      key = resolveKey(item.key, numbers)
    } catch (e) {
      warnings.push(e.message)
      continue
    }
    const e = available.get(key)
    if (!e) {
      const found = entries.find((x) => x.c.key === key)
      warnings.push(`${item.key}: ${found ? `除外されています（${found.excluded}）` : "候補にありません"}`)
      continue
    }
    if (seen.has(key)) continue
    const label = e.c.genreLabel
    const n = perCategory.get(label) ?? 0
    if (n >= categoryLimit(label)) {
      warnings.push(`#${e.no}: ${label} の上限 ${categoryLimit(label)} 件を超えるので外しました`)
      continue
    }
    if (items.length >= config.article.maxItems) {
      warnings.push(`#${e.no}: 記事全体の上限 ${config.article.maxItems} 件を超えるので外しました`)
      continue
    }
    seen.add(key)
    perCategory.set(label, n + 1)
    items.push({ ...item, key })
  }
  if (items.length === 0) throw new Error("掲載できる項目がありません")
  if (items.length < config.article.minItems) {
    warnings.push(`掲載は ${items.length} 件です（目安の下限は ${config.article.minItems} 件）`)
  }

  const topic = String(raw.topic ?? "")
    .replace(/\s+/g, " ")
    .replace(/\s*\d{4}-\d{2}-\d{2}\s*$/, "")
    .trim()
  if (!topic) throw new Error("selection.json の topic（記事タイトルの前半）が空です")
  let topicKey = raw.topicKey
  try {
    topicKey = topicKey ? resolveKey(topicKey, numbers) : items[0].key
  } catch (e) {
    warnings.push(`topicKey: ${e.message}`)
    topicKey = items[0].key
  }

  const article = renderArticle({
    date,
    selection: { topic, topicKey, description: raw.description ?? "", items },
    candidatesByKey: new Map([...available].map(([k, e]) => [k, e.c])),
    category: config.article.category,
    fixedTags: config.article.tags ?? [],
    categoryOrder: config.article.categoryOrder,
    stepOrder: ctx.stepOrder,
  })
  fs.mkdirSync(config.article.dir, { recursive: true })
  fs.writeFileSync(articlePath, article)

  console.log(`${articlePath} を書き出しました: ${topic} ${date}`)
  for (const [label, n] of perCategory) console.log(`  ${label}: ${n}件`)
  for (const i of items.filter((i) => i.note)) console.log(`  ⚠️ #${numbers[i.key]} ${i.note}`)
  for (const w of warnings) console.log(`  ⚠️ ${w}`)
  console.log(`\nプレビュー（pnpm dev）: http://localhost:4321/tanitaka-techs-tech-log/posts/daily-digest/${date}/`)
}
