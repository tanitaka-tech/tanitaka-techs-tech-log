/*
 * デイリーダイジェスト記事を生成する。
 *
 * 使い方:
 *   pnpm digest [--date YYYY-MM-DD] [--x-limit N] [--fixture candidates.json]
 *               [--llm openai,gemini] [--mock-llm] [--selection selection.json]
 *
 * 環境変数: X_BEARER_TOKEN, YOUTUBE_API_KEY と、ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY の
 * いずれか（ローカルでは .env から読む）。LLM は config.yaml の llm.providers の順に試す。
 * 生データ（投稿本文など）は .digest-cache/<date>/ に保存し、リポジトリにはコミットしない。
 */
import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import YAML from "yaml"
import { loadDotEnv } from "./lib/env.mjs"
import { dayWindowJst, resolveTargetDate } from "./lib/date.mjs"
import { mockSelect, selectAndWrite } from "./lib/llm.mjs"
import { loadUsedKeys, renderArticle } from "./lib/render.mjs"
import { fetchSteamSales } from "./lib/steam.mjs"
import { searchXGenre } from "./lib/x.mjs"
import { collectXYoutubeGenre } from "./lib/x-youtube.mjs"
import { searchYoutubeGenre } from "./lib/youtube.mjs"

const { values: args } = parseArgs({
  options: {
    date: { type: "string" },
    fixture: { type: "string" },
    // 使う LLM プロバイダーと順番を config.yaml から絞り込む（例: --llm gemini,openai）
    llm: { type: "string" },
    "mock-llm": { type: "boolean", default: false },
    // LLM を呼ばず、手で書いた選定結果（selection.json と同じ形）から記事を作る
    selection: { type: "string" },
    // X の読み取り上限を一時的に下げる（ローカルで安く試す用）
    "x-limit": { type: "string" },
  },
})

loadDotEnv()

const config = YAML.parse(fs.readFileSync("scripts/daily-digest/config.yaml", "utf8"))
if (args["x-limit"]) config.x.maxPostsPerRun = Number(args["x-limit"])
for (const g of config.genres) {
  if (!config.article.categoryOrder.includes(g.label)) {
    throw new Error(`config.yaml の article.categoryOrder にジャンル ${g.id} のラベル「${g.label}」がありません`)
  }
}
const llmProviders = args.llm
  ? args.llm.split(",").map((name) => {
      const p = config.llm.providers.find((p) => p.provider === name.trim())
      if (!p) throw new Error(`config.yaml の llm.providers に ${name} がありません`)
      return p
    })
  : config.llm.providers
const now = new Date()
const date = resolveTargetDate(args.date, now)
const window = dayWindowJst(date, now)
const cacheDir = path.join(".digest-cache", date)
const articlePath = path.join(config.article.dir, `${date}.md`)
fs.mkdirSync(cacheDir, { recursive: true })

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
  }
}

function requireEnv(name) {
  const v = process.env[name]
  if (!v) throw new Error(`環境変数 ${name} が空です`)
  return v
}

async function collect() {
  if (args.fixture) {
    return { candidates: JSON.parse(fs.readFileSync(args.fixture, "utf8")), errors: [], xReads: 0 }
  }
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
  return { candidates, errors, xReads: config.x.maxPostsPerRun - budget.remaining }
}

/** 掲載済みを除き、ジャンルごとにスコア上位だけを残す */
function shortlist(candidates) {
  const used = loadUsedKeys(config.article.dir)
  const seen = new Set()
  const byGenre = new Map()
  for (const c of [...candidates].sort((a, b) => b.score - a.score)) {
    if (used.has(c.key) || seen.has(c.key)) continue
    seen.add(c.key)
    const list = byGenre.get(c.genre) ?? []
    if (list.length < config.llm.candidatesPerGenre) list.push(c)
    byGenre.set(c.genre, list)
  }
  return [...byGenre.values()].flat()
}

/** LLM の出力を検証し、存在しないキー・重複・カテゴリの上限超えを取り除く */
function validateSelection(selection, byKey) {
  const perGenre = new Map()
  const seen = new Set()
  const items = []
  for (const item of selection.items) {
    const c = byKey.get(item.key)
    if (!c || seen.has(item.key)) continue
    const n = perGenre.get(c.genreLabel) ?? 0
    if (n >= config.article.maxItemsPerCategory || items.length >= config.article.maxItems) continue
    seen.add(item.key)
    perGenre.set(c.genreLabel, n + 1)
    items.push(item)
  }
  const topic = selection.topic
    .replace(/\s+/g, " ")
    .replace(/\s*\d{4}-\d{2}-\d{2}\s*$/, "")
    .trim()
  return { ...selection, topic, items }
}

function formatMetrics(c) {
  const m = c.metrics
  if (c.source === "x") return `♥${m.like_count} RT${m.retweet_count} 👁${m.impression_count ?? "-"}`
  if (c.source === "youtube") return `▶${m.views} 👍${m.likes}${m.sharers ? ` 🔗${m.sharers}人` : ""}`
  return `-${m.discountPercent}%`
}

function renderPrBody({ title, selection, shortlisted, errors, xReads, llm, skippedReason }) {
  const adopted = new Map((selection?.items ?? []).map((i) => [i.key, i.note]))
  const rejected = new Map((selection?.rejected ?? []).map((r) => [r.key, r.reason]))
  const rows = shortlisted.map((c) => {
    const status = adopted.has(c.key)
      ? `✅ 採用${adopted.get(c.key) ? ` ⚠️ ${adopted.get(c.key)}` : ""}`
      : rejected.has(c.key)
        ? `❌ ${rejected.get(c.key)}`
        : "―"
    const who = c.source === "x" ? `@${c.author.handle}` : c.author.name
    return `| ${c.genreLabel} | [${who}](${c.url}) | ${formatMetrics(c)} | ${c.score.toFixed(1)} | ${status.replace(/\|/g, "／")} |`
  })

  return `## ${skippedReason ? "⏭ 記事は生成されませんでした" : `📰 ${title}`}

${skippedReason ? `理由: ${skippedReason}\n` : ""}
対象: ${date}（JST）${window.start.toISOString()} 〜 ${window.end.toISOString()}
X 読み取り件数: ${xReads} / ${config.x.maxPostsPerRun}
${llm ? `選定・要約: ${llm}\n` : ""}
### 候補一覧
| ジャンル | 投稿 | 反応 | 伸び率 | 判定 |
|---|---|---|---|---|
${rows.join("\n") || "| - | - | - | - | - |"}

${errors.length ? `### ⚠️ 収集エラー\n${errors.map((e) => `- ${e.genre}: ${e.message}`).join("\n")}\n` : ""}
### レビューチェックリスト
- [ ] タイトル・説明文が掲載内容と食い違っていない・煽りすぎていない
- [ ] 政治・事件・炎上・個人を晒す内容が含まれていない
- [ ] ⚠️ の付いた項目（性的な内容への言及など）を掲載してよいか判断した
- [ ] 自己啓発系の名言は出典が確かである
- [ ] プレビューで埋め込みが正しく表示される

差し替えたい場合は、このPRを閉じて日付を指定して再実行するか、記事ファイルを直接編集してください。
`
}

async function main() {
  const { candidates, errors, xReads } = await collect()
  // 保存済みの候補（--fixture）でも、表示名は現在の config.yaml に合わせる
  const labelById = new Map(config.genres.map((g) => [g.id, g.label]))
  for (const c of candidates) c.genreLabel = labelById.get(c.genre) ?? c.genreLabel
  fs.writeFileSync(path.join(cacheDir, "candidates.json"), JSON.stringify(candidates, null, 2))

  const shortlisted = shortlist(candidates)
  const byKey = new Map(shortlisted.map((c) => [c.key, c]))
  const { minItems, maxItems, maxItemsPerCategory: maxPerCategory } = config.article

  const skip = (reason, selection = null, llm = null) => {
    console.log(`[skip] ${reason}`)
    fs.writeFileSync(
      path.join(cacheDir, "pr-body.md"),
      renderPrBody({ title: "", selection, shortlisted, errors, xReads, llm, skippedReason: reason }),
    )
    setOutput("skipped", "true")
  }

  if (fs.existsSync(articlePath)) return skip(`${articlePath} は既に存在します`)
  if (shortlisted.length < minItems) return skip(`候補が ${shortlisted.length} 件しかありません`)

  let raw
  let llm
  if (args.selection) {
    raw = JSON.parse(fs.readFileSync(args.selection, "utf8"))
    llm = `手動（${args.selection}）`
  } else if (args["mock-llm"]) {
    raw = mockSelect(shortlisted, { maxItems, maxPerCategory })
    llm = "モック"
  } else {
    const res = await selectAndWrite(shortlisted, {
      date,
      minItems,
      maxItems,
      maxPerCategory,
      providers: llmProviders,
    })
    raw = res.selection
    llm = `${res.provider} / ${res.model}`
  }
  fs.writeFileSync(path.join(cacheDir, "selection.json"), JSON.stringify(raw, null, 2))

  const selection = validateSelection(raw, byKey)
  if (selection.items.length < minItems) {
    return skip(`掲載できる項目が ${selection.items.length} 件しかありません`, selection, llm)
  }

  const article = renderArticle({
    date,
    selection,
    candidatesByKey: byKey,
    category: config.article.category,
    fixedTags: config.article.tags ?? [],
    categoryOrder: config.article.categoryOrder,
  })
  fs.mkdirSync(config.article.dir, { recursive: true })
  fs.writeFileSync(articlePath, article)

  const title = `${selection.topic} ${date}`
  fs.writeFileSync(
    path.join(cacheDir, "pr-body.md"),
    renderPrBody({ title, selection, shortlisted, errors, xReads, llm }),
  )
  console.log(`[done] ${articlePath}: ${title}`)
  setOutput("skipped", "false")
  setOutput("article", articlePath)
  setOutput("title", title)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
