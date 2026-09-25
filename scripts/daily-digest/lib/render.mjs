import fs from "node:fs"
import path from "node:path"
import { SOURCES, sourceOf } from "./sources.mjs"

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
/** 新作の発売日と同時接続数（「9/25 発売 · 同時接続 32,341人」） */
function steamRelease(r) {
  const date = new Date(r.date).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric" })
  return `${date} 発売 · 同時接続 ${r.players.toLocaleString("ja-JP")}人`
}

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
  const release = c.release ? `<span class="digest-steam-until">${steamRelease(c.release)}</span>` : ""
  return `<a class="digest-steam-card no-styling" href="${escapeAttr(c.url)}" target="_blank" rel="noopener"><img class="no-lightbox" src="${escapeAttr(thumbnail(c))}" alt="${escapeAttr(c.title)}" loading="lazy"><span class="digest-steam-body"><span class="digest-steam-title">${escapeText(c.title)}</span>${price}${until}${release}</span></a>`
}

const compactNumber = new Intl.NumberFormat("ja-JP", { notation: "compact", maximumFractionDigits: 1 })

/** YouTube のサムネイル右下に出す再生数（収集時点） */
function youtubeViews(c) {
  const views = c.metrics?.views
  if (views == null) return ""
  return `<span class="digest-youtube-views" title="収集時点の再生数">${compactNumber.format(views)}回視聴</span>`
}

/** SoundCloud のアートワーク右下に出す再生数（収集時点） */
function soundcloudPlays(c) {
  const plays = c.metrics?.plays
  if (plays == null) return ""
  return `<span class="digest-soundcloud-plays" title="収集時点の再生数">${compactNumber.format(plays)}回再生</span>`
}

/** SoundCloud のアートワーク URL（-t500x500 など）のサイズを差し替える */
const soundcloudArtwork = (url, size) => url?.replace(/-t500x500\.(\w+)$/, `-${size}.$1`)

/** はてなブックマークの記事のリンクカード（はてなのエントリー画像・タイトル・サイト名・ブックマーク数） */
function hatenaCard(c) {
  return `<a class="digest-link-card no-styling" href="${escapeAttr(c.url)}" target="_blank" rel="noopener"><img class="no-lightbox" src="${escapeAttr(thumbnail(c))}" alt="" loading="lazy"><span class="digest-link-body"><span class="digest-link-title">${escapeText(c.title)}</span><span class="digest-link-meta">${escapeText(c.author.name)}${c.metrics?.bookmarks ? ` · はてなブックマーク ${c.metrics.bookmarks}users` : ""}</span></span></a>`
}

/**
 * Misskey のノートのカード。Misskey の埋め込みは他サイトの iframe に出せないので自前で描く。
 * カスタム絵文字（:emoji:）は消して表示する
 */
/** Misskey のカスタム絵文字（:name:）は画像がないと読めないので消す */
const stripEmoji = (s) => (s ?? "").replace(/:[a-z0-9_+-]+:/gi, "").replace(/[ \t]{2,}/g, " ").trim()

function misskeyCard(c) {
  // 画像はリンクにせず、クリックでその場で拡大表示する（記事の画像と同じライトボックス）。全体が見えるよう切り抜かない
  const images = (c.images ?? []).map((src) => `<img src="${escapeAttr(src)}" alt="" loading="lazy">`).join("")
  const author = `<a class="digest-misskey-author no-styling" href="${escapeAttr(c.url)}" target="_blank" rel="noopener">${c.author.avatar ? `<img class="no-lightbox" src="${escapeAttr(c.author.avatar)}" alt="" loading="lazy">` : ""}<span><strong>${escapeText(stripEmoji(c.author.name) || c.author.handle)}</strong> @${escapeText(c.author.handle)}</span></a>`
  const text = stripEmoji(c.text) ? `<p class="digest-misskey-text">${escapeText(stripEmoji(c.text))}</p>` : ""
  return `<div class="digest-misskey-card">${author}${text}${images ? `<div class="digest-misskey-images n${Math.min(c.images.length, 4)}">${images}</div>` : ""}<a class="digest-misskey-meta no-styling" href="${escapeAttr(c.url)}" target="_blank" rel="noopener">リアクション ${c.metrics?.reactions ?? 0} · リノート ${c.metrics?.renotes ?? 0} · ${escapeText(c.host ?? "misskey.io")} で見る</a></div>`
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
      return `<a class="digest-youtube-facade no-styling" href="${escapeAttr(c.url)}" data-video-id="${escapeAttr(c.id)}" data-title="${escapeAttr(c.title)}" target="_blank" rel="noopener"><img class="no-lightbox" src="${escapeAttr(thumbnail(c))}" alt="${escapeAttr(c.title)}" loading="lazy"><span class="digest-youtube-title">${escapeText(c.title)}</span><span class="digest-youtube-play" aria-hidden="true"></span>${youtubeViews(c)}</a>`
    case "soundcloud":
      // YouTube と同じく、最初はアートワークだけを出し、クリックでプレーヤー（iframe）に差し替える（Layout.astro）
      return `<a class="digest-soundcloud-facade no-styling" href="${escapeAttr(c.url)}" data-track-id="${escapeAttr(c.id)}" data-title="${escapeAttr(c.title)}" target="_blank" rel="noopener"><img class="digest-soundcloud-bg no-lightbox" src="${escapeAttr(thumbnail(c))}" alt="" aria-hidden="true" loading="lazy"><img class="digest-soundcloud-art no-lightbox" src="${escapeAttr(thumbnail(c))}" alt="${escapeAttr(c.title)}" loading="lazy"><span class="digest-soundcloud-title">${escapeText(c.title)}<span class="digest-soundcloud-author">${escapeText(c.author.name)}</span></span><span class="digest-soundcloud-play" aria-hidden="true"></span>${soundcloudPlays(c)}</a>`
    case "steam":
      return steamCard(c)
    case "hatena":
      return hatenaCard(c)
    case "bluesky":
      // 公式の埋め込み（embed.bsky.app の embed.js が iframe に差し替える。読み込みは Layout.astro）
      return `<blockquote class="bluesky-embed" data-bluesky-uri="${escapeAttr(c.uri)}" data-bluesky-cid="${escapeAttr(c.cid)}"><a href="${escapeAttr(c.url)}">@${escapeText(c.author.handle)} さんの Bluesky の投稿を見る</a></blockquote>`
    case "misskey":
      return misskeyCard(c)
    case "pixiv":
      // pixiv 公式の埋め込み。name は、埋め込みが送ってくる高さ（postMessage）をどの iframe に当てるかの目印（Layout.astro）
      // 埋め込みは幅が固定（700px）なので、枠（digest-pixiv-frame）の幅に合わせて縮小する
      return `<div class="digest-pixiv-frame"><iframe class="digest-pixiv" name="pixiv-${escapeAttr(c.id)}" src="https://embed.pixiv.net/embed_mk2.php?id=${escapeAttr(c.id)}&amp;size=large&amp;border=on&amp;frame=1" title="${escapeAttr(c.title)} / ${escapeAttr(c.author.name)}" loading="lazy"></iframe></div>`
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
    case "soundcloud":
    case "hatena":
    case "pixiv":
      return { label: c.title, meta: c.author.name }
    case "steam": {
      const sale = steamSale(c)
      if (sale) return { label: c.title, meta: `-${sale.discountPercent}% ${yen(sale.finalPrice)}` }
      return { label: c.title, meta: c.release ? steamRelease(c.release) : "Steam" }
    }
    case "misskey":
      return { label: stripEmoji(c.author.name) || c.author.handle, meta: `@${c.author.handle}` }
    default:
      return { label: c.author.name, meta: `@${c.author.handle}` }
  }
}

/** 目次に小さく出す画像。YouTube は軽い 320px 版、SoundCloud は 300px のアートワーク、X は投稿者のアイコン（収集時に取れたときだけ） */
function tocThumb(c) {
  if (c.source === "youtube") return `https://i.ytimg.com/vi/${c.id}/mqdefault.jpg`
  if (sourceOf(c.source)?.social) return c.author.avatar
  if (c.source === "soundcloud") return soundcloudArtwork(thumbnail(c), "t300x300")
  return thumbnail(c)
}

/** プレビューの記事の先頭に出す警告の一覧。公開する記事には出さない */
function reviewBanner(warnings, date, topicKey) {
  const list = warnings.length
    ? `<ul>${warnings.map((w) => `<li>${escapeText(w)}</li>`).join("")}</ul>`
    : "<p>警告はありません。</p>"
  return `<div class="digest-review-banner" data-date="${escapeAttr(date)}" data-thumb-key="${escapeAttr(topicKey ?? "")}"><p><strong>⚠️ プレビュー用の表示です。</strong>公開する記事（render --final / publish）には出ません。項目ごとの「採用」を切り替えると、selection.json に保存されます（pnpm dev のときだけ）。目次の 🖼 を押すと、その項目の画像を記事のサムネイルにします。</p>${list}</div>\n\n`
}

/** 記事末尾の出典の説明に出す、掲載した項目のソース名（「はてなブックマーク・YouTube」） */
function credits(sections) {
  const used = new Set(sections.flatMap(([, list]) => list.map(({ c }) => c.source)))
  return SOURCES.filter((s) => used.has(s.id))
    .map((s) => s.name)
    .join("・")
}

/**
 * 記事を組み立てる。項目はカテゴリ（ジャンルのラベル）ごとにまとめ、categoryOrder の順に
 * 「固定の見出し + 目次付きの項目一覧」として並べる（目次と切り替えは Layout.astro が付ける）。
 * review（警告の配列）を渡すとプレビュー用になり、先頭に警告の一覧、項目に注意（note）を表示する。
 */
export function renderArticle({
  date,
  selection,
  candidatesByKey,
  category,
  fixedTags,
  categoryOrder,
  stepOrder = [],
  review = null,
  categoryLimit = () => Number.POSITIVE_INFINITY,
  keepOrder = false,
}) {
  const items = selection.items.map((i) => ({ ...i, c: candidatesByKey.get(i.key) }))
  const groups = new Map()
  for (const label of categoryOrder) groups.set(label, [])
  for (const item of items) groups.get(item.c.genreLabel).push(item)
  // step（カルーセル内の区切り）があるカテゴリは、step の順に並べ、その中はスコア順にする。
  // ソースが違うとスコアの単位が揃わないので、step をまたいでスコアでは比べない
  const stepRank = (c) => (c.step ? stepOrder.indexOf(c.step) : -1)
  for (const list of groups.values()) {
    if (keepOrder || !list.some(({ c }) => c.step)) continue
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

<div class="digest-items"${review ? ` data-limit="${categoryLimit(label)}"` : ""}>
${list
  .map(({ c, note, adopt }) => {
    // プレビューでは注意のある項目に印を付け、目次でも分かるようにする
    const notes = review && note ? [note] : []
    const meta = `${notes.length ? "⚠️ " : ""}${tocLabel(c).meta}`
    const noteHtml = notes.length ? `<p class="digest-review-note">⚠️ ${escapeText(notes.join(" / "))}</p>\n` : ""
    return `<!-- digest-item ${c.source}:${c.id} -->
<div class="digest-entry digest-entry-${c.source}"${review ? ` data-key="${escapeAttr(c.key)}" data-adopt="${adopt !== false}"${thumbnail(c) ? ` data-image="${escapeAttr(thumbnail(c))}"` : ""}` : ""} data-label="${escapeAttr(tocLabel(c).label)}" data-meta="${escapeAttr(meta)}"${tocThumb(c) ? ` data-thumb="${escapeAttr(tocThumb(c))}"` : ""}${c.step ? ` data-step="${escapeAttr(c.step)}"` : ""}>
${noteHtml}${embed(c)}
</div>
<!-- /digest-item -->
`
  })
  .join("")}</div>

<!-- /digest-section -->
`,
    )
    .join("\n")

  return `${frontmatter}

${review ? reviewBanner(review, date, selection.topicKey) : ""}${body}
---

この記事は、${credits(sections)}の公開データをもとに AI が掲載候補を選び、筆者が内容を確認したうえで公開しています。掲載した投稿や動画の権利は各投稿者に帰属します。削除や掲載取りやめのご希望は、ブログのお問い合わせ先までご連絡ください。
`
}

/** 過去のダイジェスト記事に掲載済みのキー（x:123 など）を集める。exclude のファイル名は数えない */
export function loadUsedKeys(dir, { exclude = [] } = {}) {
  const used = new Set()
  if (!fs.existsSync(dir)) return used
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md") && !exclude.includes(f))) {
    const text = fs.readFileSync(path.join(dir, f), "utf8")
    for (const m of text.matchAll(ITEM_RE)) used.add(`${m[1]}:${m[2]}`)
  }
  return used
}

/** 記事ファイルごとの掲載キー一覧と、キー → 項目の最初のリンク先（はてなの記事など、キーから URL を戻せない項目の確認用） */
export function listItemsByFile(dir) {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const file = path.join(dir, f)
      const text = fs.readFileSync(file, "utf8")
      const blocks = [...text.matchAll(ITEM_RE)]
      const keys = blocks.map((m) => `${m[1]}:${m[2]}`)
      const urls = new Map(blocks.map((m) => [`${m[1]}:${m[2]}`, m[0].match(/href="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&")]))
      return { file, keys, urls }
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
