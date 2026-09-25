/*
 * LLM の API で候補一覧から掲載項目を選び、selection.json に保存する。
 * 普段は Claude Code（/digest スキル）が会話の中で selection.json を書くので、これは API で済ませたいとき用。
 */
import { readJson, writeJson } from "../lib/context.mjs"
import { mockSelect, selectAndWrite } from "../lib/llm.mjs"
import { runReview } from "../lib/review.mjs"

export async function select(ctx, { llm = false, providers: names, mock = false } = {}) {
  if (!llm && !mock) {
    throw new Error(
      "--llm（API で選ぶ）か --mock（スコア上位を機械的に選ぶ）を指定してください。Claude Code では selection.json を直接書きます",
    )
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
