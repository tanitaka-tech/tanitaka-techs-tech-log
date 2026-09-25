/*
 * デイリーダイジェストの記事の表示（埋め込み・カルーセル・動画と曲・プレビューの採用トグル）。
 * 記事のあるページでだけ Layout.astro から読み込み、ページを表示するたびに renderDigest を呼ぶ
 */
import { renderBluesky, renderTweets, setupPixiv } from "./embeds";
import { setupDigestLists } from "./list";
import { media, setupSoundcloud, setupYoutube } from "./media";
import { setupDigestReview } from "./review";

export function renderDigest() {
	// ページ遷移で前のページの動画は消えている
	media.players = [];
	media.volumeInputs = [];
	renderTweets();
	renderBluesky();
	setupDigestLists();
	setupDigestReview();
	setupYoutube();
	setupSoundcloud();
	setupPixiv();
}
