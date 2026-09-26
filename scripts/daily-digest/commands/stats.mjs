/*
 * 直近の日ごとの選定（.digest-cache/<date>/selection.json の adopt）を集計し、
 * ジャンルごとの採用率と、curation.yaml のルールにしてよさそうなものを出す。
 * 集計するのは、selection.json と shortlist.json が残っている日だけ（.digest-cache は手元にしかない）。
 */
import fs from "node:fs"
import path from "node:path"
import { activeRules, loadCuration } from "../lib/curation.mjs"
import { readJson } from "../lib/context.mjs"
import { resolveKey } from "../lib/review.mjs"
import { aggregate, suggest } from "../lib/stats.mjs"

const CACHE = ".digest-cache"
// 何日分（何日出て・何件採用されて）からルールを提案するか
const MIN_DAYS = 3

/** date（YYYY-MM-DD）から days 日さかのぼった範囲の、選定が残っている日 */
function loadDays(until, days) {
  if (!fs.existsSync(CACHE)) return []
  const from = new Date(Date.parse(until) - (days - 1) * 86400_000).toISOString().slice(0, 10)
  return fs
    .readdirSync(CACHE)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= from && d <= until)
    .sort()
    .flatMap((date) => {
      const dir = path.join(CACHE, date)
      const selection = readJson(path.join(dir, "selection.json"), null)
      const shortlist = readJson(path.join(dir, "shortlist.json"), null)
      if (!selection || !shortlist) return []
      const numbers = readJson(path.join(dir, "numbers.json"), {})
      const adopt = new Map()
      for (const i of selection.items ?? []) {
        try {
          adopt.set(resolveKey(i.key, numbers), i.adopt !== false)
        } catch {}
      }
      const items = shortlist.map((c) => ({
        key: c.key,
        genre: c.genre,
        genreLabel: c.genreLabel,
        authorKey: c.authorKey,
        authorName: c.author?.name ?? c.authorKey,
        adopt: adopt.get(c.key) === true,
      }))
      return [{ date, items }]
    })
}

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "-")

export function stats(ctx, { days = 30 } = {}) {
  const loaded = loadDays(ctx.date, days)
  if (loaded.length === 0) {
    console.log(`${ctx.date} までの ${days}日間に、選定（selection.json）が残っている日がありません`)
    return
  }
  const { genres, authors } = aggregate(loaded)
  console.log(`# ${loaded[0].date} 〜 ${loaded.at(-1).date} の選定（${loaded.length}日分）\n`)
  console.log("## ジャンルごとの採用率（候補一覧に出た件数 → 採用）")
  for (const g of [...genres].sort((a, b) => a.adopted / a.shown - b.adopted / b.shown)) {
    console.log(`- ${g.id}（${g.label}）: ${g.shown}件 → ${g.adopted}件（${pct(g.adopted, g.shown)}、${g.days}日）`)
  }
  const often = [...authors].filter((a) => a.adopted >= 2).sort((a, b) => b.adopted - a.adopted)
  if (often.length) {
    console.log("\n## 何度も採用された投稿者")
    for (const a of often.slice(0, 15)) console.log(`- ${a.name} [${a.id}]: ${a.shown}件中 ${a.adopted}件`)
  }

  const { rules } = loadCuration()
  // ジャンル・投稿者だけを条件にしたルールがすでにある対象は、提案しない
  const ruled = new Set(
    activeRules(rules, ctx.date).flatMap((r) => {
      const fields = Object.keys(r.match)
      return fields.length === 1 && ["genre", "author"].includes(fields[0]) ? [`${fields[0]}:${r.match[fields[0]]}`] : []
    }),
  )
  console.log("\n## ルールの提案")
  // 1〜2日分では、たまたま採用されなかっただけの投稿者まで提案してしまう
  if (loaded.length < MIN_DAYS) {
    console.log(`選定が ${MIN_DAYS}日分たまってから提案します（今は ${loaded.length}日分）`)
    return
  }
  const suggestions = suggest({ genres, authors }, { minDays: MIN_DAYS, hasRule: (t) => ruled.has(t) })
  if (suggestions.length === 0) console.log("提案はありません")
  for (const s of suggestions) {
    const cmd = s.action === "weight" ? `curate weight ${s.target} ${s.weight}` : `curate block ${s.target}`
    console.log(`- ${s.why}\n    pnpm -s digest ${cmd} --reason "<理由>"`)
  }
}
