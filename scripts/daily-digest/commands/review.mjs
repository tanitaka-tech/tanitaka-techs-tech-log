import fs from "node:fs"
import { readJson } from "../lib/context.mjs"
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
  console.log(`詳細（本文・共有者など）: ${ctx.paths.shortlist}`)
  if (selection) console.log(`選定: ${ctx.paths.selection}（${selection.items?.length ?? 0}件）`)
  if (fs.existsSync(ctx.articlePath)) console.log(`記事: ${ctx.articlePath}`)
}
