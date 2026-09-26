/*
 * pixiv のランキング（ranking.php の JSON。ログイン不要）からイラストを集める。
 * 通常のランキングには AI 生成作品と R-18 作品が入らない。軽い性的表現（illust_content_type.sexual）の作品も除く。
 * ランキングは前日分の集計なので、対象は投稿から maxAgeHours 時間以内（既定48）にしている。
 * 記事では pixiv 公式の埋め込み（embed.pixiv.net/embed_mk2.php の iframe）で表示する。
 * i.pximg.net の画像は他のサイトからは直接表示できない（Referer で弾かれる）ので、サムネイルは保存しない。
 */
import { hoursBetween } from "./date.mjs"
import { filterWithReasons } from "./drops.mjs"
import { velocity } from "./score.mjs"
import { politeFetch } from "./http.mjs"

// ランキングの JSON と作品情報は、pixiv のページからの読み込みとして Referer を付けないと読めない
const HEADERS = { Referer: "https://www.pixiv.net/" }

/** ランキング（mode: daily / rookie / original など）を pages ページ（1ページ50件）まで読む */
async function fetchRanking(mode, pages) {
  const works = []
  for (let p = 1; p <= pages; p++) {
    const res = await politeFetch(`https://www.pixiv.net/ranking.php?mode=${mode}&content=illust&format=json&p=${p}`, { headers: HEADERS })
    // 最後のページの次は 404 になる
    if (res.status === 404) break
    if (!res.ok) throw new Error(`pixiv ランキング ${res.status} ${mode}`)
    const body = await res.json()
    works.push(...(body.contents ?? []))
    if (!body.next) break
  }
  return works
}

export function toPixivCandidate(w, genre, now = new Date()) {
  const publishedAt = new Date(w.illust_upload_timestamp * 1000)
  const id = String(w.illust_id)
  return {
    key: `pixiv:${id}`,
    source: "pixiv",
    id,
    genre: genre.id,
    genreLabel: genre.label,
    url: `https://www.pixiv.net/artworks/${id}`,
    title: w.title,
    text: (w.tags ?? []).map((t) => `#${t}`).join(" ").slice(0, 400),
    author: { id: String(w.user_id), name: w.user_name, handle: String(w.user_id) },
    publishedAt: publishedAt.toISOString(),
    metrics: { views: w.view_count ?? 0, ratings: w.rating_count ?? 0, rank: w.rank },
    // 評価（いいね）数の伸び率。閲覧数は桁が違うので使わない
    score: velocity(w.rating_count ?? 0, publishedAt, now),
  }
}

/**
 * ジャンルの modes（既定は daily）のランキングから、対象期間のイラストを集める。
 * exclude はタイトル・タグ・投稿者名に対する正規表現
 */
export async function searchPixivGenre(genre, now = new Date(), drops = {}) {
  const byId = new Map()
  for (const mode of genre.modes ?? ["daily"]) {
    for (const w of await fetchRanking(mode, genre.pages ?? 2)) if (!byId.has(w.illust_id)) byId.set(w.illust_id, w)
  }
  const exclude = genre.exclude && new RegExp(genre.exclude, "im")
  const text = (w) => `${w.title}\n${(w.tags ?? []).join("\n")}\n${w.user_name}`
  const works = filterWithReasons(
    [...byId.values()],
    [
      // 0: イラスト / 1: マンガ / 2: うごイラ。マンガは埋め込みで読めないので除く
      ["イラスト以外", (w) => String(w.illust_type) !== "1"],
      ["センシティブ", (w) => !w.is_masked && !(w.illust_content_type?.sexual > 0) && !w.illust_content_type?.grotesque],
      ["除外語", (w) => !exclude || !exclude.test(text(w))],
      ["期間外", (w) => hoursBetween(new Date(w.illust_upload_timestamp * 1000), now) <= (genre.maxAgeHours ?? 48)],
      ["評価不足", (w) => (w.rating_count ?? 0) >= (genre.minRatings ?? 0)],
    ],
    drops,
  )
  console.log(`[pixiv] ${genre.id}: ランキング ${byId.size}件から ${works.length}件`)
  return works.map((w) => toPixivCandidate(w, genre, now))
}

/** 削除・非公開になった作品の ID を返す（作品の情報の API が 404 になるもの） */
export async function findUnavailableWorks(ids) {
  const missing = []
  for (const id of ids) {
    const res = await politeFetch(`https://www.pixiv.net/ajax/illust/${id}`, { headers: HEADERS })
    if (res.status === 404) missing.push(id)
    else if (!res.ok) throw new Error(`pixiv ${res.status} ajax/illust/${id}`)
  }
  return missing
}
