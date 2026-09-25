// デイリーダイジェストの記事に載せる、外部サービスの公式の埋め込み（X・Bluesky・pixiv）

// X の公式埋め込みは埋め込みがあるページでだけ widgets.js を読み込み、
// Swup のページ遷移後は再描画する
export function renderTweets() {
	if (!document.querySelector("blockquote.twitter-tweet")) return;
	if (window.twttr?.widgets) {
		window.twttr.widgets.load(document.querySelector("main") ?? undefined);
		return;
	}
	if (document.getElementById("twitter-wjs")) return;
	const script = document.createElement("script");
	script.id = "twitter-wjs";
	script.async = true;
	script.src = "https://platform.twitter.com/widgets.js";
	document.body.appendChild(script);
}

// Bluesky 公式の埋め込み。embed.js が blockquote.bluesky-embed を iframe に差し替える。
// ページ遷移のあとは、読み込み済みの embed.js の scan() で差し替え直す
export function renderBluesky() {
	if (!document.querySelector("blockquote.bluesky-embed")) return;
	if (window.bluesky?.scan) {
		window.bluesky.scan();
		return;
	}
	if (document.getElementById("bluesky-embed-js")) return;
	const script = document.createElement("script");
	script.id = "bluesky-embed-js";
	script.async = true;
	script.src = "https://embed.bsky.app/static/embed.js";
	document.body.appendChild(script);
}

// pixiv 公式の埋め込みは幅が 700px 固定なので、枠の幅に合わせて縮小する。
// 読み込むと ["<iframe の name>", 高さ] を postMessage で送ってくるので、高さもそれに合わせる
const PIXIV_EMBED_WIDTH = 700;
function fitPixiv(frame: HTMLIFrameElement) {
	const box = frame.parentElement;
	if (!box || box.clientWidth === 0) return;
	const scale = Math.min(1, box.clientWidth / PIXIV_EMBED_WIDTH);
	const height = Number(frame.dataset.height ?? 0) || frame.offsetHeight;
	frame.style.height = `${height}px`;
	frame.style.transform = `scale(${scale})`;
	box.style.height = `${Math.ceil(height * scale)}px`;
}
window.addEventListener("message", (e) => {
	if (e.origin !== "https://embed.pixiv.net" || typeof e.data !== "string")
		return;
	try {
		const [name, height] = JSON.parse(e.data);
		const frame = document.querySelector<HTMLIFrameElement>(
			`iframe.digest-pixiv[name="${CSS.escape(String(name))}"]`,
		);
		if (!frame || !(height > 0)) return;
		frame.dataset.height = String(height);
		fitPixiv(frame);
	} catch {}
});
// カルーセルで表示が切り替わったとき・画面の幅が変わったときも合わせ直す
const pixivResize = new ResizeObserver((entries) => {
	for (const entry of entries) {
		const frame = entry.target.querySelector<HTMLIFrameElement>(
			"iframe.digest-pixiv",
		);
		if (frame) fitPixiv(frame);
	}
});
export function setupPixiv() {
	for (const box of document.querySelectorAll<HTMLElement>(
		".digest-pixiv-frame:not([data-ready])",
	)) {
		box.dataset.ready = "true";
		pixivResize.observe(box);
	}
}
