/*
 * curation.yaml（人間が決めた block / weight / pin / ignore-sharer のルール）の読み書きと適用。
 * LLM に渡す前に機械的に適用するので、同じ候補とルールなら結果は毎回同じになる。
 */
import fs from "node:fs"
import YAML from "yaml"
import { shareScore } from "./x-youtube.mjs"

export const CURATION_PATH = "scripts/daily-digest/curation.yaml"

const ACTIONS = ["block", "weight", "pin", "ignore-sharer"]
const MATCH_FIELDS = ["key", "author", "genre", "text", "sharer"]

/** ルールの照合に使う投稿者の ID。YouTube はチャンネルID、X はユーザーID */
export function authorKey(c) {
  return `${c.source}:${c.author?.id ?? c.author?.handle}`
}

export function validateRule(rule, where = "rule") {
  const fail = (msg) => {
    throw new Error(`${CURATION_PATH} の ${where}: ${msg}`)
  }
  if (!ACTIONS.includes(rule.action)) fail(`action は ${ACTIONS.join(" / ")} のどれかにしてください`)
  const fields = Object.keys(rule.match ?? {})
  if (fields.length === 0) fail("match に条件を1つ以上書いてください")
  for (const f of fields) {
    if (!MATCH_FIELDS.includes(f)) fail(`match に使えない条件です: ${f}`)
  }
  if ((rule.action === "ignore-sharer") !== fields.includes("sharer")) {
    fail("match.sharer は action: ignore-sharer と組み合わせて使います")
  }
  if (rule.action === "weight" && !(typeof rule.weight === "number" && rule.weight > 0)) {
    fail("weight には正の数を書いてください")
  }
  if (rule.match?.text !== undefined) {
    try {
      new RegExp(rule.match.text, "i")
    } catch (e) {
      fail(`match.text が正規表現として不正です: ${e.message}`)
    }
  }
  if (!rule.reason) fail("reason を書いてください")
  if (!rule.added) fail("added（YYYY-MM-DD）を書いてください")
}

/** YAML のコメントを残したまま書き戻せるよう、Document ごと返す */
export function loadCuration(file = CURATION_PATH) {
  if (!fs.existsSync(file)) return { doc: new YAML.Document({ rules: [] }), rules: [] }
  const doc = YAML.parseDocument(fs.readFileSync(file, "utf8"))
  if (doc.errors.length) throw new Error(`${file} を読めません: ${doc.errors[0].message}`)
  const rules = doc.toJS()?.rules ?? []
  rules.forEach((r, i) => validateRule(r, `rules[${i}]`))
  return { doc, rules }
}

export function saveCuration(doc, file = CURATION_PATH) {
  fs.writeFileSync(file, doc.toString({ lineWidth: 0 }))
}

export function addRule(doc, rule) {
  validateRule(rule, "追加するルール")
  let seq = doc.get("rules", true)
  if (!seq) {
    doc.set("rules", doc.createNode([]))
    seq = doc.get("rules", true)
  }
  seq.flow = false
  seq.items.push(doc.createNode(rule))
}

/** pred に当たるルールを削除し、削除したルールを返す */
export function removeRules(doc, pred) {
  const seq = doc.get("rules", true)
  if (!seq) return []
  const removed = []
  seq.items = seq.items.filter((node) => {
    const rule = node.toJSON()
    if (!pred(rule)) return true
    removed.push(rule)
    return false
  })
  return removed
}

/** until を過ぎたルールを除く。date は対象日（YYYY-MM-DD） */
export function activeRules(rules, date) {
  return rules.filter((r) => !r.until || String(r.until) >= date)
}

function matches(match, c) {
  if (match.key !== undefined && match.key !== c.key) return false
  if (match.author !== undefined && match.author !== authorKey(c)) return false
  if (match.genre !== undefined && match.genre !== c.genre) return false
  if (match.text !== undefined && !new RegExp(match.text, "i").test(`${c.title ?? ""}\n${c.text ?? ""}`)) return false
  return true
}

export function describeRule(r) {
  const m = Object.entries(r.match)
    .map(([k, v]) => `${k}=${v}`)
    .join(",")
  return `${r.action}${r.action === "weight" ? `×${r.weight}` : ""}(${m})`
}

/**
 * 候補1件にルールを適用する。c は変更せず、score・sharers を差し替えた複製を返す。
 * 優先順位は pin > block > weight。block されても pin されていれば残す。
 */
export function applyRules(c, rules, genre) {
  const out = { ...c, metrics: { ...c.metrics } }
  const applied = []
  let blocked = null

  // 共有者を除くとスコア（共有者数）自体が変わるので、先に計算し直す
  const ignored = new Set(rules.filter((r) => r.action === "ignore-sharer").map((r) => r.match.sharer))
  if (c.sharers && ignored.size > 0) {
    const kept = c.sharers.filter((s) => !ignored.has(`x:${s.id}`))
    if (kept.length < c.sharers.length) {
      applied.push(`ignore-sharer×${c.sharers.length - kept.length}`)
      out.sharers = kept
      out.sharedBy = kept.map((s) => `@${s.handle}`)
      out.metrics.sharers = kept.length
      out.score = shareScore(kept)
      const min = genre?.minSharers ?? 1
      if (kept.length < min) blocked = `共有者が ${min} 人未満（ignore-sharer 適用後）`
    }
  }

  let weight = 1
  let pinned = false
  for (const r of rules) {
    if (r.action === "ignore-sharer" || !matches(r.match, c)) continue
    applied.push(describeRule(r))
    if (r.action === "block") blocked ??= `block: ${r.reason}`
    else if (r.action === "pin") pinned = true
    else if (r.action === "weight") weight *= r.weight
  }
  out.score *= weight
  return { c: out, weight, pinned, blocked: pinned ? null : blocked, applied }
}
