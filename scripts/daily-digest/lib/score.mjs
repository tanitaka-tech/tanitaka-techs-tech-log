import { hoursBetween } from "./date.mjs"

/** 反応数 ÷ 経過時間。経過時間は最低1時間として扱い、投稿直後の数字の振れを抑える */
export function velocity(engagement, publishedAt, now = new Date()) {
  const hours = Math.max(hoursBetween(publishedAt, now), 1)
  return engagement / hours
}

export function xEngagement(m) {
  return (
    m.like_count +
    m.retweet_count * 2 +
    m.quote_count * 2 +
    (m.bookmark_count ?? 0) * 2 +
    m.reply_count * 0.5
  )
}

export function youtubeEngagement(s) {
  return Number(s.viewCount ?? 0) + Number(s.likeCount ?? 0) * 10
}
