import fs from "node:fs"
import path from "node:path"

const ITEM_RE = /<!-- digest-item (\w+):(\S+) -->[\s\S]*?<!-- \/digest-item -->\n*/g

function escapeText(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function escapeAttr(s) {
  return escapeText(s).replace(/"/g, "&quot;")
}

function embed(c) {
  switch (c.source) {
    case "x":
      // 公式の埋め込み。本文はリポジトリに保存せず、表示は widgets.js に任せる
      return `<blockquote class="twitter-tweet" data-dnt="true"><a href="https://twitter.com/${c.author.handle}/status/${c.id}">@${escapeText(c.author.handle)} さんのポストを見る</a></blockquote>`
    case "youtube":
      return `<iframe class="digest-youtube" src="https://www.youtube-nocookie.com/embed/${c.id}" title="${escapeAttr(c.title)}" loading="lazy" allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`
    case "steam":
      return `<iframe class="digest-steam" src="https://store.steampowered.com/widget/${c.id}/" title="${escapeAttr(c.title)}" loading="lazy"></iframe>`
    default:
      throw new Error(`unknown source: ${c.source}`)
  }
}

export function renderArticle({ date, selection, candidatesByKey, category, fixedTags }) {
  const items = selection.items.map((i) => ({ ...i, c: candidatesByKey.get(i.key) }))
  const tags = [...new Set([...fixedTags, category, ...items.map((i) => i.c.genreLabel)])]

  const frontmatter = [
    "---",
    `title: ${JSON.stringify(`${selection.topic.trim()} ${date}`)}`,
    `published: ${date}`,
    `description: ${JSON.stringify(selection.description)}`,
    `image: ""`,
    `tags: ${JSON.stringify(tags)}`,
    `category: ${JSON.stringify(category)}`,
    "draft: false",
    `lang: ""`,
    "---",
  ].join("\n")

  const body = items
    .map(
      ({ c, heading, summary }) => `<!-- digest-item ${c.source}:${c.id} -->
## ${escapeText(heading)}

<span class="digest-genre">${escapeText(c.genreLabel)}</span>

${escapeText(summary)}

<div class="digest-embed">
${embed(c)}
</div>

<!-- /digest-item -->
`,
    )
    .join("\n")

  return `${frontmatter}

${escapeText(selection.description)}

${body}
---

この記事は、X・YouTube・Steam の公開データをもとに AI（Claude）が下書きを作成し、筆者が内容を確認したうえで公開しています。掲載した投稿や動画の権利は各投稿者に帰属します。削除や掲載取りやめのご希望は、ブログのお問い合わせ先までご連絡ください。
`
}

/** 過去のダイジェスト記事に掲載済みのキー（x:123 など）を集める */
export function loadUsedKeys(dir) {
  const used = new Set()
  if (!fs.existsSync(dir)) return used
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const text = fs.readFileSync(path.join(dir, f), "utf8")
    for (const m of text.matchAll(ITEM_RE)) used.add(`${m[1]}:${m[2]}`)
  }
  return used
}

/** 記事ファイルごとの掲載キー一覧 */
export function listItemsByFile(dir) {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const file = path.join(dir, f)
      const text = fs.readFileSync(file, "utf8")
      const keys = [...text.matchAll(ITEM_RE)].map((m) => `${m[1]}:${m[2]}`)
      return { file, keys }
    })
}

/** 記事から指定キーの項目ブロックを削除する。削除した件数を返す */
export function removeItems(file, keys) {
  const text = fs.readFileSync(file, "utf8")
  let removed = 0
  const next = text.replace(ITEM_RE, (block, source, id) => {
    if (!keys.has(`${source}:${id}`)) return block
    removed++
    return ""
  })
  if (removed > 0) fs.writeFileSync(file, next)
  return removed
}
