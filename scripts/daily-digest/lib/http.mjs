/*
 * 収集・削除の確認で外部のサイトにアクセスするときの共通の決まり。
 * - ブラウザのふりをせず、このツールの名前と連絡先（ブログ）を User-Agent で名乗る
 * - robots.txt に Crawl-delay があるホストは、その間隔を空けてアクセスする
 *
 * robots.txt で禁止されているが使っているもの（どちらも運営が公開しているプログラム向けの API で、少ない回数で呼ぶ）:
 *   bookmark.hatenaapis.com（はてなブックマーク件数取得 API）/ api.steampowered.com（Steam Web API）
 */

export const USER_AGENT = "tanitaka-tech-digest/1.0 (+https://tanitaka-tech.github.io/tanitaka-techs-tech-log/)"

/** 共通のヘッダー。サイトごとに要るもの（Referer など）は extra で足す */
export const headers = (extra = {}) => ({ "User-Agent": USER_AGENT, ...extra })

/** robots.txt の Crawl-delay（ミリ秒）。ここにあるホストへは、前のアクセスからこの間隔を空ける */
const CRAWL_DELAY_MS = {
  "b.hatena.ne.jp": 5000,
}

const lastAccess = new Map()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** fetch に User-Agent と Crawl-delay を足したもの */
export async function politeFetch(url, init = {}) {
  const host = new URL(url).hostname
  const delay = CRAWL_DELAY_MS[host]
  if (delay) {
    const wait = (lastAccess.get(host) ?? 0) + delay - Date.now()
    // 次のアクセスの時刻を先に取っておき、並列に呼ばれても間隔が詰まらないようにする
    lastAccess.set(host, Date.now() + Math.max(wait, 0))
    if (wait > 0) await sleep(wait)
  }
  return fetch(url, { ...init, headers: headers(init.headers) })
}
