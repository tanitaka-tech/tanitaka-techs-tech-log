import { OverlayScrollbars } from "overlayscrollbars";
import {
	createProgressBar,
	createVolumeControl,
	isMediaEntry,
	playButtonEntries,
	togglePlay,
	updatePlayButtons,
} from "./media";

// デイリーダイジェストのカルーセル。
// ページのスクロール中にカーソルが目次に乗っても、この時間（ms）以内に続く操作はページのスクロールとして扱う
const PAGE_WHEEL_CONTINUE_MS = 200;
let lastPageWheel = 0;
document.addEventListener(
	"wheel",
	(e) => {
		// 目次の上での操作は、ページのスクロールとして数えない
		if (!(e.target instanceof Element && e.target.closest(".digest-toc")))
			lastPageWheel = performance.now();
	},
	{ passive: true, capture: true },
);

/** カテゴリの見出しに件数を付ける */
function setupDigestHeading(heading: HTMLElement, count: number) {
	const countLabel = document.createElement("span");
	countLabel.className = "digest-count";
	countLabel.textContent = `${count}件`;
	heading.insertBefore(countLabel, heading.querySelector("a.anchor"));
}

let digestBodyCount = 0;

// 縦に長い項目は、この高さまでにして中でスクロールさせる。1件が長いとカルーセル全体が伸びるため
const DIGEST_TALL_PX = 640;

/** container の中で el が中央あたりに来るようにスクロールする */
function revealIn(
	container: HTMLElement,
	el: HTMLElement,
	behavior: ScrollBehavior,
) {
	const c = container.getBoundingClientRect();
	const r = el.getBoundingClientRect();
	container.scrollTo({
		top: container.scrollTop + (r.top - c.top) - (c.height - r.height) / 2,
		behavior,
	});
}

/** 目次に出す小さな画像。画像がない項目（アイコンが取れていない X の投稿など）は CSS で文字を出す */
function digestThumb(entry: HTMLElement) {
	const thumb = document.createElement("span");
	thumb.className = `digest-toc-thumb ${entry.className.match(/digest-entry-(\w+)/)?.[1] ?? ""}`;
	if (entry.dataset.thumb) {
		const img = document.createElement("img");
		img.src = entry.dataset.thumb;
		img.alt = "";
		img.loading = "lazy";
		img.className = "no-lightbox";
		thumb.append(img);
	}
	return thumb;
}

/**
 * 縦に長い項目は高さを DIGEST_TALL_PX までにして、項目の中でスクロールさせる（折りたたむより操作が少ない）。
 * 長くない項目には付けない（はみ出しを隠すと、埋め込みの影などが切れるため）
 */
function limitIfTall(entry: HTMLElement) {
	entry.classList.toggle(
		"digest-tall",
		entry.scrollHeight > DIGEST_TALL_PX + 40,
	);
}

/** カルーセルを外から操作するためのもの（プレビューの並べ替えで使う） */
export type DigestList = {
	entries: HTMLElement[];
	tabOf: (entry: HTMLElement) => HTMLButtonElement | undefined;
	/** order の順に並べ替える（ページは読み込み直さない） */
	reorder: (order: HTMLElement[]) => void;
};
export const digestLists = new WeakMap<HTMLElement, DigestList>();

/**
 * デイリーダイジェストの項目一覧。左に選択中の項目、右に目次を表示する。
 * - 項目は1件だけ表示し、切り替えは前の項目が縮んで消え、次の項目が少し行き過ぎてから収まるアニメーションにする。
 *   高さは一番高い項目に揃える。縦に長い項目は DIGEST_TALL_PX までにして、項目の中でスクロールさせる
 * - 目次は左側と同じ高さにし、長いときは目次の中でスクロールする。クリック・ホバー・上下キーで選ぶ
 *   （ホバーで選んだときは目次をスクロールしない）
 * - スマホでは目次を長押しすると「なぞるモード」になり、指の下の項目に切り替えていく
 * - 動画・曲の項目は、目次の再生ボタンで再生・停止できる。項目を切り替えても再生は止めない
 * - ページのスクロール中にカーソルが目次に乗っても、ページをスクロールし続ける
 */
export function setupDigestLists() {
	const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
	const canHover = window.matchMedia("(hover: hover) and (pointer: fine)");
	const scrollBehavior = (): ScrollBehavior =>
		reduceMotion.matches ? "instant" : "smooth";
	for (const panel of document.querySelectorAll<HTMLElement>(".digest-items")) {
		if (panel.dataset.ready) continue;
		panel.dataset.ready = "true";
		const entries = [...panel.children] as HTMLElement[];
		if (entries.length === 0) continue;

		// カードの下半分。見出しとの区切り線と一覧を入れる
		const body = document.createElement("div");
		body.className = "digest-body";
		body.id = `digest-body-${++digestBodyCount}`;
		const inner = document.createElement("div");
		inner.className = "digest-body-inner";
		const content = document.createElement("div");
		content.className = "digest-body-content";
		const divider = document.createElement("div");
		divider.className = "digest-divider";
		panel.before(body);
		body.append(inner);
		inner.append(content);
		content.append(divider);
		const heading = panel
			.closest("section")
			?.querySelector<HTMLElement>(":scope > h2");
		if (heading) {
			setupDigestHeading(heading, entries.length);
		}
		const hasMedia = entries.some(isMediaEntry);
		if (entries.length < 2) {
			content.append(panel);
			if (hasMedia) content.append(createVolumeControl());
			for (const entry of entries) limitIfTall(entry);
			continue;
		}

		const wrap = document.createElement("div");
		wrap.className = "digest-browser";
		const main = document.createElement("div");
		main.className = "digest-main";
		const toc = document.createElement("div");
		toc.className = "digest-toc";
		toc.setAttribute("role", "tablist");
		toc.setAttribute("aria-orientation", "vertical");
		content.append(wrap);
		wrap.append(main, toc);
		main.append(panel);
		// 動画・曲のあるカルーセルには、表示中の項目に関係なく音量のスライダーを常に出す
		if (hasMedia) main.append(createVolumeControl());
		panel.classList.add("switching");

		const tabByEntry = new Map<HTMLElement, HTMLButtonElement>();
		const tabs = entries.map((entry, i) => {
			const tab = document.createElement("button");
			tab.type = "button";
			tab.setAttribute("role", "tab");
			const text = document.createElement("span");
			text.className = "digest-toc-text";
			const label = document.createElement("span");
			label.className = "digest-toc-label";
			label.textContent = entry.dataset.label || `${i + 1}件目`;
			const meta = document.createElement("span");
			meta.className = "digest-toc-meta";
			meta.textContent = entry.dataset.meta ?? "";
			text.append(label, meta);
			tab.append(digestThumb(entry), text);
			// 並べ替えで位置が変わるので、番号ではなくその時点の位置で選ぶ
			tab.addEventListener("click", () => commit(tabs.indexOf(tab)));
			if (canHover.matches)
				tab.addEventListener("mouseenter", () =>
					hoverSelect(tabs.indexOf(tab)),
				);
			if (isMediaEntry(entry)) {
				// 目次から再生・停止できるボタン（ボタンの中にボタンは置けないので span にする）
				const play = document.createElement("span");
				play.className = "digest-toc-play";
				play.setAttribute("role", "button");
				play.tabIndex = 0;
				playButtonEntries.set(play, entry);
				const onPlay = (e: Event) => {
					e.stopPropagation();
					e.preventDefault();
					commit(tabs.indexOf(tab), false);
					togglePlay(entry);
				};
				play.addEventListener("click", onPlay);
				play.addEventListener("keydown", (e) => {
					if (e.key === "Enter" || e.key === " ") onPlay(e);
				});
				tab.append(play, createProgressBar(entry, tab));
			}
			entry.setAttribute("role", "tabpanel");
			toc.append(tab);
			tabByEntry.set(entry, tab);
			return tab;
		});
		updatePlayButtons();

		// 目次のスクロールバーを、ページ全体やコードブロックと同じ見た目にする
		const tocViewport = OverlayScrollbars(toc, {
			overflow: { x: "hidden" },
			scrollbars: {
				theme: "scrollbar-base scrollbar-auto",
				autoHide: "leave",
				autoHideDelay: 500,
				autoHideSuspend: false,
			},
		}).elements().viewport;

		// 表示中の項目。前の項目は縮んで消え、次の項目は少し行き過ぎてから収まる
		let shown: HTMLElement | undefined;
		let lastSwitch = 0;
		const show = (to: HTMLElement) => {
			if (to === shown) return;
			const from = shown;
			const dir =
				Math.sign(entries.indexOf(to) - (from ? entries.indexOf(from) : -1)) ||
				1;
			for (const el of [from, to])
				for (const a of el?.getAnimations() ?? []) a.cancel();
			from?.classList.remove("active", "leaving");
			to.classList.add("active");
			// 速く次々に切り替わるときや、初回表示ではアニメーションしない
			const now = performance.now();
			const animate = !!from && now - lastSwitch > 90 && !reduceMotion.matches;
			shown = to;
			lastSwitch = now;
			if (!animate || !from) return;
			from.classList.add("leaving");
			const leave = from.animate(
				[
					{ opacity: 1, transform: "none" },
					{ opacity: 0, transform: `translateY(${-dir * 14}px) scale(0.94)` },
				],
				{ duration: 150, easing: "cubic-bezier(0.4, 0, 1, 1)" },
			);
			const done = () => from.classList.remove("leaving");
			leave.finished.then(done, done);
			to.animate(
				[
					{ opacity: 0, transform: `translateY(${dir * 28}px) scale(0.92)` },
					{
						opacity: 1,
						transform: `translateY(${-dir * 3}px) scale(1.015)`,
						offset: 0.6,
					},
					{ opacity: 1, transform: "none" },
				],
				{ duration: 380, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
			);
		};

		// 選択中の項目。目次にホバーしたときも、その項目に切り替える。
		// 項目を切り替えても、再生中の動画・曲は止めない（別の項目を再生したときに止まる）
		let active = -1;
		// 選んだ直後は、目次が自動でスクロールして止まっているカーソルの下に別の項目が来るので、
		// マウスが実際に動くまではホバーで切り替えない
		let hoverLocked = false;
		const markSelected = () => {
			tabs.forEach((tab, j) => {
				tab.setAttribute("aria-selected", String(j === active));
				tab.tabIndex = j === active ? 0 : -1;
			});
		};
		// reveal: 選んだ項目が見えるよう目次をスクロールするか（ホバーで選んだときは、カーソルの下の目次が動くと
		// 使いにくいのでスクロールしない）
		const commit = (index: number, reveal = true) => {
			if (index === -1) return;
			const i = Math.max(0, Math.min(entries.length - 1, index));
			hoverLocked = true;
			if (i !== active) {
				active = i;
				markSelected();
				if (reveal) revealIn(tocViewport, tabs[i], scrollBehavior());
			}
			show(entries[i]);
		};
		const hoverSelect = (i: number) => {
			if (!hoverLocked) commit(i, false);
		};
		// スクロールでカーソルの下の要素が変わったときはカーソルの座標が変わらないので、座標で本当に動いたかを見る
		let pointer = { x: -1, y: -1 };
		toc.addEventListener("mousemove", (e) => {
			const moved = e.clientX !== pointer.x || e.clientY !== pointer.y;
			pointer = { x: e.clientX, y: e.clientY };
			if (!hoverLocked || !moved) return;
			hoverLocked = false;
			// ロック中に乗った項目は mouseenter が済んでいるので、ここで切り替える
			const target =
				e.target instanceof Element ? e.target.closest("[role=tab]") : null;
			const i = target ? tabs.indexOf(target as HTMLButtonElement) : -1;
			if (i !== -1 && i !== active) commit(i, false);
		});

		// ページのスクロールの途中でカーソルが目次に乗っただけなら、そのままページをスクロールする
		toc.addEventListener(
			"wheel",
			(e) => {
				const now = performance.now();
				if (now - lastPageWheel > PAGE_WHEEL_CONTINUE_MS) return;
				lastPageWheel = now;
				e.preventDefault();
				window.scrollBy({
					top: e.deltaY * (e.deltaMode === 1 ? 16 : 1),
					behavior: "instant",
				});
			},
			{ passive: false },
		);

		toc.addEventListener("keydown", (e) => {
			const next = {
				ArrowDown: active + 1,
				ArrowRight: active + 1,
				ArrowUp: active - 1,
				ArrowLeft: active - 1,
				Home: 0,
				End: entries.length - 1,
			}[e.key];
			if (next === undefined) return;
			e.preventDefault();
			commit(next);
			tabs[active].focus({ preventScroll: true });
		});

		// スマホのなぞるモード。長押しで始まり、指の下の項目に切り替えていく。
		// 長押しの前に指が動いたら、普通の目次のスクロールとして扱う
		let pressTimer: ReturnType<typeof setTimeout> | undefined;
		let scrubbing = false;
		let pressPoint = { x: 0, y: 0 };
		const scrubAt = (x: number, y: number) => {
			const tab = document
				.elementFromPoint(x, y)
				?.closest<HTMLButtonElement>("[role=tab]");
			const i = tab ? tabs.indexOf(tab) : -1;
			if (i !== -1 && i !== active) commit(i, false);
		};
		toc.addEventListener(
			"touchstart",
			(e) => {
				if (e.touches.length !== 1) return;
				pressPoint = { x: e.touches[0].clientX, y: e.touches[0].clientY };
				clearTimeout(pressTimer);
				pressTimer = setTimeout(() => {
					scrubbing = true;
					toc.classList.add("scrubbing");
					navigator.vibrate?.(10);
					scrubAt(pressPoint.x, pressPoint.y);
				}, 350);
			},
			{ passive: true },
		);
		toc.addEventListener(
			"touchmove",
			(e) => {
				const touch = e.touches[0];
				if (!scrubbing) {
					if (
						Math.hypot(
							touch.clientX - pressPoint.x,
							touch.clientY - pressPoint.y,
						) > 8
					)
						clearTimeout(pressTimer);
					return;
				}
				e.preventDefault();
				scrubAt(touch.clientX, touch.clientY);
			},
			{ passive: false },
		);
		const endScrub = (e: TouchEvent) => {
			clearTimeout(pressTimer);
			if (!scrubbing) return;
			scrubbing = false;
			toc.classList.remove("scrubbing");
			// 指を離したときのクリックで別の項目が選ばれないようにする
			e.preventDefault();
		};
		toc.addEventListener("touchend", endScrub);
		toc.addEventListener("touchcancel", endScrub);

		// 項目の高さを一番高い項目に揃える（埋め込みの読み込みで高さが変わるたびに更新）。
		// 縦に長い項目は高さを抑えて中でスクロールさせる
		const resize = () => {
			for (const entry of entries) limitIfTall(entry);
			const height = Math.max(...entries.map((entry) => entry.offsetHeight));
			wrap.style.setProperty("--digest-height", `${height}px`);
		};
		const observer = new ResizeObserver(resize);
		for (const entry of entries) observer.observe(entry);
		resize();
		commit(0);

		digestLists.set(panel, {
			entries,
			tabOf: (entry) => tabByEntry.get(entry),
			reorder: (order) => {
				const current = entries[active];
				entries.splice(0, entries.length, ...order);
				tabs.splice(
					0,
					tabs.length,
					...order.map((e) => tabByEntry.get(e) as HTMLButtonElement),
				);
				// 項目は重ねて表示しているので、DOM の順は変えなくてよい。動かすと中の iframe（プレーヤー・埋め込み）が
				// 読み込み直され、再生が止まったり目次の再生ボタン・再生バーと食い違ったりするので、目次だけを並べ替える
				tabs[0]?.parentElement?.append(...tabs);
				active = entries.indexOf(current);
				markSelected();
			},
		});
	}
}
