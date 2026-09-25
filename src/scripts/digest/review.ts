import { digestLists } from "./list";

/**
 * プレビューの記事（先頭に .digest-review-banner がある）で、目次から採用・不採用の切り替えと並べ替えをする。
 * - 目次の ✅ / ⛔ を押すと採用・不採用が切り替わる
 * - 目次の項目をドラッグすると並べ替わる（ページは読み込み直さない）
 * - 目次の 🖼 を押すと、その項目の画像が記事のサムネイルになる（selection.json の topicKey。記事の画像は公開用に書き出すときに変わる）
 * どちらも開発サーバーの API（scripts/daily-digest/dev-review.mjs）が selection.json に保存する。
 * 公開する記事にはバナーがないので何もしない
 */
export async function setupDigestReview() {
	const banner = document.querySelector<HTMLElement>(".digest-review-banner");
	if (!banner || banner.dataset.ready) return;
	banner.dataset.ready = "true";
	const date = banner.dataset.date ?? "";
	// 記事を書き出したあとに切り替え・並べ替えた分もあるので、保存済みの状態を読み直す（読めなければ記事の中の値）
	let saved: {
		adopt: Record<string, boolean>;
		order: string[];
		thumbnail?: string;
	} = { adopt: {}, order: [] };
	try {
		const res = await fetch(`/__digest/selection?date=${date}`);
		if (res.ok) saved = { adopt: {}, order: [], ...(await res.json()) };
	} catch {}
	// 記事のサムネイルに選んでいる項目と、その画像の表示
	const thumbPreview = document.createElement("figure");
	thumbPreview.className = "digest-review-thumb";
	banner.append(thumbPreview);
	const thumbBadges = new Map<string, HTMLElement>();
	const showThumbnail = (key: string) => {
		const entry = document.querySelector<HTMLElement>(
			`.digest-entry[data-key="${CSS.escape(key)}"]`,
		);
		const image = entry?.dataset.image;
		thumbPreview.innerHTML = "";
		if (image) {
			const img = document.createElement("img");
			img.className = "no-lightbox";
			img.src = image;
			img.alt = "";
			const caption = document.createElement("figcaption");
			caption.textContent = `サムネイル: ${entry?.dataset.label ?? key}`;
			thumbPreview.append(img, caption);
		} else {
			thumbPreview.textContent = "サムネイル: 未選択（目次の 🖼 で選べます）";
		}
		for (const [k, badge] of thumbBadges) {
			badge.classList.toggle("selected", k === key);
			badge.setAttribute("aria-pressed", String(k === key));
		}
	};
	const status = document.createElement("p");
	status.className = "digest-review-status";
	banner.append(status);
	const post = async (path: string, body: object) => {
		const res = await fetch(path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ date, ...body }),
		});
		if (!res.ok)
			throw new Error(
				(await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`,
			);
	};
	const fail = (what: string, e: unknown) => {
		status.textContent = `${what}を保存できませんでした（pnpm dev で開いていますか？）: ${e instanceof Error ? e.message : e}`;
	};

	for (const panel of document.querySelectorAll<HTMLElement>(
		".digest-items[data-limit]",
	)) {
		const list = digestLists.get(panel);
		const entries = list?.entries ?? [
			...panel.querySelectorAll<HTMLElement>(
				":scope > .digest-entry[data-key]",
			),
		];
		const keyOf = (entry: HTMLElement) => entry.dataset.key ?? "";
		// 保存済みの順に並べ直す
		if (list && saved.order.length) {
			const rank = new Map(saved.order.map((k, i) => [k, i]));
			const sorted = [...entries].sort(
				(a, b) => (rank.get(keyOf(a)) ?? 1e9) - (rank.get(keyOf(b)) ?? 1e9),
			);
			if (sorted.some((e, i) => e !== entries[i])) list.reorder(sorted);
		}
		const section = panel.closest("section");
		const limit = Number(panel.dataset.limit);
		const counter = document.createElement("span");
		counter.className = "digest-review-count";
		section?.querySelector(":scope > h2 .digest-count")?.after(counter);
		const updateCount = () => {
			const n = entries.filter((e) => e.dataset.adopt !== "false").length;
			counter.textContent = `採用 ${n} / 上限 ${limit}`;
			counter.classList.toggle("over", n > limit);
		};

		// ドラッグ中に目次の上端・下端へ近づけたら、目次をその方向へスクロールする
		const viewport = list ? list.tabOf(entries[0])?.parentElement : undefined;
		if (viewport) {
			let edge = 0;
			let frame = 0;
			const EDGE_PX = 48;
			const step = () => {
				if (!dragging || edge === 0) {
					frame = 0;
					return;
				}
				viewport.scrollTop += edge * 12;
				frame = requestAnimationFrame(step);
			};
			viewport.addEventListener("dragover", (e) => {
				if (!dragging || !entries.includes(dragging)) return;
				const r = viewport.getBoundingClientRect();
				edge =
					e.clientY < r.top + EDGE_PX
						? -1
						: e.clientY > r.bottom - EDGE_PX
							? 1
							: 0;
				if (edge !== 0 && !frame) frame = requestAnimationFrame(step);
			});
			const stop = () => {
				edge = 0;
			};
			viewport.addEventListener("dragleave", (e) => {
				if (!viewport.contains(e.relatedTarget as Node | null)) stop();
			});
			viewport.addEventListener("drop", stop);
			document.addEventListener("dragend", stop);
		}

		for (const entry of entries) {
			const tab = list?.tabOf(entry);
			const key = keyOf(entry);
			// 目次の ✅ / ⛔。押すと採用・不採用を切り替える（ボタンの中にボタンは置けないので span）
			const badge = document.createElement("span");
			badge.className = "digest-review-badge";
			badge.setAttribute("role", "button");
			badge.tabIndex = 0;
			tab?.append(badge);
			const apply = (adopt: boolean) => {
				entry.dataset.adopt = String(adopt);
				tab?.classList.toggle("digest-rejected", !adopt);
				badge.textContent = adopt ? "✅" : "⛔";
				badge.setAttribute(
					"aria-label",
					adopt ? "採用（押すと不採用）" : "不採用（押すと採用）",
				);
				updateCount();
			};
			apply(
				key in saved.adopt ? saved.adopt[key] : entry.dataset.adopt !== "false",
			);
			const onToggle = async (e: Event) => {
				e.stopPropagation();
				e.preventDefault();
				const adopt = entry.dataset.adopt === "false";
				try {
					await post("/__digest/adopt", { key, adopt });
					apply(adopt);
					status.textContent = `保存しました: ${entry.dataset.label ?? key} を${adopt ? "採用" : "不採用"}`;
				} catch (err) {
					fail("採用", err);
				}
			};
			badge.addEventListener("click", onToggle);
			badge.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") onToggle(e);
			});

			// 目次の 🖼。画像のある項目だけ、記事のサムネイルに選べる
			if (entry.dataset.image) {
				const thumb = document.createElement("span");
				thumb.className = "digest-review-thumb-badge";
				thumb.setAttribute("role", "button");
				thumb.tabIndex = 0;
				thumb.textContent = "🖼";
				thumb.setAttribute(
					"aria-label",
					"この項目の画像を記事のサムネイルにする",
				);
				thumb.title = "記事のサムネイルにする";
				tab?.append(thumb);
				thumbBadges.set(key, thumb);
				const onThumb = async (e: Event) => {
					e.stopPropagation();
					e.preventDefault();
					try {
						await post("/__digest/thumbnail", { key });
						showThumbnail(key);
						status.textContent = `保存しました: サムネイルを ${entry.dataset.label ?? key} に`;
					} catch (err) {
						fail("サムネイル", err);
					}
				};
				thumb.addEventListener("click", onThumb);
				thumb.addEventListener("keydown", (e) => {
					if (e.key === "Enter" || e.key === " ") onThumb(e);
				});
			}

			// 目次の項目のドラッグで並べ替える
			if (!tab || !list) continue;
			tab.draggable = true;
			// 再生バーを動かしている間はドラッグを止め、終わったら戻すための印
			tab.dataset.reorderable = "true";
			tab.addEventListener("dragstart", (e) => {
				dragging = entry;
				e.dataTransfer?.setData("text/plain", key);
				tab.classList.add("digest-dragging");
			});
			tab.addEventListener("dragend", () => {
				dragging = undefined;
				tab.classList.remove("digest-dragging");
				for (const e of entries)
					list
						.tabOf(e)
						?.classList.remove("digest-drop-before", "digest-drop-after");
			});
			// カーソルが項目の上半分なら前に、下半分なら後ろに入れる（offsetY は子要素の中の位置になるので使わない）
			const isAfter = (e: DragEvent) => {
				const r = tab.getBoundingClientRect();
				return e.clientY > r.top + r.height / 2;
			};
			tab.addEventListener("dragover", (e) => {
				if (!dragging || !entries.includes(dragging)) return;
				e.preventDefault();
				const after = isAfter(e);
				tab.classList.toggle("digest-drop-before", !after);
				tab.classList.toggle("digest-drop-after", after);
			});
			tab.addEventListener("dragleave", () =>
				tab.classList.remove("digest-drop-before", "digest-drop-after"),
			);
			tab.addEventListener("drop", async (e) => {
				const moving = dragging;
				if (!moving || !entries.includes(moving) || moving === entry) return;
				e.preventDefault();
				const after = isAfter(e);
				const next = entries.filter((x) => x !== moving);
				next.splice(next.indexOf(entry) + (after ? 1 : 0), 0, moving);
				list.reorder(next);
				try {
					await post("/__digest/order", { keys: next.map(keyOf) });
					status.textContent = `並べ替えを保存しました: ${moving.dataset.label ?? ""}`;
				} catch (err) {
					fail("並べ替え", err);
				}
			});
		}
	}
	showThumbnail(saved.thumbnail || banner.dataset.thumbKey || "");
}
let dragging: HTMLElement | undefined;
