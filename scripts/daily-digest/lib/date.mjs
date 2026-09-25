const JST_OFFSET_MS = 9 * 60 * 60 * 1000

/** 今日の日付（JST）を YYYY-MM-DD で返す */
export function todayJst(now = new Date()) {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10)
}

export function resolveTargetDate(input, now = new Date()) {
  if (!input) return todayJst(now)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    throw new Error(`日付は YYYY-MM-DD 形式で指定してください: ${input}`)
  }
  return input
}

/**
 * 実行時点から hours 時間さかのぼった範囲。
 * X の recent search は end_time が現在より10秒以上前である必要があるので余裕を持たせる。
 */
export function recentWindow(now = new Date(), hours = 24) {
  const end = new Date(now.getTime() - 60 * 1000)
  const start = new Date(now.getTime() - hours * 60 * 60 * 1000)
  return { start, end }
}

export function hoursBetween(from, to) {
  return (to.getTime() - from.getTime()) / (60 * 60 * 1000)
}
