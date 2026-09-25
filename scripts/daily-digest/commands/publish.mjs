/*
 * 手元で確認し終えた記事を公開する。
 * digest/<date> ブランチに記事と curation.yaml をコミットして PR を作り、CI が通ったらマージする
 * （develop へのマージで GitHub Pages にデプロイされる）。
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import { CURATION_PATH } from "../lib/curation.mjs"
import { readJson } from "../lib/context.mjs"
import { resolveKey } from "../lib/review.mjs"

function run(cmd, args, { capture = false } = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`)
  const res = spawnSync(cmd, args, { stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit", encoding: "utf8" })
  if (res.status !== 0) throw new Error(`${cmd} ${args[0]} が失敗しました（exit ${res.status}）`)
  return capture ? res.stdout.trim() : res.status
}

const git = (...args) => spawnSync("git", args, { encoding: "utf8" }).stdout.trim()

function articleTitle(file) {
  const m = fs.readFileSync(file, "utf8").match(/^title: (.+)$/m)
  return m ? JSON.parse(m[1]) : file
}

function prBody(ctx, title) {
  const selection = readJson(ctx.paths.selection, { items: [] })
  const shortlist = readJson(ctx.paths.shortlist, [])
  const byKey = new Map(shortlist.map((c) => [c.key, c]))
  const numbers = readJson(ctx.paths.numbers, {})
  const items = selection.items.map((i) => {
    const key = resolveKey(i.key, numbers)
    const c = byKey.get(key)
    return c ? `- ${c.genreLabel}${c.step ? `／${c.step}` : ""}: [${(c.title || c.text || "").replace(/\s+/g, " ").slice(0, 60)}](${c.url})` : `- ${key}`
  })
  const rulesDiff = git("diff", "--cached", "--unified=0", "--", CURATION_PATH)
    .split("\n")
    .filter((l) => /^[+-]\s/.test(l))
    .join("\n")
  return `## 📰 ${title}

手元で候補の確認・重みづけ・添削を済ませた記事です（\`pnpm digest publish\`）。

### 掲載項目
${items.join("\n")}
${rulesDiff ? `\n### curation.yaml の変更\n\`\`\`diff\n${rulesDiff}\n\`\`\`\n` : ""}`
}

export function publish(ctx, { skipBuild = false, noMerge = false } = {}) {
  const { date, articlePath } = ctx
  if (!fs.existsSync(articlePath)) throw new Error(`${articlePath} がありません。先に pnpm digest render を実行してください`)

  const branch = `digest/${date}`
  const current = git("rev-parse", "--abbrev-ref", "HEAD")
  if (current !== "develop" && current !== branch) {
    throw new Error(`develop か ${branch} ブランチで実行してください（現在: ${current}）`)
  }
  const title = articleTitle(articlePath)

  if (!skipBuild) run("pnpm", ["build"])

  if (current === "develop") {
    run("git", ["pull", "--ff-only", "origin", "develop"])
    run("git", ["switch", "-c", branch])
  }
  run("git", ["add", "--", articlePath, CURATION_PATH])
  if (spawnSync("git", ["diff", "--cached", "--quiet"]).status === 0) {
    throw new Error("コミットする変更がありません")
  }
  const bodyFile = `${ctx.dir}/pr-body.md`
  fs.writeFileSync(bodyFile, prBody(ctx, title))
  run("git", ["commit", "-m", `feat: デイリーダイジェスト ${date}`, "-m", title])
  run("git", ["push", "-u", "origin", branch])

  const existing = run("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "url", "--jq", ".[0].url"], {
    capture: true,
  })
  const url =
    existing ||
    run("gh", ["pr", "create", "--base", "develop", "--head", branch, "--title", title, "--body-file", bodyFile], {
      capture: true,
    })
  console.log(`PR: ${url}`)
  if (noMerge) return

  // PR を作った直後はチェックがまだ登録されていないことがあるので、出てくるまで待つ
  for (let i = 0; i < 12; i++) {
    const n = spawnSync("gh", ["pr", "checks", url, "--json", "name", "--jq", "length"], { encoding: "utf8" }).stdout.trim()
    if (Number(n) > 0) break
    spawnSync("sleep", ["5"])
  }
  run("gh", ["pr", "checks", url, "--watch", "--fail-fast"])
  run("gh", ["pr", "merge", url, "--merge", "--delete-branch"])
  if (git("rev-parse", "--abbrev-ref", "HEAD") !== "develop") run("git", ["switch", "develop"])
  run("git", ["pull", "--ff-only", "origin", "develop"])
  console.log(`\nマージしました。develop へのデプロイが終わると公開されます: ${url}`)
}
