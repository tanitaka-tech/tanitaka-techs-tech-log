/*
 * selection.json（Claude Code か select コマンドが書いた選定結果）から記事の Markdown を作る。
 * タイトル・説明の添削も selection.json の topic / description を直して render し直す。
 *
 * 既定はプレビュー用: 候補を上限で削らずにすべて載せ、項目ごとの注意（note）と警告の一覧を記事に表示する。
 * 人間はプレビューで項目ごとの採用トグル（pnpm dev のときだけ出る）を切り替えて、載せる項目を決める。
 * 採用・不採用は selection.json の各項目の adopt に保存される（false が不採用、それ以外は採用）。
 * --final（publish が自動で使う）では、採用の項目だけを警告なしで載せ、上限を超えていればエラーにする。
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

export function render(ctx, { force = false, final = false } = {}) {
  const { config, date, articlePath, categoryLimit } = ctx
  if (isTracked(articlePath) && !force) {
    throw new Error(`${articlePath} はコミット済みです。上書きするときは --force を付けてください`)
  }

  const { entries, numbers } = runReview(ctx)
  const available = new Map(entries.filter((e) => !e.excluded).map((e) => [e.c.key, e]))
  const raw = readJson(ctx.paths.selection)

  const warnings = []
  // 上限を超えているカテゴリ・記事全体
  const overLimit = []
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
    // 公開用には、プレビューで不採用にした項目を載せない
    if (final && item.adopt === false) continue
    const label = e.c.genreLabel
    seen.add(key)
    // 上限は採用した項目で数える
    if (item.adopt !== false) perCategory.set(label, (perCategory.get(label) ?? 0) + 1)
    items.push({ ...item, key })
  }
  // プレビューでは上限を超えても載せ、どれを外すか人間が決められるようにする（カテゴリ・記事全体ごとに1行で知らせる）
  for (const [label, n] of perCategory) {
    if (n > categoryLimit(label)) overLimit.push(`${label}: 採用 ${n}件（上限 ${categoryLimit(label)}件）`)
  }
  // note（注意）を付けた項目は不採用にしておく決まり。採用のままなら、見落としかもしれないので知らせる
  for (const i of items.filter((i) => i.note && i.adopt !== false)) {
    warnings.push(`#${numbers[i.key]}: 注意（${i.note}）があるのに採用になっています`)
  }
  const adopted = items.filter((i) => i.adopt !== false).length
  if (adopted > config.article.maxItems) {
    overLimit.push(`記事全体: 採用 ${adopted}件（上限 ${config.article.maxItems}件）`)
  }
  if (final && overLimit.length) {
    throw new Error(`上限を超えている項目があります。selection.json から外してください:\n${overLimit.join("\n")}`)
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

  const collected = readJson(ctx.paths.collect, {})
  // プレビューの記事の先頭に出す警告。公開する記事（--final）には出さない
  const reviewWarnings = final
    ? null
    : [
        ...(collected.errors ?? []).map((e) => `収集エラー: ${e.genre}（${e.message.slice(0, 60)}）`),
        ...warnings,
        ...overLimit,
        ...items.filter((i) => i.note).map((i) => `#${numbers[i.key]}: ${i.note}`),
      ]
  const article = renderArticle({
    date,
    selection: { topic, topicKey, description: raw.description ?? "", items },
    review: reviewWarnings,
    categoryLimit,
    // プレビューで並べ替えた記事は、selection.json の順のまま載せる
    keepOrder: raw.ordered === true,
    candidatesByKey: new Map([...available].map(([k, e]) => [k, e.c])),
    category: config.article.category,
    fixedTags: config.article.tags ?? [],
    categoryOrder: config.article.categoryOrder,
    stepOrder: ctx.stepOrder,
  })
  fs.mkdirSync(config.article.dir, { recursive: true })
  fs.writeFileSync(articlePath, article)

  console.log(`${articlePath} を書き出しました${final ? "（公開用）" : "（プレビュー用。警告を記事に表示しています）"}: ${topic} ${date}`)
  for (const [label, n] of perCategory) console.log(`  ${label}: ${n}件`)
  for (const i of items.filter((i) => i.note)) console.log(`  ⚠️ #${numbers[i.key]} ${i.note}`)
  for (const w of [...warnings, ...overLimit]) console.log(`  ⚠️ ${w}`)
  console.log(`\nプレビュー（pnpm dev）: http://localhost:4321/tanitaka-techs-tech-log/posts/daily-digest/${date}/`)
}
