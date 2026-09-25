/*
 * 候補の集め先（source）の一覧。候補のキー（youtube:abc など）の接頭辞になる。
 * ソースを足すときはここに足し、収集（commands/collect.mjs）・表示（lib/render.mjs の embed など）・
 * 削除の確認（check-deleted.mjs）を書く。キーの形式の判定と記事末尾の出典の説明はここから作る。
 *
 *   name:   記事末尾の出典の説明・review の表示に使う名前（並び順もこの順）
 *   social:  投稿者のハンドル（@name）とアイコンを持つ SNS か。review で「名前 @handle」と出し、目次の画像にアイコンを使う
 *   metrics: review に出す反応の数（c は候補）
 */
const fmt = (n) => Number(n ?? 0).toLocaleString("ja-JP")
const sharers = (m) => (m.sharers ? ` 🔗${m.sharers}人` : "")

export const SOURCES = [
  { id: "hatena", name: "はてなブックマーク", metrics: ({ metrics: m }) => `🔖${fmt(m.bookmarks)}users` },
  { id: "bluesky", name: "Bluesky", social: true, metrics: ({ metrics: m }) => `♥${fmt(m.likes)} RP${fmt(m.reposts)}` },
  {
    id: "misskey",
    name: "Misskey",
    social: true,
    metrics: ({ metrics: m, images }) => `😀${fmt(m.reactions)} RN${fmt(m.renotes)}${images?.length ? ` 🖼${images.length}` : ""}`,
  },
  { id: "pixiv", name: "pixiv", metrics: ({ metrics: m }) => `♥${fmt(m.ratings)} 👁${fmt(m.views)} ${m.rank}位` },
  { id: "youtube", name: "YouTube", metrics: ({ metrics: m }) => `▶${fmt(m.views)} 👍${fmt(m.likes)}${sharers(m)}` },
  { id: "soundcloud", name: "SoundCloud", metrics: ({ metrics: m }) => `▶${fmt(m.plays)} ♥${fmt(m.likes)}${sharers(m)}` },
  // 新作は同時接続数、セールは割引率
  { id: "steam", name: "Steam", metrics: ({ metrics: m }) => (m.players != null ? `👥${fmt(m.players)}人` : `-${m.discountPercent}%`) },
  {
    id: "x",
    name: "X",
    social: true,
    metrics: ({ metrics: m }) => `♥${fmt(m.like_count)} RT${fmt(m.retweet_count)} 👁${m.impression_count != null ? fmt(m.impression_count) : "-"}`,
  },
]

export const SOURCE_IDS = SOURCES.map((s) => s.id)

const byId = new Map(SOURCES.map((s) => [s.id, s]))
export const sourceOf = (id) => byId.get(id)

/** 候補のキー（<ソース>:<ID>）か */
export const KEY_RE = new RegExp(`^(${SOURCE_IDS.join("|")}):\\S+$`)
