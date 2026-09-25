import fs from "node:fs"
import path from "node:path"

const ITEM_RE = /<!-- digest-item (\w+):(\S+) -->[\s\S]*?<!-- \/digest-item -->\n*/g
const SECTION_RE = /<!-- digest-section -->[\s\S]*?<!-- \/digest-section -->\n*/g

function escapeText(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function escapeAttr(s) {
  return escapeText(s).replace(/"/g, "&quot;")
}

/** sale を保存していない古い候補データ用に、text から価格を読み取る */
function steamSale(c) {
  if (c.sale) return c.sale
  const m = c.text.match(/(\d+)%オフ（¥(\d+) → ¥(\d+)）/)
  if (!m) return null
  // 終了日時は JST の「2026/10/2 2:00:00」形式
  const e = c.text.match(/セール終了: (\d+)\/(\d+)\/(\d+) (\d+):(\d+)/)
  return {
    discountPercent: Number(m[1]),
    originalPrice: Number(m[2]),
    finalPrice: Number(m[3]),
    endsAt: e ? new Date(Date.UTC(+e[1], +e[2] - 1, +e[3], +e[4] - 9, +e[5])).toISOString() : null,
  }
}

const yen = (n) => `¥${n.toLocaleString("ja-JP")}`

/**
 * Steam 公式ウィジェット（iframe）は幅646px前提で狭い画面では崩れるので、
 * ストアへのリンク付きのカードを自前で描く
 */
function steamCard(c) {
  const sale = steamSale(c)
  const until = sale?.endsAt
    ? `<span class="digest-steam-until">${new Date(sale.endsAt).toLocaleString("ja-JP", {
        timeZone: "Asia/Tokyo",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })} まで</span>`
    : ""
  const price = sale
    ? `<span class="digest-steam-price"><span class="digest-steam-discount">-${sale.discountPercent}%</span><s>${yen(sale.originalPrice)}</s><strong>${yen(sale.finalPrice)}</strong></span>`
    : ""
  return `<a class="digest-steam-card no-styling" href="${escapeAttr(c.url)}" target="_blank" rel="noopener"><img class="no-lightbox" src="${escapeAttr(thumbnail(c))}" alt="${escapeAttr(c.title)}" loading="lazy"><span class="digest-steam-body"><span class="digest-steam-title">${escapeText(c.title)}</span>${price}${until}</span></a>`
}

function embed(c) {
  switch (c.source) {
    case "x":
      // 公式の埋め込み。本文はリポジトリに保存せず、表示は widgets.js に任せる
      return `<blockquote class="twitter-tweet" data-dnt="true"><a href="https://twitter.com/${c.author.handle}/status/${c.id}">@${escapeText(c.author.handle)} さんのポストを見る</a></blockquote>`
    case "youtube":
      // 最初はサムネイルだけを出し、クリックでプレーヤー（iframe）に差し替える（Layout.astro）。
      // iframe の上ではホイール操作がページに届かずカルーセルを送れないのと、動画が多いと重いため。
      // JavaScript が動かない環境（RSS など）では YouTube へのリンクになる
      return `<a class="digest-youtube-facade no-styling" href="${escapeAttr(c.url)}" data-video-id="${escapeAttr(c.id)}" data-title="${escapeAttr(c.title)}" target="_blank" rel="noopener"><img class="no-lightbox" src="${escapeAttr(thumbnail(c))}" alt="${escapeAttr(c.title)}" loading="lazy"><span class="digest-youtube-title">${escapeText(c.title)}</span><span class="digest-youtube-play" aria-hidden="true"></span></a>`
    case "steam":
      return steamCard(c)
    default:
      throw new Error(`unknown source: ${c.source}`)
  }
}

/** 一覧・OGP に使うサムネイル。X の投稿は画像を持たないので使わない */
function thumbnail(c) {
  if (c.thumbnail) return c.thumbnail
  // thumbnail を保存していない古い候補データ用
  if (c.source === "youtube") return `https://i.ytimg.com/vi/${c.id}/hqdefault.jpg`
  if (c.source === "steam") return `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${c.id}/header.jpg`
  return undefined
}

/** 目次に出す項目名と補足。X の投稿は本文を保存しない方針なので投稿者で示す */
function tocLabel(c) {
  switch (c.source) {
    case "youtube":
      return { label: c.title, meta: c.author.name }
    case "steam": {
      const sale = steamSale(c)
      return { label: c.title, meta: sale ? `-${sale.discountPercent}% ${yen(sale.finalPrice)}` : "Steam" }
    }
    default:
      return { label: c.author.name, meta: `@${c.author.handle}` }
  }
}

/** 目次に出す数値（収集時点）。YouTube は再生数、X はいいね数とリポスト数 */
function statsAttrs(c) {
  const m = c.metrics ?? {}
  if (c.source === "youtube" && m.views != null) return ` data-views="${m.views}"`
  if (c.source === "x") return ` data-likes="${m.like_count ?? 0}" data-reposts="${m.retweet_count ?? 0}"`
  return ""
}

/**
 * 記事を組み立てる。項目はカテゴリ（ジャンルのラベル）ごとにまとめ、categoryOrder の順に
 * 「固定の見出し + 目次付きの項目一覧」として並べる（目次と切り替えは Layout.astro が付ける）。
 */
export function renderArticle({ date, selection, candidatesByKey, category, fixedTags, categoryOrder, stepOrder = [] }) {
  const items = selection.items.map((i) => ({ ...i, c: candidatesByKey.get(i.key) }))
  const groups = new Map()
  for (const label of categoryOrder) groups.set(label, [])
  for (const item of items) groups.get(item.c.genreLabel).push(item)
  // step（カルーセル内の区切り）があるカテゴリは、step の順に並べ、その中はスコア順にする。
  // ソースが違うとスコアの単位が揃わないので、step をまたいでスコアでは比べない
  const stepRank = (c) => (c.step ? stepOrder.indexOf(c.step) : -1)
  for (const list of groups.values()) {
    if (!list.some(({ c }) => c.step)) continue
    list.sort((a, b) => stepRank(a.c) - stepRank(b.c) || b.c.score - a.c.score)
  }
  const sections = [...groups].filter(([, list]) => list.length > 0)

  const tags = [...new Set([...fixedTags, category, ...sections.map(([label]) => label)])]
  const featured = candidatesByKey.get(selection.topicKey)
  const image =
    (featured && thumbnail(featured)) ?? sections.flatMap(([, list]) => list.map((i) => thumbnail(i.c))).find(Boolean)

  const frontmatter = [
    "---",
    `title: ${JSON.stringify(`${selection.topic.trim()} ${date}`)}`,
    `published: ${date}`,
    `description: ${JSON.stringify(selection.description)}`,
    `image: ${JSON.stringify(image ?? "")}`,
    `tags: ${JSON.stringify(tags)}`,
    `category: ${JSON.stringify(category)}`,
    "draft: false",
    `lang: ""`,
    "---",
  ].join("\n")

  // 一覧の中に空行を入れると Markdown として解釈されてしまうので、1つの HTML ブロックにする
  const body = sections
    .map(
      ([label, list]) => `<!-- digest-section -->
## ${escapeText(label)}

<div class="digest-items">
${list
  .map(
    ({ c }) => `<!-- digest-item ${c.source}:${c.id} -->
<div class="digest-entry digest-entry-${c.source}" data-label="${escapeAttr(tocLabel(c).label)}" data-meta="${escapeAttr(tocLabel(c).meta)}"${statsAttrs(c)}${c.step ? ` data-step="${escapeAttr(c.step)}"` : ""}>
${embed(c)}
</div>
<!-- /digest-item -->
`,
  )
  .join("")}</div>

<!-- /digest-section -->
`,
    )
    .join("\n")

  return `${frontmatter}

${body}
---

この記事は、X・YouTube・Steam の公開データをもとに AI が掲載候補を選び、筆者が内容を確認したうえで公開しています。掲載した投稿や動画の権利は各投稿者に帰属します。削除や掲載取りやめのご希望は、ブログのお問い合わせ先までご連絡ください。
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
  if (removed > 0) {
    // 項目がすべて消えたカテゴリは見出しごと取り除く
    fs.writeFileSync(file, next.replace(SECTION_RE, (block) => (block.includes("<!-- digest-item ") ? block : "")))
  }
  return removed
}
