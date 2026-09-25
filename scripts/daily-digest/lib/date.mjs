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
 * 指定日（JST）の 00:00 から、その日の終わりか現在時刻の早い方までの範囲。
 * X の recent search は end_time が現在より10秒以上前である必要があるので余裕を持たせる。
 */
export function dayWindowJst(date, now = new Date()) {
  const start = new Date(`${date}T00:00:00+09:00`)
  const dayEnd = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  const end = new Date(Math.min(dayEnd.getTime(), now.getTime() - 60 * 1000))
  if (end <= start) {
    throw new Error(`${date} はまだ始まっていません`)
  }
  return { start, end }
}

export function hoursBetween(from, to) {
  return (to.getTime() - from.getTime()) / (60 * 60 * 1000)
}
