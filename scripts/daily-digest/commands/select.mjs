/*
 * 候補一覧から掲載項目を選び、selection.json に保存する。
 *   --draft: 候補一覧のすべてを入れた下書きを作る（おすすめは上限に収まるよう機械的に選ぶ）。/digest スキルはこれを使い、
 *            note・おすすめの入れ替え・タイトル・説明を書き足す。selection.json があれば、まだない候補を足すだけ（--reset で作り直す）
 *   --llm:   LLM の API で選ぶ（API で済ませたいとき用）
 *   --mock:  スコア上位を機械的に選ぶ（動作確認用）
 */
import fs from "node:fs"
import { readJson, writeJson } from "../lib/context.mjs"
import { draftSelection } from "../lib/draft.mjs"
import { mockSelect, selectAndWrite } from "../lib/llm.mjs"
import { resolveKey, runReview } from "../lib/review.mjs"

function draft(ctx, { reset }) {
  const { numbers } = runReview(ctx)
  const shortlist = readJson(ctx.paths.shortlist)
  const previous = !reset && fs.existsSync(ctx.paths.selection) ? readJson(ctx.paths.selection) : null
  const resolve = (k) => {
    try {
      return resolveKey(k, numbers)
    } catch {
      return k
    }
  }
  const { selection, added } = draftSelection(shortlist, {
    maxItems: ctx.config.article.maxItems,
    categoryLimit: ctx.categoryLimit,
    previous,
    resolve,
  })
  writeJson(ctx.paths.selection, selection)
  const adopted = selection.items.filter((i) => i.adopt !== false).length
  console.log(
    previous
      ? `${ctx.paths.selection} に、まだなかった候補 ${added}件を不採用で足しました（全 ${selection.items.length}件、採用 ${adopted}件）`
      : `${ctx.paths.selection} に下書きを作りました（全 ${selection.items.length}件、おすすめ ${adopted}件）。topic・description を書いてから render してください`,
  )
}

export async function select(ctx, { llm = false, providers: names, mock = false, draft: isDraft = false, reset = false } = {}) {
  if (isDraft) return draft(ctx, { reset })
  if (!llm && !mock) {
    throw new Error("--draft（候補一覧から下書きを作る）・--llm（API で選ぶ）・--mock（スコア上位を機械的に選ぶ）のどれかを指定してください")
  }
  runReview(ctx)
  const shortlisted = readJson(ctx.paths.shortlist)
  const { config, date, categoryLimit } = ctx
  const { minItems, maxItems, maxItemsPerCategory, maxItemsByCategory = {} } = config.article

  let selection
  if (mock) {
    selection = mockSelect(shortlisted, { maxItems, categoryLimit })
  } else {
    const providers = names
      ? names.split(",").map((name) => {
          const p = config.llm.providers.find((p) => p.provider === name.trim())
          if (!p) throw new Error(`config.yaml の llm.providers に ${name} がありません`)
          return p
        })
      : config.llm.providers
    const res = await selectAndWrite(shortlisted, {
      date,
      minItems,
      maxItems,
      maxPerCategory: maxItemsPerCategory,
      maxItemsByCategory,
      providers,
    })
    selection = { ...res.selection, by: `${res.provider} / ${res.model}` }
  }
  writeJson(ctx.paths.selection, selection)

  const byKey = new Map(shortlisted.map((c) => [c.key, c]))
  console.log(`タイトル: ${selection.topic}\n説明: ${selection.description}\n`)
  for (const i of selection.items) {
    const c = byKey.get(i.key)
    console.log(`✅ #${c?.no ?? "?"} ${c?.genreLabel ?? ""} ${c?.title || c?.text?.slice(0, 40) || i.key}${i.note ? ` ⚠️ ${i.note}` : ""}`)
  }
  for (const r of selection.rejected ?? []) {
    console.log(`❌ #${byKey.get(r.key)?.no ?? "?"} ${r.reason}`)
  }
  console.log(`\n${ctx.paths.selection} に保存しました。pnpm digest render で記事にします`)
}
