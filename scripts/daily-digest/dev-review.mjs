/*
 * プレビュー中の記事から、項目ごとの採用・不採用を selection.json に書き込むための Astro インテグレーション。
 * `pnpm dev` の開発サーバーにだけ API を足す（ビルドした記事には何も入らない）。
 *
 *   GET  /__digest/selection?date=YYYY-MM-DD   → { adopt: { <キー>: true|false } }
 *   POST /__digest/adopt  { date, key, adopt } → selection.json の該当項目の adopt を書き換える
 *
 * 画面側（採用のトグル）は Layout.astro。プレビューの記事（render の既定）にだけ出る。
 */
import fs from "node:fs"
import path from "node:path"

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function paths(date) {
  const dir = path.join(".digest-cache", date)
  return { selection: path.join(dir, "selection.json"), numbers: path.join(dir, "numbers.json") }
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
              return send(res, 200, { adopt })
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
            return send(res, 404, { error: "not found" })
          } catch (e) {
            return send(res, 500, { error: e.message })
          }
        })
      },
    },
  }
}
