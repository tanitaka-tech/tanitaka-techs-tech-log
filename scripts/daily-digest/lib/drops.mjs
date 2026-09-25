/*
 * 収集で候補から外した件数を、理由ごとに数える（drops = { 理由: 件数 }）。
 * collect.json に残し、review でジャンルごとの条件（いいね数・期間など）の調整に使う。
 */

export function countDrop(drops, reason) {
  if (drops && reason) drops[reason] = (drops[reason] ?? 0) + 1
}

/** checks（[理由, 残す条件] の配列）を順に当て、最初に満たさなかった理由で数えて外す */
export function filterWithReasons(items, checks, drops) {
  return items.filter((item) => {
    const failed = checks.find(([, keep]) => !keep(item))
    countDrop(drops, failed?.[0])
    return !failed
  })
}
