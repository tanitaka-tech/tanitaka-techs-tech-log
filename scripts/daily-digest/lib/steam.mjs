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
      url: `https://store.steampowered.com/app/${i.id}/`,
      title: i.name,
      thumbnail: i.header_image,
      text: `${i.name} が ${i.discount_percent}%オフ（¥${Math.round(i.original_price / 100)} → ¥${Math.round(i.final_price / 100)}）${
        i.discount_expiration
          ? `。セール終了: ${new Date(i.discount_expiration * 1000).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`
          : ""
      }`,
      author: { name: "Steam", handle: "steam" },
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
