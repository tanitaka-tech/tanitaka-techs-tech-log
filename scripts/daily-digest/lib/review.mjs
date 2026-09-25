/*
 * 収集済みの候補に curation.yaml を適用し、ジャンルごとの上位を「候補一覧」として番号付きで並べる。
 * 番号は対象日ごとに numbers.json に保存し、ルールを足して並びが変わっても同じ候補は同じ番号のままにする。
 */
import { activeRules, applyRules, authorKey, loadCuration } from "./curation.mjs"
import { readCandidates, readJson, writeJson } from "./context.mjs"
import { loadUsedKeys } from "./render.mjs"

export function buildReview(ctx, candidates, { rules, usedKeys }) {
  const { config, genreById, stepOrder } = ctx
  const perGenre = config.review.candidatesPerGenre
  const categoryRank = (c) => config.article.categoryOrder.indexOf(c.genreLabel)
  const genreRank = (c) => config.genres.findIndex((g) => g.id === c.genre)
  const stepRank = (c) => (c.step ? stepOrder.indexOf(c.step) : -1)

  const scored = candidates
    .map((raw) => {
      // 保存済みの候補でも、表示名は現在の config.yaml に合わせる
      const g = genreById.get(raw.genre)
      const c = { ...raw, genreLabel: g?.label ?? raw.genreLabel, step: g?.step }
      return { ...applyRules(c, rules, g), baseScore: raw.score }
    })
    .sort((a, b) => b.c.score - a.c.score)

  const seen = new Set()
  const entries = []
  for (const e of scored) {
    // 同じ動画が複数のジャンルで見つかったら、スコアの高い方だけを残す
    if (seen.has(e.c.key)) continue
    seen.add(e.c.key)
    if (usedKeys.has(e.c.key)) e.excluded = "掲載済み"
    else if (e.blocked) e.excluded = e.blocked
    entries.push(e)
  }

  // ジャンルごとにスコア上位 perGenre 件と、pin された候補を候補一覧に入れる
  const counts = new Map()
  for (const e of entries) {
    if (e.excluded) continue
    const n = counts.get(e.c.genre) ?? 0
    e.shortlisted = e.pinned || n < perGenre
    if (!e.pinned) counts.set(e.c.genre, n + 1)
  }

  // 表示順: カテゴリ → 区切り（step）→ step がなければジャンル → スコア。ソースが違うとスコアの単位が違うため
  entries.sort(
    (a, b) =>
      categoryRank(a.c) - categoryRank(b.c) ||
      stepRank(a.c) - stepRank(b.c) ||
      (a.c.step ? 0 : genreRank(a.c) - genreRank(b.c)) ||
      b.c.score - a.c.score,
  )
  return entries
}

/** 番号がまだない候補に、候補一覧に入ったもの → それ以外の順で番号を振る */
export function assignNumbers(entries, numbers) {
  let next = Math.max(0, ...Object.values(numbers)) + 1
  for (const group of [entries.filter((e) => e.shortlisted), entries.filter((e) => !e.shortlisted)]) {
    for (const e of group) {
      if (e.excluded === "掲載済み") continue
      numbers[e.c.key] ??= next++
    }
  }
  for (const e of entries) e.no = numbers[e.c.key]
  return numbers
}

/** 候補を読み込み、ルールを適用して番号を振り、shortlist.json に保存する */
export function runReview(ctx) {
  const { rules } = loadCuration()
  const active = activeRules(rules, ctx.date)
  // 作成中の記事に載っている項目は「掲載済み」にしない
  const usedKeys = loadUsedKeys(ctx.config.article.dir, { exclude: [`${ctx.date}.md`] })

  const entries = buildReview(ctx, readCandidates(ctx), { rules: active, usedKeys })
  const numbers = assignNumbers(entries, readJson(ctx.paths.numbers, {}))
  writeJson(ctx.paths.numbers, numbers)
  writeJson(
    ctx.paths.shortlist,
    entries.filter((e) => e.shortlisted).map((e) => toShortlistItem(e)),
  )
  return { entries, numbers, expired: rules.length - active.length }
}

function toShortlistItem(e) {
  const c = e.c
  return {
    no: e.no,
    key: c.key,
    genre: c.genre,
    genreLabel: c.genreLabel,
    step: c.step,
    source: c.source,
    title: c.title || undefined,
    text: c.text,
    author: c.author,
    authorKey: authorKey(c),
    url: c.url,
    publishedAt: c.publishedAt,
    metrics: c.metrics,
    sharedBy: c.sharedBy,
    score: c.score,
    baseScore: e.baseScore,
    weight: e.weight,
    pinned: e.pinned || undefined,
    rules: e.applied.length ? e.applied : undefined,
  }
}

/** "#3" / "3" / "x:123" を候補のキーにする */
export function resolveKey(ref, numbers) {
  const m = String(ref).match(/^#?(\d+)$/)
  if (!m) return ref
  const key = Object.keys(numbers).find((k) => numbers[k] === Number(m[1]))
  if (!key) throw new Error(`候補 #${m[1]} が見つかりません（pnpm digest review で番号を確認してください）`)
  return key
}

const fmt = (n) => Number(n ?? 0).toLocaleString("ja-JP")

export function formatMetrics(c) {
  const m = c.metrics
  if (c.source === "x") return `♥${fmt(m.like_count)} RT${fmt(m.retweet_count)} 👁${m.impression_count != null ? fmt(m.impression_count) : "-"}`
  if (c.source === "youtube") return `▶${fmt(m.views)} 👍${fmt(m.likes)}${m.sharers ? ` 🔗${m.sharers}人` : ""}`
  if (c.source === "hatena") return `🔖${fmt(m.bookmarks)}users`
  if (c.source === "bluesky") return `♥${fmt(m.likes)} RP${fmt(m.reposts)}`
  if (c.source === "misskey") return `😀${fmt(m.reactions)} RN${fmt(m.renotes)}${c.images?.length ? ` 🖼${c.images.length}` : ""}`
  if (c.source === "pixiv") return `♥${fmt(m.ratings)} 👁${fmt(m.views)} ${m.rank}位`
  if (c.source === "soundcloud") return `▶${fmt(m.plays)} ♥${fmt(m.likes)}${m.sharers ? ` 🔗${m.sharers}人` : ""}`
  if (m.players != null) return `👥${fmt(m.players)}人`
  return `-${m.discountPercent}%`
}

function oneLine(s, max) {
  const t = (s ?? "").replace(/\s+/g, " ").trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

function formatEntry(e, selected) {
  const c = e.c
  const marks = `${selected.has(c.key) ? "✅" : ""}${e.pinned ? "📌" : ""}`
  const weight = e.weight !== 1 ? `（×${Number(e.weight.toFixed(3))}）` : ""
  const who = ["x", "bluesky", "misskey"].includes(c.source) ? `${c.author.name} @${c.author.handle}` : c.author.name
  const lines = [
    `#${e.no ?? "-"} ${marks}${marks ? " " : ""}${c.score.toFixed(2)}${weight} ${formatMetrics(c)} | ${who} [author:${authorKey(c)}] {${c.genre}}`,
    `    ${oneLine(c.title || c.text, 90)}`,
    `    ${c.url}`,
  ]
  if (c.sharedBy?.length) lines.push(`    共有: ${c.sharedBy.slice(0, 8).join(" ")}${c.sharedBy.length > 8 ? " …" : ""}`)
  if (e.applied.length) lines.push(`    ルール: ${e.applied.join(" ")}`)
  if (e.excluded) lines.push(`    除外: ${e.excluded}`)
  return lines.join("\n")
}

/** 候補一覧をテキストにする。all が true なら除外・圏外の候補も出す */
export function formatReview(ctx, entries, { all = false, selectedKeys = new Set() } = {}) {
  const out = []
  for (const label of ctx.config.article.categoryOrder) {
    const inCategory = entries.filter((e) => e.c.genreLabel === label && e.excluded !== "掲載済み")
    if (inCategory.length === 0) continue
    const shown = inCategory.filter((e) => all || e.shortlisted)
    const picked = inCategory.filter((e) => selectedKeys.has(e.c.key)).length
    out.push(
      `\n## ${label}（候補 ${inCategory.filter((e) => e.shortlisted).length} / 全 ${inCategory.length}件、選択 ${picked} / 上限 ${ctx.categoryLimit(label)}）`,
    )
    let step
    for (const e of shown) {
      if (e.c.step && e.c.step !== step) {
        step = e.c.step
        out.push(`### ${step}`)
      }
      out.push(formatEntry(e, selectedKeys))
    }
  }
  return out.join("\n")
}
