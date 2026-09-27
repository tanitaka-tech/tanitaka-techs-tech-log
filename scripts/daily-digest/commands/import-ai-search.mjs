import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { readJson, writeJson } from "../lib/context.mjs"

/** エージェントがウェブ検索した補助候補を、今日の候補データに重複なく追加する。 */
export function importAiSearch(ctx, input) {
  if (!input) throw new Error("--input <検索結果JSON> を指定してください")
  if (!fs.existsSync(ctx.paths.candidates)) throw new Error("先に collect を実行してください")
  const file = path.resolve(input)
  const entries = JSON.parse(fs.readFileSync(file, "utf8"))
  if (!Array.isArray(entries)) throw new Error("検索結果JSONは配列にしてください")
  const sections = ctx.config.aiSearch?.sections ?? {}
  const items = []
  for (const entry of entries) {
    const section = sections[entry.section]
    const genre = ctx.genreById.get(section?.genre)
    if (!genre) throw new Error(`aiSearch.sections にセクションまたは保存先ジャンルがありません: ${entry.section}`)
    const url = new URL(entry.url)
    if (url.protocol !== "https:") throw new Error(`HTTPS以外のURLは取り込めません: ${entry.url}`)
    if (section.socialOnly) {
      const allowed = section.allowedDomains ?? []
      if (!allowed.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
        throw new Error(`SNS以外のURLは「${entry.section}」に取り込めません: ${entry.url}`)
      }
      const postPath = url.pathname
      const isPost = (url.hostname === "x.com" || url.hostname === "twitter.com")
        ? /^\/[^/]+\/status\/\d+/.test(postPath)
        : url.hostname === "bsky.app"
          ? /^\/profile\/[^/]+\/post\/[^/]+/.test(postPath)
          : (url.hostname === "pixiv.net" || url.hostname.endsWith(".pixiv.net"))
            ? /^\/artworks\/\d+/.test(postPath)
            : /^\/notes\/[^/]+/.test(postPath)
      if (!isPost) throw new Error(`SNSの個別投稿URLではありません: ${entry.url}`)
    }
    const title = String(entry.title ?? "").trim()
    const summary = String(entry.summary ?? "").trim()
    if (!title || !summary) throw new Error(`タイトル・要約がありません: ${entry.url}`)
    if (/イントロ.?クイズ|アニソン.*クイズ|アニメ.*クイズ|クイズ.*アニメ/i.test(`${title} ${summary}`)) continue
    const likes = Number.isFinite(Number(entry.likes)) ? Math.max(0, Number(entry.likes)) : 0
    const reposts = Number.isFinite(Number(entry.reposts)) ? Math.max(0, Number(entry.reposts)) : 0
    const normalizedUrl = url.href
    const id = createHash("sha256").update(normalizedUrl).digest("hex").slice(0, 20)
    items.push({
      key: `web:${id}`, source: "web", id, genre: genre.id, genreLabel: genre.label,
      title: title.slice(0, 180), text: summary.slice(0, 700), url: normalizedUrl,
      author: { id: url.hostname, name: url.hostname, handle: url.hostname },
      publishedAt: ctx.now.toISOString(), score: 10 + Math.log1p(likes) + Math.log1p(reposts) * 1.2,
      metrics: { likes, reposts },
    })
  }
  const existing = readJson(ctx.paths.candidates)
  const keys = new Set(existing.map((item) => item.key))
  const fresh = items.filter((item) => !keys.has(item.key))
  writeJson(ctx.paths.candidates, [...existing, ...fresh])
  console.log(`[ai-search] ${items.length}件を確認、${fresh.length}件を追加（重複 ${items.length - fresh.length}件）。候補合計 ${existing.length + fresh.length}件`)
}
