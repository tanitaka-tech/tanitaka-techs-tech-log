import { createHash } from "node:crypto"

/** セクションごとの追加検索量に応じ、Responses API の web_search で補助候補を探す。 */
export async function searchSections(config, now, genreIds = null) {
  const settings = config.aiSearch
  if (!settings?.enabled) return []
  if (!process.env.OPENAI_API_KEY) {
    console.warn("[ai-search] OPENAI_API_KEY が未設定のため、追加検索をスキップします")
    return []
  }
  const genresByLabel = new Map(config.genres.map((g) => [g.label, g]))
  const found = []
  for (const [label, section] of Object.entries(settings.sections ?? {})) {
    const genre = genresByLabel.get(label)
    if (genreIds && !genreIds.has(genre?.id)) continue
    const amount = Math.max(0, Math.min(5, Math.floor(Number(section.searches) || 0)))
    if (!genre || amount === 0) continue
    for (let i = 0; i < amount; i++) {
      try {
        const response = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: settings.model ?? "gpt-5.6-sol",
            tools: [{ type: "web_search", search_context_size: "medium" }],
            input: `日本語のデイリーダイジェスト「${label}」向けに、${now.toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })}に確認できる直近24時間の新しい話題をウェブ検索してください。検索単位 ${i + 1}/${amount}。既出の定番情報ではなく新着を優先し、記事・作品など読者が元ページを確認できる情報を最大${settings.maxResults ?? 4}件選びます。JSONオブジェクトのみ: {"items":[{"title":"タイトル","url":"https://...","summary":"内容の短い日本語要約"}]}。urlは検索結果の引用URLと完全一致させてください。検索語の重点: ${section.query}`,
          }),
        })
        if (!response.ok) throw new Error(`OpenAI API ${response.status}: ${(await response.text()).slice(0, 300)}`)
        const body = await response.json()
        const output = (body.output ?? []).filter((o) => o.type === "message").flatMap((o) => o.content ?? []).find((c) => c.type === "output_text")
        const results = JSON.parse(output?.text ?? "{}").items
        if (!Array.isArray(results)) throw new Error("検索結果の JSON がありません")
        const citedUrls = new Set((output.annotations ?? []).filter((a) => a.type === "url_citation").map((a) => a.url))
        for (const [rank, item] of results.entries()) {
          if (/イントロ.?クイズ|アニソン.*クイズ|アニメ.*クイズ|クイズ.*アニメ/i.test(`${item.title ?? ""} ${item.summary ?? ""}`)) continue
          let url
          try { url = new URL(item.url) } catch { continue }
          if (url.protocol !== "https:" || !item.title || !item.summary || !citedUrls.has(url.href)) continue
          const normalized = url.href
          const id = createHash("sha256").update(normalized).digest("hex").slice(0, 20)
          found.push({
            key: `web:${id}`, source: "web", id, genre: genre.id, title: String(item.title).slice(0, 180),
            text: String(item.summary).slice(0, 700), url: normalized,
            author: { name: url.hostname, handle: url.hostname },
            publishedAt: now.toISOString(), score: Math.max(1, 10 - rank),
            metrics: {},
          })
        }
        console.log(`[ai-search] ${label} ${i + 1}/${amount}: ${results.length}件`)
      } catch (error) {
        console.error(`[ai-search] ${label} ${i + 1}/${amount} 失敗: ${error.message}`)
        if (/credit_balance_exhausted|insufficient_quota/.test(error.message)) {
          throw new Error("OpenAI API の残クレジットがありません。残高を追加してから再実行してください")
        }
      }
    }
  }
  return [...new Map(found.map((c) => [c.key, c])).values()]
}
