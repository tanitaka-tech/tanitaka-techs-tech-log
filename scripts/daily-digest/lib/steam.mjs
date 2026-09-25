/**
 * Steam ストアの「スペシャル（セール中）」から割引率の高いものを候補にする。
 * セールには開始日時がないため、過去のダイジェストで紹介済みのものは呼び出し側で除外する。
 */
export async function fetchSteamSales(genre, config) {
  const sc = config.steam
  const res = await fetch(
    "https://store.steampowered.com/api/featuredcategories?cc=jp&l=japanese",
  )
  if (!res.ok) throw new Error(`Steam API ${res.status}`)
  const body = await res.json()

  return (body.specials?.items ?? [])
    .filter((i) => i.discounted && i.discount_percent >= sc.minDiscountPercent)
    .sort((a, b) => b.discount_percent - a.discount_percent)
    .slice(0, sc.maxItems)
    .map((i) => ({
      key: `steam:${i.id}`,
      source: "steam",
      id: String(i.id),
      genre: genre.id,
      genreLabel: genre.label,
      // type 1 は同梱版などのパッケージ（sub）で、ストアの URL が違う
      url: `https://store.steampowered.com/${i.type === 1 ? "sub" : "app"}/${i.id}/`,
      title: i.name,
      thumbnail: i.header_image,
      text: `${i.name} が ${i.discount_percent}%オフ（¥${Math.round(i.original_price / 100)} → ¥${Math.round(i.final_price / 100)}）${
        i.discount_expiration
          ? `。セール終了: ${new Date(i.discount_expiration * 1000).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`
          : ""
      }`,
      author: { id: "steam", name: "Steam", handle: "steam" },
      publishedAt: new Date().toISOString(),
      metrics: { discountPercent: i.discount_percent },
      sale: {
        discountPercent: i.discount_percent,
        originalPrice: Math.round(i.original_price / 100),
        finalPrice: Math.round(i.final_price / 100),
        endsAt: i.discount_expiration ? new Date(i.discount_expiration * 1000).toISOString() : null,
      },
      // 割引率をそのままスコアにする（他ソースとは比較しない）
      score: i.discount_percent,
    }))
}

// 成人向けの内容（3: Adult Only Sexual Content / 4: Frequent Nudity or Sexual Content）
const ADULT_DESCRIPTORS = new Set([3, 4])

/** ストア検索の結果（HTML 断片）から、アプリ ID・名前・発売日（「2026年9月25日」）を取り出す */
export function parseSearchResults(html) {
  return [...html.matchAll(/<a [^>]*data-ds-appid="(\d+)"[\s\S]*?<\/a>/g)].map(([row, id]) => {
    const name = row.match(/<span class="title">([^<]*)<\/span>/)?.[1] ?? ""
    const m = row.match(/search_released[^>]*>\s*(\d+)年(\d+)月(\d+)日/)
    return {
      id,
      name: name.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"'),
      // ストアの日付は JST の日付として扱う
      released: m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], -9)) : null,
    }
  })
}

/** 発売日の新しい順にストアを検索し、since 以降に発売されたゲームを集める（1ページ100件、pages ページまで） */
async function searchNewReleases(since, pages) {
  const apps = []
  for (let page = 0; page < pages; page++) {
    const url = `https://store.steampowered.com/search/results/?query&start=${page * 100}&count=100&sort_by=Released_DESC&category1=998&infinite=1&cc=jp&l=japanese`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Steam 検索 ${res.status}`)
    const found = parseSearchResults((await res.json()).results_html ?? "")
    apps.push(...found.filter((a) => a.released && a.released >= since))
    // 発売日順なので、対象期間より前のゲームが出てきたら次のページは読まない
    if (found.length === 0 || found.some((a) => a.released && a.released < since)) break
  }
  return apps
}

/** 現在の同時接続数。ほしい物リストの数は公開されていないので、発売直後の人気の目安にする */
async function currentPlayers(ids) {
  const players = new Map()
  for (let i = 0; i < ids.length; i += 10) {
    await Promise.all(
      ids.slice(i, i + 10).map(async (id) => {
        const res = await fetch(`https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${id}`)
        // 未発売・統計なしのゲームは 404 になる
        players.set(id, res.ok ? ((await res.json()).response?.player_count ?? 0) : 0)
      }),
    )
  }
  return players
}

async function appDetails(id) {
  const res = await fetch(`https://store.steampowered.com/api/appdetails?appids=${id}&cc=jp&l=japanese`)
  if (!res.ok) return null
  return (await res.json())[id]?.data ?? null
}

/**
 * 直近に発売されたゲームを、発売直後の同時接続数で並べる。
 *   maxReleaseAgeDays: 何日前の発売まで対象にするか（ストアの発売日は日付だけなので、1なら昨日と今日）
 *   minPlayers:        同時接続数の下限
 * 成人向けのゲームは除く
 */
export async function fetchSteamNewReleases(genre, now = new Date(), drops = {}) {
  const today = new Date(now.getTime() + 9 * 3600_000)
  const since = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (genre.maxReleaseAgeDays ?? 1), -9))
  const apps = await searchNewReleases(since, genre.pages ?? 3)
  const players = await currentPlayers(apps.map((a) => a.id))
  const popular = apps
    .map((a) => ({ ...a, players: players.get(a.id) ?? 0 }))
    .filter((a) => {
      const ok = a.players >= (genre.minPlayers ?? 100)
      if (!ok) drops["同接不足"] = (drops["同接不足"] ?? 0) + 1
      return ok
    })
    .sort((a, b) => b.players - a.players)
    .slice(0, genre.maxItems ?? 15)
  const candidates = []
  for (const a of popular) {
    const d = await appDetails(a.id)
    if ((d?.content_descriptors?.ids ?? []).some((n) => ADULT_DESCRIPTORS.has(n))) {
      drops["成人向け"] = (drops["成人向け"] ?? 0) + 1
      continue
    }
    const date = a.released.toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric" })
    candidates.push({
      key: `steam:${a.id}`,
      source: "steam",
      id: a.id,
      genre: genre.id,
      genreLabel: genre.label,
      url: `https://store.steampowered.com/app/${a.id}/`,
      title: d?.name ?? a.name,
      thumbnail: d?.header_image,
      text: `${date} 発売。同時接続 ${a.players.toLocaleString("ja-JP")}人${d?.short_description ? `。${d.short_description}` : ""}`.slice(0, 400),
      author: { id: "steam", name: "Steam", handle: "steam" },
      publishedAt: a.released.toISOString(),
      metrics: { players: a.players },
      release: { date: a.released.toISOString(), players: a.players },
      score: a.players,
    })
  }
  console.log(`[steam] ${genre.id}: 発売から${genre.maxReleaseAgeDays ?? 1}日以内 ${apps.length}本から ${candidates.length}本`)
  return candidates
}
