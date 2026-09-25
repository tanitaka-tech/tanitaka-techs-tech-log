/*
 * curation.yaml にルールを足す・消す。候補番号（#3）や @handle から ID を引いて書き込む。
 *
 *   curate block  <対象> --reason 理由 [--until YYYY-MM-DD] [--genre ジャンルID]
 *   curate weight <対象> <倍率> --reason 理由 ...
 *   curate pin    <対象> --reason 理由 ...
 *   curate ignore-sharer <@handle | x:ユーザーID> --reason 理由
 *   curate unset  <対象>            … 対象と同じ条件のルールを消す
 *   curate list                     … ルールの一覧
 *
 * 対象: #3（候補） / author:#3（候補の投稿者） / x:123・youtube:abc・soundcloud:123（キー）
 *       author:x:<ユーザーID>・author:youtube:<チャンネルID> / genre:<ジャンルID> / text:<正規表現>
 */
import fs from "node:fs"
import { addRule, authorKey, CURATION_PATH, describeRule, loadCuration, removeRules, saveCuration } from "../lib/curation.mjs"
import { readJson } from "../lib/context.mjs"
import { todayJst } from "../lib/date.mjs"
import { resolveKey } from "../lib/review.mjs"

function candidateByKey(ctx, key) {
  const list = fs.existsSync(ctx.paths.candidates) ? readJson(ctx.paths.candidates) : []
  return list.find((c) => c.key === key)
}

function parseTarget(ctx, target) {
  if (!target) throw new Error("対象（#3 / author:#3 / genre:vtuber など）を指定してください")
  const numbers = readJson(ctx.paths.numbers, {})

  if (target.startsWith("author:")) {
    const ref = target.slice("author:".length)
    if (/^#?\d+$/.test(ref)) {
      const key = resolveKey(ref, numbers)
      const c = candidateByKey(ctx, key)
      if (!c) throw new Error(`${ref}（${key}）の候補データが見つかりません`)
      return { match: { author: authorKey(c) }, label: `${c.author.name}（${authorKey(c)}）` }
    }
    if (!/^(x|youtube|soundcloud|steam):\S+$/.test(ref)) throw new Error(`author の形式が不正です: ${ref}`)
    return { match: { author: ref }, label: ref }
  }
  if (target.startsWith("genre:")) {
    const id = target.slice("genre:".length)
    if (!ctx.genreById.has(id)) throw new Error(`config.yaml に genre ${id} がありません`)
    return { match: { genre: id }, label: `ジャンル ${id}` }
  }
  if (target.startsWith("text:")) {
    return { match: { text: target.slice("text:".length) }, label: `本文 /${target.slice(5)}/` }
  }
  const key = resolveKey(target, numbers)
  if (!/^(x|youtube|soundcloud|steam):\S+$/.test(key)) throw new Error(`対象の形式が不正です: ${target}`)
  const c = candidateByKey(ctx, key)
  return { match: { key }, label: c ? `${c.title || c.text?.slice(0, 30)}（${key}）` : key }
}

/** @handle を、保存済みの候補の共有者から X のユーザーIDに引く */
function parseSharer(ctx, target) {
  if (/^x:\d+$/.test(target)) return target
  const handle = target.replace(/^@/, "").toLowerCase()
  const list = fs.existsSync(ctx.paths.candidates) ? readJson(ctx.paths.candidates) : []
  for (const c of list) {
    const s = c.sharers?.find((s) => s.handle.toLowerCase() === handle)
    if (s) return `x:${s.id}`
    if (c.source === "x" && c.author.handle.toLowerCase() === handle && c.author.id) return `x:${c.author.id}`
  }
  throw new Error(`@${handle} のユーザーIDが ${ctx.date} の候補から見つかりません。x:<ユーザーID> で指定してください`)
}

const sameMatch = (a, b) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v)

export function curate(ctx, positionals, opts) {
  const [action, target, value] = positionals
  const { doc, rules } = loadCuration()

  if (action === "list" || !action) {
    if (rules.length === 0) console.log("ルールはまだありません")
    for (const r of rules) {
      const expired = r.until && String(r.until) < ctx.date ? "（期限切れ）" : ""
      console.log(`- ${describeRule(r)} ${r.reason} [${r.added}${r.until ? ` 〜 ${r.until}` : ""}]${expired}`)
    }
    return
  }

  if (action === "unset") {
    const { match, label } = parseTarget(ctx, target)
    if (opts.genre) match.genre = opts.genre
    const removed = removeRules(doc, (r) => sameMatch(r.match, match))
    if (removed.length === 0) throw new Error(`${label} に当たるルールはありません`)
    saveCuration(doc)
    for (const r of removed) console.log(`削除: ${describeRule(r)} ${r.reason}`)
    return
  }

  let match
  let label
  if (action === "ignore-sharer") {
    match = { sharer: parseSharer(ctx, target) }
    label = `${target}（${match.sharer}）`
  } else if (["block", "weight", "pin"].includes(action)) {
    ;({ match, label } = parseTarget(ctx, target))
    if (opts.genre) {
      if (!ctx.genreById.has(opts.genre)) throw new Error(`config.yaml に genre ${opts.genre} がありません`)
      match.genre = opts.genre
    }
  } else {
    throw new Error(`不明な操作です: ${action}（block / weight / pin / ignore-sharer / unset / list）`)
  }

  const rule = { match, action }
  if (action === "weight") rule.weight = Number(value)
  rule.reason = opts.reason
  rule.added = todayJst()
  if (opts.until) rule.until = opts.until

  // 同じ条件・同じ操作のルールがあれば置き換える（weight の付け直しなど）
  const replaced = removeRules(doc, (r) => r.action === action && sameMatch(r.match, match))
  addRule(doc, rule)
  saveCuration(doc)
  console.log(`${replaced.length ? "更新" : "追加"}: ${describeRule(rule)} ${rule.reason} — ${label}`)
  console.log(`${CURATION_PATH} を更新しました。pnpm digest review で反映後の候補を確認できます`)
}
