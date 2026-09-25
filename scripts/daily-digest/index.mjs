/*
 * デイリーダイジェスト記事を手元で作る。Claude Code の /digest スキルから順に呼ぶ想定。
 *
 *   pnpm digest collect [--date YYYY-MM-DD] [--force] [--genre id,id] [--x-limit N] [--fixture candidates.json]
 *   pnpm digest review  [--date] [--all]
 *   pnpm digest curate  <block|weight|pin|ignore-sharer|unset|list|prune> <対象> [倍率] --reason 理由 [--until YYYY-MM-DD] [--genre ID]
 *   pnpm digest select  [--date] (--draft [--reset] | --llm [--providers anthropic,openai] | --mock)
 *   pnpm digest render  [--date] [--force] [--final]
 *   pnpm digest publish [--date] [--skip-build] [--no-merge]
 *
 * 環境変数（.env から読む）: X_BEARER_TOKEN, YOUTUBE_API_KEY。select --llm を使うときは
 * ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY のいずれか。
 * 生データ（投稿本文など）は .digest-cache/<date>/ に保存し、リポジトリにはコミットしない。
 */
import { parseArgs } from "node:util"
import { collect } from "./commands/collect.mjs"
import { curate } from "./commands/curate.mjs"
import { publish } from "./commands/publish.mjs"
import { render } from "./commands/render.mjs"
import { review } from "./commands/review.mjs"
import { select } from "./commands/select.mjs"
import { loadContext } from "./lib/context.mjs"
import { loadDotEnv } from "./lib/env.mjs"

const HELP = `使い方: pnpm digest <コマンド> [--date YYYY-MM-DD]

  collect   候補を集めて保存する（保存済みなら取り直さない。--force で取り直し、--genre a,b でそのジャンルだけ取り直し）
  review    curation.yaml を適用した候補一覧を番号付きで表示する（--all で除外・圏外も）
  curate    ルールを足す・消す（例: curate block author:#3 --reason 懸賞アカウント。prune で期限切れのルールを消す）
  select    候補一覧から selection.json の下書きを作る（--draft。あれば足りない候補を足す、--reset で作り直し）。--llm は API の LLM で選ぶ
  render    selection.json から記事を書き出す（既定はプレビュー用で警告を表示。--final で公開用）
  publish   記事と curation.yaml をコミットし、PR を作って CI が通ったらマージする`

const OPTIONS = {
  date: { type: "string" },
  // collect
  force: { type: "boolean", default: false },
  fixture: { type: "string" },
  "x-limit": { type: "string" },
  // review
  all: { type: "boolean", default: false },
  // curate
  reason: { type: "string" },
  until: { type: "string" },
  genre: { type: "string" },
  // select
  llm: { type: "boolean", default: false },
  providers: { type: "string" },
  mock: { type: "boolean", default: false },
  draft: { type: "boolean", default: false },
  reset: { type: "boolean", default: false },
  // render
  final: { type: "boolean", default: false },
  // publish
  "skip-build": { type: "boolean", default: false },
  "no-merge": { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
}

async function main() {
  const { values: opts, positionals } = parseArgs({ options: OPTIONS, allowPositionals: true })
  const [command, ...rest] = positionals
  if (!command || opts.help) {
    console.log(HELP)
    return
  }
  loadDotEnv()
  const ctx = loadContext({ date: opts.date, xLimit: opts["x-limit"] })

  switch (command) {
    case "collect":
      return collect(ctx, { force: opts.force, fixture: opts.fixture, genre: opts.genre })
    case "review":
      return review(ctx, { all: opts.all })
    case "curate":
      return curate(ctx, rest, opts)
    case "select":
      return select(ctx, { llm: opts.llm, providers: opts.providers, mock: opts.mock, draft: opts.draft, reset: opts.reset })
    case "render":
      return render(ctx, { force: opts.force, final: opts.final })
    case "publish":
      return publish(ctx, { skipBuild: opts["skip-build"], noMerge: opts["no-merge"] })
    default:
      throw new Error(`不明なコマンドです: ${command}\n\n${HELP}`)
  }
}

main().catch((e) => {
  console.error(`エラー: ${e.message}`)
  process.exit(1)
})
