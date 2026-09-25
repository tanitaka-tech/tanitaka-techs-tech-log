import Anthropic from "@anthropic-ai/sdk"

const SYSTEM = `あなたは日本語の技術・クリエイティブ系ブログの編集者です。
その日にSNSや動画サイトで伸びた投稿の候補リストから、デイリーダイジェスト記事に載せる項目を選び、見出しと要約を書きます。

## 選び方
- 読者はクリエイター・エンジニア・ゲーム好き。役に立つ、または純粋に面白いものを優先する。
- ジャンルが偏らないようにする（同じジャンルは最大2件）。
- 次に当てはまる候補は必ず除外し、rejected に理由を書く:
  - 政治・宗教・事件事故・災害・訃報・炎上・誹謗中傷
  - 一般の個人の私生活や、本人が晒されることを望まないと思われる内容
  - 真偽不明の噂・リーク、医療や投資に関する断定的な主張
  - 性的・暴力的な内容、宣伝目的が強いだけの投稿（懸賞・フォロー&RTキャンペーン等）
  - 出典が不明な名言の引用

## 書き方
- summary は2〜3文。候補の本文・タイトル・数値に書かれている事実だけを使う。推測・誇張・本文にない補足は書かない。
- 投稿者は「@handle さん」または公式アカウント名で呼ぶ。
- heading は項目の内容が分かる短い見出し（30文字以内）。
- topic は記事タイトルの前半。採用した中で最も読者の興味を引く項目を、クリックしたくなる言い回しで表す（40文字以内）。ただし内容と食い違う表現・煽り・誇張は禁止。日付は含めない。
- description は記事全体の1文紹介（80文字以内）。`

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["topic", "description", "items", "rejected"],
  properties: {
    topic: { type: "string" },
    description: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "heading", "summary"],
        properties: {
          key: { type: "string" },
          heading: { type: "string" },
          summary: { type: "string" },
        },
      },
    },
    rejected: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "reason"],
        properties: {
          key: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
  },
}

function toPromptCandidate(c) {
  return {
    key: c.key,
    genre: c.genreLabel,
    source: c.source,
    title: c.title || undefined,
    text: c.text,
    author: c.source === "x" ? `@${c.author.handle}（${c.author.name}）` : c.author.name,
    metrics: c.metrics,
  }
}

/**
 * 候補から掲載項目を選ばせる。戻り値は SCHEMA の形。
 */
export async function selectAndWrite(candidates, { date, minItems, maxItems, model }) {
  const client = new Anthropic()
  const response = await client.beta.messages.create({
    model,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: SCHEMA },
    },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `${date} のデイリーダイジェストを作ります。候補から ${minItems}〜${maxItems} 件を選んでください。条件を満たす候補が ${minItems} 件に満たない場合は、無理に埋めず満たすものだけを返してください。

<candidates>
${JSON.stringify(candidates.map(toPromptCandidate), null, 2)}
</candidates>`,
      },
    ],
  })

  if (response.stop_reason === "refusal") {
    throw new Error(`Claude が生成を拒否しました: ${response.stop_details?.category ?? "unknown"}`)
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Claude の出力が max_tokens で途切れました")
  }
  const text = response.content.find((b) => b.type === "text")?.text
  if (!text) throw new Error("Claude の応答にテキストがありません")
  console.log(
    `[llm] model=${response.model} input=${response.usage.input_tokens} output=${response.usage.output_tokens}`,
  )
  return JSON.parse(text)
}

/** --mock-llm 用。APIを呼ばずにスコア上位を機械的に選ぶ */
export function mockSelect(candidates, { maxItems }) {
  const perGenre = new Map()
  const items = []
  for (const c of [...candidates].sort((a, b) => b.score - a.score)) {
    const n = perGenre.get(c.genreLabel) ?? 0
    if (n >= 2 || items.length >= maxItems) continue
    perGenre.set(c.genreLabel, n + 1)
    items.push({
      key: c.key,
      heading: `（モック）${c.title || c.genreLabel}`,
      summary: "（モック）ここに Claude が書いた要約が入ります。",
    })
  }
  return {
    topic: `（モック）${items[0]?.heading ?? "今日の話題"}`,
    description: "（モック）今日伸びた話題のまとめ",
    items,
    rejected: [],
  }
}
