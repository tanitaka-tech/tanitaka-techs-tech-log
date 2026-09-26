/*
 * プレビュー中の記事から、項目ごとの採用・不採用を selection.json に書き込むための Astro インテグレーション。
 * `pnpm dev` の開発サーバーにだけ API を足す（ビルドした記事には何も入らない）。
 *
 *   GET  /__digest/selection?date=YYYY-MM-DD   → { adopt: { <キー>: true|false }, order: [<キー>, ...] }
 *   POST /__digest/adopt  { date, key, adopt } → selection.json の該当項目の adopt を書き換える
 *   POST /__digest/order  { date, keys }       → keys（1つのカテゴリの項目）をこの順に並べ替える
 *   POST /__digest/thumbnail { date, key }     → 記事のサムネイルにする項目（selection.json の topicKey）を key にする
 *   POST /__digest/meta  { date, topic, description } → 記事のタイトル（の前半）と説明を書き換える
 *   POST /__digest/curate { date, key, scope, action, weight?, reason }
 *        → curation.yaml にルールを足す（scope: item はその項目、author はその投稿者。action: block / weight / pin）。
 *          候補一覧の並びが変わるので、反映は pnpm digest review / select --draft / render のやり直しで
 *
 * GET は { adopt, order, thumbnail: <topicKey の候補のキー>, topic, description } を返す。
 * 記事（.md）は書き出し直さない（書き出すと開発サーバーがページを読み込み直すため）。
 * プレビューの画面は GET の order で並べ直し、公開用に書き出すとき（render --final）に selection.json の順が使われる。
 *
 * 画面側（採用のトグル）は Layout.astro。プレビューの記事（render の既定）にだけ出る。
 */
import fs from "node:fs"
import path from "node:path"
import { addRule, authorKey, describeRule, loadCuration, removeRules, saveCuration } from "./lib/curation.mjs"
import { todayJst } from "./lib/date.mjs"

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function paths(date) {
  const dir = path.join(".digest-cache", date)
  return {
    selection: path.join(dir, "selection.json"),
    numbers: path.join(dir, "numbers.json"),
    candidates: path.join(dir, "candidates.json"),
  }
}

const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback)

/** selection.json の key（"#3" のような番号のこともある）を、候補のキー（youtube:xxx など）にする */
function resolver(date) {
  const numbers = readJson(paths(date).numbers, {})
  const byNo = new Map(Object.entries(numbers).map(([k, n]) => [`#${n}`, k]))
  return (key) => byNo.get(String(key).replace(/^#?(\d+)$/, "#$1")) ?? key
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ""
    req.on("data", (chunk) => {
      body += chunk
    })
    req.on("end", () => resolve(body))
    req.on("error", reject)
  })
}

function send(res, status, value) {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json; charset=utf-8")
  res.end(JSON.stringify(value))
}

export function digestReview() {
  return {
    name: "digest-review",
    hooks: {
      "astro:server:setup": ({ server }) => {
        server.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url ?? "/", "http://localhost")
          if (!url.pathname.startsWith("/__digest/")) return next()
          try {
            if (req.method === "GET" && url.pathname === "/__digest/selection") {
              const date = url.searchParams.get("date") ?? ""
              if (!DATE_RE.test(date)) return send(res, 400, { error: "date が不正です" })
              const selection = readJson(paths(date).selection, { items: [] })
              const resolve = resolver(date)
              const adopt = Object.fromEntries(selection.items.map((i) => [resolve(i.key), i.adopt !== false]))
              const order = selection.ordered ? selection.items.map((i) => resolve(i.key)) : []
              const thumbnail = selection.topicKey ? resolve(selection.topicKey) : ""
              return send(res, 200, { adopt, order, thumbnail, topic: selection.topic ?? "", description: selection.description ?? "" })
            }
            if (req.method === "POST" && url.pathname === "/__digest/adopt") {
              const { date, key, adopt } = JSON.parse(await readBody(req))
              if (!DATE_RE.test(date ?? "") || typeof key !== "string" || typeof adopt !== "boolean") {
                return send(res, 400, { error: "date・key・adopt を指定してください" })
              }
              const file = paths(date).selection
              const selection = readJson(file, null)
              if (!selection) return send(res, 404, { error: `${file} がありません` })
              const resolve = resolver(date)
              const item = selection.items.find((i) => resolve(i.key) === key)
              if (!item) return send(res, 404, { error: `${key} は selection.json にありません` })
              item.adopt = adopt
              fs.writeFileSync(file, `${JSON.stringify(selection, null, 2)}\n`)
              return send(res, 200, { key, adopt })
            }
            if (req.method === "POST" && url.pathname === "/__digest/thumbnail") {
              const { date, key } = JSON.parse(await readBody(req))
              if (!DATE_RE.test(date ?? "") || typeof key !== "string") return send(res, 400, { error: "date・key を指定してください" })
              const file = paths(date).selection
              const selection = readJson(file, null)
              if (!selection) return send(res, 404, { error: `${file} がありません` })
              const resolve = resolver(date)
              const item = selection.items.find((i) => resolve(i.key) === key)
              if (!item) return send(res, 404, { error: `${key} は selection.json にありません` })
              // 番号（#8）のまま書いておくと、review の番号と見比べやすい
              selection.topicKey = item.key
              fs.writeFileSync(file, `${JSON.stringify(selection, null, 2)}\n`)
              return send(res, 200, { key })
            }
            if (req.method === "POST" && url.pathname === "/__digest/meta") {
              const { date, topic, description } = JSON.parse(await readBody(req))
              if (!DATE_RE.test(date ?? "") || typeof topic !== "string" || typeof description !== "string") {
                return send(res, 400, { error: "date・topic・description を指定してください" })
              }
              const file = paths(date).selection
              const selection = readJson(file, null)
              if (!selection) return send(res, 404, { error: `${file} がありません` })
              selection.topic = topic.trim()
              selection.description = description.trim()
              fs.writeFileSync(file, `${JSON.stringify(selection, null, 2)}\n`)
              return send(res, 200, { topic: selection.topic, description: selection.description })
            }
            if (req.method === "POST" && url.pathname === "/__digest/curate") {
              const { date, key, scope, action, weight, reason } = JSON.parse(await readBody(req))
              if (!DATE_RE.test(date ?? "") || typeof key !== "string" || !["item", "author"].includes(scope)) {
                return send(res, 400, { error: "date・key・scope（item / author）を指定してください" })
              }
              if (!["block", "weight", "pin"].includes(action)) return send(res, 400, { error: "action は block / weight / pin です" })
              const candidate = readJson(paths(date).candidates, []).find((c) => c.key === key)
              if (!candidate) return send(res, 404, { error: `${key} は候補にありません` })
              const match = scope === "author" ? { author: authorKey(candidate) } : { key }
              const rule = { match, action }
              if (action === "weight") rule.weight = Number(weight)
              rule.reason = String(reason ?? "").trim()
              rule.added = todayJst()
              const { doc } = loadCuration()
              // curate コマンドと同じく、同じ条件・同じ操作のルールは置き換える（addRule が中身を確かめる）
              const replaced = removeRules(
                doc,
                (r) => r.action === action && Object.keys(r.match).length === 1 && r.match[Object.keys(match)[0]] === Object.values(match)[0],
              )
              addRule(doc, rule)
              saveCuration(doc)
              return send(res, 200, { rule: `${describeRule(rule)} ${rule.reason}`, replaced: replaced.length > 0 })
            }
            if (req.method === "POST" && url.pathname === "/__digest/order") {
              const { date, keys } = JSON.parse(await readBody(req))
              if (!DATE_RE.test(date ?? "") || !Array.isArray(keys) || keys.some((k) => typeof k !== "string")) {
                return send(res, 400, { error: "date・keys を指定してください" })
              }
              const file = paths(date).selection
              const selection = readJson(file, null)
              if (!selection) return send(res, 404, { error: `${file} がありません` })
              const resolve = resolver(date)
              // 並べ替える項目が今ある位置に、新しい順で入れ直す（ほかのカテゴリの項目の位置は変えない）
              const slots = selection.items.flatMap((item, i) => (keys.includes(resolve(item.key)) ? [i] : []))
              if (slots.length !== keys.length) return send(res, 400, { error: "selection.json にない項目があります" })
              const byKey = new Map(slots.map((i) => [resolve(selection.items[i].key), selection.items[i]]))
              slots.forEach((slot, n) => {
                selection.items[slot] = byKey.get(keys[n])
              })
              // render は、手で並べ替えた記事ではスコア順に並べ直さない
              selection.ordered = true
              fs.writeFileSync(file, `${JSON.stringify(selection, null, 2)}\n`)
              return send(res, 200, { keys })
            }
            return send(res, 404, { error: "not found" })
          } catch (e) {
            return send(res, 500, { error: e.message })
          }
        })
      },
    },
  }
}
