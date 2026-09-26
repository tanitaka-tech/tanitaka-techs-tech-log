import fs from "node:fs"
import { readJson } from "../lib/context.mjs"
import { listItemsByFile } from "../lib/render.mjs"
import { formatReview, resolveKey, runReview } from "../lib/review.mjs"

export function review(ctx, { all = false } = {}) {
  const { entries, numbers, expired } = runReview(ctx)
  const selection = readJson(ctx.paths.selection, null)
  const selectedKeys = new Set(
    (selection?.items ?? []).map((i) => {
      try {
        return resolveKey(i.key, numbers)
      } catch {
        return i.key
      }
    }),
  )

  const collected = readJson(ctx.paths.collect, {})
  const span = collected.window
    ? `、${new Date(collected.window.start).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })} 〜 ${new Date(collected.window.end).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })} の投稿`
    : ""
  console.log(`# ${ctx.date} の候補${span}（✅ 選択中 / 📌 pin / スコアは curation.yaml の重み適用後）`)
  if (collected.errors?.length) {
    console.log(`⚠️ 収集エラー: ${collected.errors.map((e) => `${e.genre}（${e.message.slice(0, 80)}）`).join(", ")}`)
  }
  console.log(formatReview(ctx, entries, { all, selectedKeys }))

  const blocked = entries.filter((e) => e.excluded && e.excluded !== "掲載済み").length
  const shortlisted = entries.filter((e) => e.shortlisted).length
  console.log(
    `\n候補一覧 ${shortlisted}件 / ルールで除外 ${blocked}件${all ? "" : "（--all で除外・圏外も表示）"}` +
      `${expired ? ` / 期限切れのルール ${expired}件` : ""}`,
  )
  if (collected.stats) console.log(formatYield(ctx, entries, collected.stats))
  console.log(`詳細（本文・共有者など）: ${ctx.paths.shortlist}`)
  if (selection) console.log(`選定: ${ctx.paths.selection}（${selection.items?.length ?? 0}件）`)
  if (fs.existsSync(ctx.articlePath)) console.log(`記事: ${ctx.articlePath}`)
}

/**
 * ジャンルごとの歩留まり（候補 → ルールで残った件数 → 記事に載った件数。X のジャンルは読み取り件数も）。
 * 候補が少ない・ルールで多く外れるジャンルは、収集の条件（include・exclude・下限など）を見直す
 */
function formatYield(ctx, entries, stats) {
  const published = new Set(listItemsByFile(ctx.config.article.dir).find((f) => f.file === ctx.articlePath)?.keys)
  const lines = ["\n## ジャンルごとの歩留まり（候補 → ルール適用後 → 記事に掲載。X は読み取り件数から）"]
  for (const g of ctx.config.genres) {
    const s = stats[g.id]
    if (!s) continue
    const mine = entries.filter((e) => e.c.genre === g.id)
    const kept = mine.filter((e) => !e.excluded).length
    const picked = mine.filter((e) => published.has(e.c.key)).length
    const reads = s.reads ? `${s.reads}件読み → ` : ""
    const rate = s.reads ? `（読み取り100件あたり ${((kept / s.reads) * 100).toFixed(1)}件）` : ""
    lines.push(`- ${g.id}: ${reads}候補 ${s.candidates} → ${kept} → 掲載 ${picked}${rate}`)
    // 収集で外した理由の内訳。多い理由の条件（いいね数・期間など）を見直す
    const drops = Object.entries(s.drops ?? {}).sort((a, b) => b[1] - a[1])
    if (drops.length) lines.push(`    収集で除外: ${drops.map(([r, n]) => `${r} ${n}`).join(" / ")}`)
  }
  return lines.join("\n")
}
