import fs from "node:fs"
import Anthropic from "@anthropic-ai/sdk"

// 選定基準は Claude Code での手元の選定（/digest スキル）と共通にするため、ファイルに分けている
const SYSTEM = fs.readFileSync(new URL("../selection-guide.md", import.meta.url), "utf8")

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["topic", "topicKey", "description", "items", "rejected"],
  properties: {
    topic: { type: "string" },
    topicKey: { type: "string" },
    description: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "note"],
        properties: {
          key: { type: "string" },
          // 記事には載せない、レビュー担当への申し送り
          note: { type: "string" },
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
    step: c.step,
    source: c.source,
    title: c.title || undefined,
    text: c.text,
    author: c.source === "x" ? `@${c.author.handle}（${c.author.name}）` : c.author.name,
    metrics: c.metrics,
    score: Number(c.score.toFixed(2)),
    pinned: c.pinned || undefined,
  }
}

function userPrompt(candidates, { date, minItems, maxItems, maxPerCategory, maxItemsByCategory = {} }) {
  const overrides = Object.entries(maxItemsByCategory).map(([label, n]) => `${label} は最大 ${n} 件`)
  const limits = `同じジャンルは最大 ${maxPerCategory} 件${overrides.length ? `、ただし ${overrides.join("、")}` : ""}`
  return `${date} のデイリーダイジェストを作ります。候補から ${minItems}〜${maxItems} 件を選んでください（${limits}）。条件を満たす候補が ${minItems} 件に満たない場合は、無理に埋めず満たすものだけを返してください。

<candidates>
${JSON.stringify(candidates.map(toPromptCandidate), null, 2)}
</candidates>`
}

async function postJson(label, url, headers, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    // エラーメッセージにキーが含まれないよう、URLやヘッダーは出さない
    throw new Error(`${label} API ${res.status}: ${json.error?.message ?? JSON.stringify(json).slice(0, 300)}`)
  }
  return json
}

async function callAnthropic({ model, prompt }) {
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
    messages: [{ role: "user", content: prompt }],
  })

  if (response.stop_reason === "refusal") {
    throw new Error(`生成を拒否されました: ${response.stop_details?.category ?? "unknown"}`)
  }
  if (response.stop_reason === "max_tokens") throw new Error("出力が max_tokens で途切れました")
  const text = response.content.find((b) => b.type === "text")?.text
  if (!text) throw new Error("応答にテキストがありません")
  return {
    text,
    model: response.model,
    usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
  }
}

async function callOpenAI({ model, prompt }) {
  const body = await postJson(
    "OpenAI",
    "https://api.openai.com/v1/responses",
    { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    {
      model,
      instructions: SYSTEM,
      input: prompt,
      max_output_tokens: 16000,
      reasoning: { effort: "high" },
      text: { format: { type: "json_schema", name: "digest_selection", schema: SCHEMA, strict: true } },
    },
  )

  if (body.status === "incomplete") {
    throw new Error(`出力が途中で終了しました: ${body.incomplete_details?.reason ?? "unknown"}`)
  }
  const content = (body.output ?? []).filter((o) => o.type === "message").flatMap((o) => o.content ?? [])
  const refusal = content.find((c) => c.type === "refusal")
  if (refusal) throw new Error(`生成を拒否されました: ${refusal.refusal}`)
  const text = content.find((c) => c.type === "output_text")?.text
  if (!text) throw new Error("応答にテキストがありません")
  return {
    text,
    model: body.model,
    usage: { input: body.usage?.input_tokens, output: body.usage?.output_tokens },
  }
}

async function callGemini({ model, prompt }) {
  const body = await postJson(
    "Gemini",
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    { "x-goog-api-key": process.env.GEMINI_API_KEY },
    {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 16000,
        responseMimeType: "application/json",
        responseJsonSchema: SCHEMA,
      },
    },
  )

  if (body.promptFeedback?.blockReason) {
    throw new Error(`生成を拒否されました: ${body.promptFeedback.blockReason}`)
  }
  const candidate = body.candidates?.[0]
  if (candidate?.finishReason && candidate.finishReason !== "STOP") {
    throw new Error(`出力が途中で終了しました: ${candidate.finishReason}`)
  }
  const text = (candidate?.content?.parts ?? [])
    .filter((p) => !p.thought)
    .map((p) => p.text ?? "")
    .join("")
  if (!text) throw new Error("応答にテキストがありません")
  return {
    text,
    model: body.modelVersion ?? model,
    usage: { input: body.usageMetadata?.promptTokenCount, output: body.usageMetadata?.candidatesTokenCount },
  }
}

const PROVIDERS = {
  anthropic: { call: callAnthropic, env: "ANTHROPIC_API_KEY" },
  openai: { call: callOpenAI, env: "OPENAI_API_KEY" },
  gemini: { call: callGemini, env: "GEMINI_API_KEY" },
}

/**
 * 候補から掲載項目を選ばせる。providers を上から順に試し、失敗したら次にフォールバックする。
 * APIキーが未設定のプロバイダーは飛ばす。戻り値は { selection: SCHEMA の形, provider, model }。
 */
export async function selectAndWrite(candidates, { date, minItems, maxItems, maxPerCategory, maxItemsByCategory, providers }) {
  const prompt = userPrompt(candidates, { date, minItems, maxItems, maxPerCategory, maxItemsByCategory })
  const failures = []
  for (const { provider, model } of providers) {
    const p = PROVIDERS[provider]
    if (!p) throw new Error(`未知の LLM プロバイダーです: ${provider}`)
    if (!process.env[p.env]) {
      console.log(`[llm] ${provider}: ${p.env} が未設定のためスキップ`)
      continue
    }
    try {
      const res = await p.call({ model, prompt })
      const selection = JSON.parse(res.text)
      console.log(`[llm] ${provider} model=${res.model} input=${res.usage.input} output=${res.usage.output}`)
      return { selection, provider, model: res.model }
    } catch (e) {
      // 残高不足・障害・拒否・JSON不正など、どの失敗でも次のプロバイダーを試す
      console.error(`[llm] ${provider} (${model}) 失敗: ${e.message}`)
      failures.push(`${provider}: ${e.message}`)
    }
  }
  throw new Error(
    failures.length
      ? `すべての LLM プロバイダーが失敗しました\n${failures.join("\n")}`
      : "使える LLM プロバイダーがありません（APIキーを設定してください）",
  )
}

/** --mock-llm 用。APIを呼ばずにスコア上位を機械的に選ぶ */
export function mockSelect(candidates, { maxItems, categoryLimit }) {
  const perGenre = new Map()
  const items = []
  for (const c of [...candidates].sort((a, b) => b.score - a.score)) {
    const n = perGenre.get(c.genreLabel) ?? 0
    if (n >= categoryLimit(c.genreLabel) || items.length >= maxItems) continue
    perGenre.set(c.genreLabel, n + 1)
    items.push({ key: c.key, note: "" })
  }
  return {
    topic: "（モック）今日の話題",
    topicKey: items[0]?.key ?? "",
    description: "（モック）今日伸びた話題のまとめ",
    items,
    rejected: [],
  }
}
