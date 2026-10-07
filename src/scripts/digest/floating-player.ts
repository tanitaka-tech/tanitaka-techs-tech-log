import { digestLists } from "./list";
import {
	type MediaPlayer,
	getAllMediaEntries,
	mediaVolume,
	onMediaStateChange,
	setMediaVolume,
	togglePlay,
} from "./media";
import { isReviewMode, onAdoptChange, toggleAdopt } from "./review";

// 現在再生中のプレイヤー
let currentPlaying: MediaPlayer | null = null;
// ユーザーが手動でプレイヤーバーを一時的に隠したかどうか
let isUserDismissed = false;
// ユーザーが手動でPiP動画枠を閉じたかどうか
let isPipHiddenByUser = false;
// PiP枠が最小化（折りたたみ）されているかどうか
let isPipCollapsed = false;
// 前回の再生曲（曲が変わったら隠すフラグをリセットするため）
let lastMediaKey: string | null = null;

// DOM 要素
let playerBarEl: HTMLElement | null = null;
let pipWindowEl: HTMLElement | null = null;
let restoreBadgeEl: HTMLElement | null = null;
let progressUpdateTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribeMediaState: (() => void) | null = null;
let currentDuration = 0;
let isSeeking = false;

const PIP_STORAGE_KEY = "digest-pip-geometry";
const PIP_MIN_WIDTH = 260;
const PIP_MAX_WIDTH = 960;
const PIP_HEADER_HEIGHT = 36;

interface PipGeometry {
	left?: number;
	top?: number;
	width: number;
	height: number;
}

const formatTime = (seconds: number) => {
	const s = Math.max(0, Math.floor(seconds));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** 元の位置（記事内のエントリ）へジャンプする */
function jumpToOrigin(entry: HTMLElement) {
	if (!entry || !entry.isConnected) return;

	// カルーセル（.digest-items）内の項目の場合、そのタブを選択して表示させる
	const panel = entry.closest(".digest-items") as HTMLElement | null;
	if (panel) {
		const list = digestLists.get(panel);
		list?.select(entry);
	}

	// 画面中央へスムーズにスクロール
	entry.scrollIntoView({ behavior: "smooth", block: "center" });

	// 一瞬ピカッとハイライトして位置を知らせる
	entry.classList.remove("digest-entry-highlight");
	void entry.offsetWidth; // reflow
	entry.classList.add("digest-entry-highlight");
	setTimeout(() => {
		entry.classList.remove("digest-entry-highlight");
	}, 1600);
}

/** 前の曲・次の曲へスキップする */
function skipMedia(direction: 1 | -1) {
	const entries = getAllMediaEntries();
	if (entries.length === 0) return;

	const currentEntry = currentPlaying?.entry;
	const currentIndex = currentEntry ? entries.indexOf(currentEntry) : -1;
	const targetIndex =
		currentIndex === -1
			? 0
			: (currentIndex + direction + entries.length) % entries.length;
	const targetEntry = entries[targetIndex];
	if (!targetEntry) return;

	// 新しい曲になるので隠す状態をリセット
	isUserDismissed = false;
	isPipHiddenByUser = false;

	// カルーセル内の項目の場合はタブもアクティブにしておく
	const panel = targetEntry.closest(".digest-items") as HTMLElement | null;
	if (panel) {
		const list = digestLists.get(panel);
		list?.select(targetEntry);
	}

	togglePlay(targetEntry);
}

/** 一時的に隠す / 再表示の切り替え */
function setDismissed(dismissed: boolean) {
	isUserDismissed = dismissed;
	updatePlayerState();
}

/** PiP ウィンドウのジオメトリを保存 */
function savePipGeometry(pip: HTMLElement) {
	if (isPipCollapsed) return;
	const rect = pip.getBoundingClientRect();
	const geo: PipGeometry = {
		left: Math.round(rect.left),
		top: Math.round(rect.top),
		width: Math.round(rect.width),
		height: Math.round(rect.height),
	};
	try {
		localStorage.setItem(PIP_STORAGE_KEY, JSON.stringify(geo));
	} catch {}
}

/** 初期デフォルトの位置・サイズを適用 */
function applyDefaultPipGeometry(pip: HTMLElement) {
	const isMobile = window.innerWidth <= 640;
	const defaultWidth = isMobile ? Math.min(320, window.innerWidth - 24) : 380;
	const videoHeight = Math.round((defaultWidth * 9) / 16);
	const defaultHeight = videoHeight + PIP_HEADER_HEIGHT;

	pip.style.width = `${defaultWidth}px`;
	pip.style.height = `${defaultHeight}px`;

	// 初期位置: 画面右下、プレイヤーバー（高さ 68px = 4.25rem）の上
	const bottomMargin = isMobile ? 72 : 84;
	const rightMargin = isMobile ? 12 : 24;

	const left = Math.max(0, window.innerWidth - defaultWidth - rightMargin);
	const top = Math.max(0, window.innerHeight - defaultHeight - bottomMargin);

	pip.style.left = `${left}px`;
	pip.style.top = `${top}px`;
	pip.style.right = "auto";
	pip.style.bottom = "auto";
}

/** 保存された位置・サイズを復元 */
function restorePipGeometry(pip: HTMLElement) {
	try {
		const raw = localStorage.getItem(PIP_STORAGE_KEY);
		if (raw) {
			const geo = JSON.parse(raw) as PipGeometry;
			if (geo.width) {
				const maxW = Math.min(PIP_MAX_WIDTH, window.innerWidth - 20);
				const w = Math.max(PIP_MIN_WIDTH, Math.min(maxW, geo.width));
				const videoHeight = Math.round((w * 9) / 16);
				const h = videoHeight + PIP_HEADER_HEIGHT;
				pip.style.width = `${w}px`;
				pip.style.height = `${h}px`;

				if (typeof geo.left === "number" && typeof geo.top === "number") {
					const maxLeft = Math.max(0, window.innerWidth - w);
					const maxTop = Math.max(0, window.innerHeight - PIP_HEADER_HEIGHT);
					const left = Math.max(0, Math.min(maxLeft, geo.left));
					const top = Math.max(0, Math.min(maxTop, geo.top));
					pip.style.left = `${left}px`;
					pip.style.top = `${top}px`;
					pip.style.right = "auto";
					pip.style.bottom = "auto";
					return;
				}
			}
		}
	} catch {}
	applyDefaultPipGeometry(pip);
}

/** 初期位置・サイズにリセット */
function resetPipGeometry(pip: HTMLElement) {
	try {
		localStorage.removeItem(PIP_STORAGE_KEY);
	} catch {}
	isPipCollapsed = false;
	pip.classList.remove("is-collapsed");
	applyDefaultPipGeometry(pip);
	highlightPipWindow();
}

/** ダブルクリックで通常サイズ (380px) ↔ 大型サイズ (580px) をトグル */
function togglePipPresetSize(pip: HTMLElement) {
	if (isPipCollapsed) return;
	const currentWidth = pip.offsetWidth;
	const targetWidth =
		currentWidth > 460 ? 380 : Math.min(580, window.innerWidth - 30);
	const targetHeight = Math.round((targetWidth * 9) / 16) + PIP_HEADER_HEIGHT;

	const maxLeft = Math.max(0, window.innerWidth - targetWidth);
	const maxTop = Math.max(0, window.innerHeight - targetHeight);
	const rect = pip.getBoundingClientRect();
	const left = Math.max(0, Math.min(maxLeft, rect.left));
	const top = Math.max(0, Math.min(maxTop, rect.top));

	pip.style.width = `${targetWidth}px`;
	pip.style.height = `${targetHeight}px`;
	pip.style.left = `${left}px`;
	pip.style.top = `${top}px`;
	savePipGeometry(pip);
}

/** PiP ウィンドウを一瞬ハイライト（視線誘導） */
function highlightPipWindow() {
	if (!pipWindowEl) return;
	pipWindowEl.classList.remove("pip-highlight");
	void pipWindowEl.offsetWidth;
	pipWindowEl.classList.add("pip-highlight");
	setTimeout(() => {
		pipWindowEl?.classList.remove("pip-highlight");
	}, 1200);
}

/** プレビュー表示用: プレイヤーバーと PiP 窓の採用・不採用ボタンの状態更新 */
function updateAdoptButtons(entry?: HTMLElement) {
	const current = entry ?? currentPlaying?.entry;
	if (!current) return;

	const review = isReviewMode();
	const isAdopted = current.dataset.adopt !== "false";

	// プレイヤーバー側のボタン
	const barAdoptBtn =
		playerBarEl?.querySelector<HTMLButtonElement>(".bar-adopt-btn");
	if (barAdoptBtn) {
		barAdoptBtn.classList.toggle("hidden", !review);
		barAdoptBtn.classList.toggle("is-adopted", isAdopted);
		barAdoptBtn.classList.toggle("is-rejected", !isAdopted);
		const icon = barAdoptBtn.querySelector(".adopt-icon");
		const label = barAdoptBtn.querySelector(".adopt-label");
		if (icon) icon.textContent = isAdopted ? "✅" : "⛔";
		if (label) label.textContent = isAdopted ? "採用" : "不採用";
		barAdoptBtn.title = isAdopted
			? "採用中（クリックまたは 'A' キーで不採用）"
			: "不採用（クリックまたは 'A' キーで採用）";
	}

	// PiP ウィンドウ側のボタン
	const pipAdoptBtn =
		pipWindowEl?.querySelector<HTMLButtonElement>(".pip-adopt-btn");
	if (pipAdoptBtn) {
		pipAdoptBtn.classList.toggle("hidden", !review);
		pipAdoptBtn.classList.toggle("is-adopted", isAdopted);
		pipAdoptBtn.classList.toggle("is-rejected", !isAdopted);
		pipAdoptBtn.textContent = isAdopted ? "✅" : "⛔";
		pipAdoptBtn.title = isAdopted
			? "採用中（クリックまたは 'A' キーで不採用）"
			: "不採用（クリックまたは 'A' キーで採用）";
	}
}

/** ドラッグ移動のイベント登録 */
function initPipDraggable(pip: HTMLElement, handle: HTMLElement) {
	let isDragging = false;
	let startPointerX = 0;
	let startPointerY = 0;
	let startLeft = 0;
	let startTop = 0;
	const shield = pip.querySelector<HTMLElement>(".pip-drag-shield");

	handle.addEventListener("pointerdown", (e) => {
		if ((e.target as HTMLElement).closest(".pip-actions")) return;
		e.preventDefault();
		isDragging = true;
		handle.setPointerCapture(e.pointerId);

		const rect = pip.getBoundingClientRect();
		startPointerX = e.clientX;
		startPointerY = e.clientY;
		startLeft = rect.left;
		startTop = rect.top;

		if (shield) shield.style.display = "block";
		pip.classList.add("is-dragging");
	});

	handle.addEventListener("pointermove", (e) => {
		if (!isDragging) return;
		const deltaX = e.clientX - startPointerX;
		const deltaY = e.clientY - startPointerY;

		let newLeft = startLeft + deltaX;
		let newTop = startTop + deltaY;

		// 画面内にクランプ（ヘッダーが見失われないように）
		const maxLeft = Math.max(0, window.innerWidth - pip.offsetWidth);
		const maxTop = Math.max(0, window.innerHeight - PIP_HEADER_HEIGHT);
		newLeft = Math.max(0, Math.min(maxLeft, newLeft));
		newTop = Math.max(0, Math.min(maxTop, newTop));

		pip.style.left = `${newLeft}px`;
		pip.style.top = `${newTop}px`;
		pip.style.right = "auto";
		pip.style.bottom = "auto";
	});

	const onEnd = () => {
		if (!isDragging) return;
		isDragging = false;
		if (shield) shield.style.display = "none";
		pip.classList.remove("is-dragging");
		savePipGeometry(pip);
	};

	handle.addEventListener("pointerup", onEnd);
	handle.addEventListener("pointercancel", onEnd);

	// ダブルクリックでサイズトグル
	handle.addEventListener("dblclick", (e) => {
		if ((e.target as HTMLElement).closest(".pip-actions")) return;
		togglePipPresetSize(pip);
	});
}

/** 四隅のリサイズイベント登録 */
function initPipResizable(pip: HTMLElement) {
	const resizers = pip.querySelectorAll<HTMLElement>(".pip-resizer");
	const shield = pip.querySelector<HTMLElement>(".pip-drag-shield");

	for (const resizer of resizers) {
		const dir = resizer.dataset.dir;
		if (!dir) continue;

		let isResizing = false;
		let startPointerX = 0;
		let startRight = 0;
		let startBottom = 0;
		let startWidth = 0;

		resizer.addEventListener("pointerdown", (e) => {
			if (isPipCollapsed) return;
			e.preventDefault();
			e.stopPropagation();
			isResizing = true;
			resizer.setPointerCapture(e.pointerId);

			const rect = pip.getBoundingClientRect();
			startPointerX = e.clientX;
			startRight = rect.right;
			startBottom = rect.bottom;
			startWidth = rect.width;

			if (shield) shield.style.display = "block";
			pip.classList.add("is-resizing");
		});

		resizer.addEventListener("pointermove", (e) => {
			if (!isResizing) return;
			const deltaX = e.clientX - startPointerX;
			const maxW = Math.min(PIP_MAX_WIDTH, window.innerWidth - 20);

			let newWidth = startWidth;

			if (dir === "se" || dir === "ne") {
				newWidth = Math.max(PIP_MIN_WIDTH, Math.min(maxW, startWidth + deltaX));
			} else if (dir === "sw" || dir === "nw") {
				newWidth = Math.max(PIP_MIN_WIDTH, Math.min(maxW, startWidth - deltaX));
			}

			const videoHeight = Math.round((newWidth * 9) / 16);
			const newHeight = videoHeight + PIP_HEADER_HEIGHT;

			// 位置の更新（左側や上側を移動させる）
			if (dir === "sw" || dir === "nw") {
				const newLeft = Math.max(0, startRight - newWidth);
				pip.style.left = `${newLeft}px`;
			}
			if (dir === "ne" || dir === "nw") {
				const newTop = Math.max(0, startBottom - newHeight);
				pip.style.top = `${newTop}px`;
			}

			pip.style.width = `${newWidth}px`;
			pip.style.height = `${newHeight}px`;
			pip.style.right = "auto";
			pip.style.bottom = "auto";
		});

		const onEnd = () => {
			if (!isResizing) return;
			isResizing = false;
			if (shield) shield.style.display = "none";
			pip.classList.remove("is-resizing");
			savePipGeometry(pip);
		};

		resizer.addEventListener("pointerup", onEnd);
		resizer.addEventListener("pointercancel", onEnd);
	}
}

/** 自由移動・リサイズ可能な Picture-in-Picture ウィンドウ */
function ensurePipWindow(): HTMLElement {
	if (pipWindowEl?.isConnected) return pipWindowEl;

	const pip = document.createElement("div");
	pip.id = "digest-pip-window";
	pip.className = "digest-pip-window hidden";
	pip.innerHTML = `
		<div class="pip-header">
			<div class="pip-drag-handle" title="ドラッグして移動 / ダブルクリックで拡大縮小">
				<span class="pip-grip" aria-hidden="true">⋮⋮</span>
				<span class="pip-title">YouTube</span>
			</div>
			<div class="pip-actions">
				<!-- プレビュー表示用: 採用・不採用切り替えボタン -->
				<button type="button" class="pip-btn pip-adopt-btn hidden" title="採用・不採用を切り替え" aria-label="採用フラグ切り替え">✅</button>
				<button type="button" class="pip-btn pip-reset-btn" title="初期位置・サイズに戻す" aria-label="リセット">↺</button>
				<button type="button" class="pip-btn pip-collapse-btn" title="最小化 / 展開" aria-label="最小化">🗕</button>
				<button type="button" class="pip-btn pip-close-btn" title="枠を閉じる（バーで音声のみ再生）" aria-label="閉じる">✕</button>
			</div>
		</div>
		<div class="pip-body">
			<div class="pip-video-container bar-video-container"></div>
			<div class="pip-drag-shield" aria-hidden="true"></div>
		</div>
		<!-- 四隅のリサイズハンドル -->
		<div class="pip-resizer pip-resizer-se" data-dir="se" title="ドラッグでサイズ変更"></div>
		<div class="pip-resizer pip-resizer-sw" data-dir="sw" title="ドラッグでサイズ変更"></div>
		<div class="pip-resizer pip-resizer-ne" data-dir="ne" title="ドラッグでサイズ変更"></div>
		<div class="pip-resizer pip-resizer-nw" data-dir="nw" title="ドラッグでサイズ変更"></div>
	`;

	const dragHandle = pip.querySelector<HTMLElement>(".pip-drag-handle");
	if (dragHandle) initPipDraggable(pip, dragHandle);
	initPipResizable(pip);

	// 採用切り替えボタン
	pip.querySelector(".pip-adopt-btn")?.addEventListener("click", async (e) => {
		e.stopPropagation();
		if (currentPlaying) {
			await toggleAdopt(currentPlaying.entry);
			updateAdoptButtons(currentPlaying.entry);
		}
	});

	// ボタンアクション
	pip.querySelector(".pip-reset-btn")?.addEventListener("click", (e) => {
		e.stopPropagation();
		resetPipGeometry(pip);
	});

	const collapseBtn = pip.querySelector<HTMLButtonElement>(".pip-collapse-btn");
	collapseBtn?.addEventListener("click", (e) => {
		e.stopPropagation();
		isPipCollapsed = !isPipCollapsed;
		pip.classList.toggle("is-collapsed", isPipCollapsed);
		if (collapseBtn) {
			collapseBtn.textContent = isPipCollapsed ? "🗖" : "🗕";
			collapseBtn.title = isPipCollapsed ? "展開" : "最小化";
		}
		if (!isPipCollapsed) {
			restorePipGeometry(pip);
		}
	});

	pip.querySelector(".pip-close-btn")?.addEventListener("click", (e) => {
		e.stopPropagation();
		isPipHiddenByUser = true;
		pip.classList.add("hidden");
	});

	// タイトルクリックで記事内の元の場所へジャンプ
	pip.querySelector(".pip-title")?.addEventListener("click", (e) => {
		e.stopPropagation();
		if (currentPlaying) jumpToOrigin(currentPlaying.entry);
	});

	document.body.appendChild(pip);
	restorePipGeometry(pip);
	pipWindowEl = pip;

	// 画面リサイズ時に画面外に出ていたら画面内に収める
	window.addEventListener("resize", () => {
		if (!pipWindowEl || pipWindowEl.classList.contains("hidden")) return;
		const rect = pipWindowEl.getBoundingClientRect();
		const maxLeft = Math.max(0, window.innerWidth - rect.width);
		const maxTop = Math.max(0, window.innerHeight - PIP_HEADER_HEIGHT);
		if (rect.left > maxLeft) pipWindowEl.style.left = `${maxLeft}px`;
		if (rect.top > maxTop) pipWindowEl.style.top = `${maxTop}px`;
	});

	return pip;
}

/** 動画スロット要素を取得（PiP ウィンドウ内のコンテナ） */
export function getBarVideoContainer(): HTMLElement {
	const pip = ensurePipWindow();
	const container = pip.querySelector<HTMLElement>(".bar-video-container");
	if (!container) throw new Error("bar-video-container not found");
	return container;
}

/** 再表示ミニバッジの生成と更新 */
function ensureRestoreBadge(): HTMLElement {
	if (restoreBadgeEl?.isConnected) return restoreBadgeEl;

	const badge = document.createElement("button");
	badge.type = "button";
	badge.className = "digest-restore-badge hidden";
	badge.setAttribute("aria-label", "再生プレイヤーを再表示");
	badge.innerHTML = `
		<span class="badge-pulse" aria-hidden="true"></span>
		<span class="badge-label">再生中 ↗</span>
	`;
	badge.addEventListener("click", () => {
		setDismissed(false);
		isPipHiddenByUser = false;
	});

	document.body.appendChild(badge);
	restoreBadgeEl = badge;
	return badge;
}

function updateRestoreBadge() {
	const badge = ensureRestoreBadge();
	const hasActiveMedia = !!(
		currentPlaying &&
		(currentPlaying.playing || currentPlaying.started)
	);
	const shouldShow = hasActiveMedia && isUserDismissed;

	badge.classList.toggle("hidden", !shouldShow);
	if (shouldShow && currentPlaying) {
		const labelEl = badge.querySelector(".badge-label");
		const title = currentPlaying.entry.dataset.label ?? "再生中";
		if (labelEl) {
			labelEl.textContent = `🎵 ${title.length > 18 ? `${title.slice(0, 18)}…` : title} ↗`;
		}
	}
}

/** 画面下部共通プレイヤーバー（YouTube・SoundCloud 共通） */
function ensurePlayerBar(): HTMLElement {
	if (playerBarEl?.isConnected) return playerBarEl;

	const bar = document.createElement("div");
	bar.id = "digest-player-bar";
	bar.className = "digest-player-bar digest-audio-bar hidden-bar";
	bar.innerHTML = `
		<div class="bar-info">
			<!-- アートワークサムネイル（クリックで元の場所へ移動＆PiP再表示） -->
			<div class="bar-thumb-wrapper" role="button" tabindex="0" title="元の場所へジャンプ / 動画枠を表示">
				<img class="bar-thumb no-lightbox" src="" alt="">
				<span class="bar-type-badge"></span>
			</div>
			<div class="bar-text">
				<div class="bar-title" role="button" tabindex="0" title="元の場所へジャンプ"></div>
				<div class="bar-artist"></div>
			</div>
		</div>
		<div class="bar-center">
			<div class="bar-buttons">
				<button type="button" class="bar-btn bar-btn-prev" title="前の動画・曲" aria-label="前の曲">⏮</button>
				<button type="button" class="bar-btn bar-btn-play" title="再生・一時停止" aria-label="再生・一時停止">▶</button>
				<button type="button" class="bar-btn bar-btn-next" title="次の動画・曲" aria-label="次の曲">⏭</button>
			</div>
			<div class="bar-progress-row">
				<span class="bar-time-curr">0:00</span>
				<div class="bar-progress-slider" role="slider" aria-label="再生位置" tabindex="0">
					<div class="bar-progress-fill"></div>
				</div>
				<span class="bar-time-total">0:00</span>
			</div>
		</div>
		<div class="bar-right">
			<!-- プレビュー表示用: 採用フラグ切り替えボタン -->
			<button type="button" class="bar-adopt-btn hidden" title="採用・不採用を切り替え" aria-label="採用フラグ切り替え">
				<span class="adopt-icon">✅</span>
				<span class="adopt-label">採用</span>
			</button>
			<label class="bar-volume" title="音量">
				<span aria-hidden="true">🔊</span>
				<input type="range" min="0" max="100" value="${mediaVolume()}">
			</label>
			<button type="button" class="bar-action-btn bar-jump-btn" title="記事内の元の場所へ移動">
				<span>↖ 元の場所</span>
			</button>
			<button type="button" class="bar-close-btn" title="プレイヤーを一時的に隠す" aria-label="隠す">✕</button>
		</div>
	`;

	// イベント設定
	const onJump = (e: Event) => {
		e.stopPropagation();
		if (currentPlaying) {
			jumpToOrigin(currentPlaying.entry);
			if (currentPlaying.type === "youtube") {
				isPipHiddenByUser = false;
				pipWindowEl?.classList.remove("hidden");
				highlightPipWindow();
			}
		}
	};
	bar.querySelector(".bar-title")?.addEventListener("click", onJump);
	bar.querySelector(".bar-jump-btn")?.addEventListener("click", onJump);
	bar.querySelector(".bar-thumb-wrapper")?.addEventListener("click", onJump);

	// 採用切り替えボタン
	bar.querySelector(".bar-adopt-btn")?.addEventListener("click", async (e) => {
		e.stopPropagation();
		if (currentPlaying) {
			await toggleAdopt(currentPlaying.entry);
			updateAdoptButtons(currentPlaying.entry);
		}
	});

	bar.querySelector(".bar-close-btn")?.addEventListener("click", (e) => {
		e.stopPropagation();
		setDismissed(true);
	});
	bar.querySelector(".bar-btn-prev")?.addEventListener("click", (e) => {
		e.stopPropagation();
		skipMedia(-1);
	});
	bar.querySelector(".bar-btn-next")?.addEventListener("click", (e) => {
		e.stopPropagation();
		skipMedia(1);
	});
	bar.querySelector(".bar-btn-play")?.addEventListener("click", (e) => {
		e.stopPropagation();
		if (!currentPlaying) return;
		togglePlay(currentPlaying.entry);
	});

	// 音量スライダー
	const volInput = bar.querySelector<HTMLInputElement>(".bar-volume input");
	volInput?.addEventListener("input", () => {
		setMediaVolume(Number(volInput.value));
	});

	// シークバー操作
	const slider = bar.querySelector<HTMLElement>(".bar-progress-slider");
	const seekAt = (clientX: number) => {
		if (!slider || !currentPlaying || currentDuration <= 0) return;
		const rect = slider.getBoundingClientRect();
		const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
		const targetSec = ratio * currentDuration;
		currentPlaying.seek(targetSec);
		const fill = bar.querySelector<HTMLElement>(".bar-progress-fill");
		const curr = bar.querySelector<HTMLElement>(".bar-time-curr");
		if (fill) fill.style.width = `${ratio * 100}%`;
		if (curr) curr.textContent = formatTime(targetSec);
	};

	slider?.addEventListener("pointerdown", (e) => {
		isSeeking = true;
		slider.setPointerCapture(e.pointerId);
		seekAt(e.clientX);
	});
	slider?.addEventListener("pointermove", (e) => {
		if (isSeeking) seekAt(e.clientX);
	});
	slider?.addEventListener("pointerup", (e) => {
		if (isSeeking) {
			seekAt(e.clientX);
			isSeeking = false;
		}
	});
	slider?.addEventListener("pointercancel", () => {
		isSeeking = false;
	});

	document.body.appendChild(bar);
	playerBarEl = bar;
	return bar;
}

/** プレイヤーバーのコンテンツ更新 */
function updatePlayerBar(player: MediaPlayer) {
	const bar = ensurePlayerBar();
	const entry = player.entry;

	// サムネイル画像
	const thumbImg = bar.querySelector<HTMLImageElement>(".bar-thumb");
	if (thumbImg) {
		const src =
			entry.dataset.thumb ??
			entry.dataset.image ??
			entry.querySelector("img")?.src ??
			"";
		thumbImg.src = src;
		thumbImg.alt = entry.dataset.label ?? "";
	}

	// 種別バッジ
	const typeBadge = bar.querySelector<HTMLElement>(".bar-type-badge");
	if (typeBadge) {
		if (player.type === "youtube") {
			typeBadge.textContent = "YouTube";
			typeBadge.className = "bar-type-badge type-youtube";
		} else {
			typeBadge.textContent = "SoundCloud";
			typeBadge.className = "bar-type-badge type-soundcloud";
		}
	}

	// タイトル
	const titleEl = bar.querySelector<HTMLElement>(".bar-title");
	if (titleEl) {
		titleEl.textContent = entry.dataset.label ?? "無題";
	}

	// 投稿者 / チャンネル名
	const artistEl = bar.querySelector<HTMLElement>(".bar-artist");
	if (artistEl) {
		artistEl.textContent = entry.dataset.meta ?? "";
	}

	// 再生・一時停止ボタン
	const playBtn = bar.querySelector<HTMLElement>(".bar-btn-play");
	if (playBtn) {
		playBtn.textContent = player.playing ? "⏸" : "▶";
		playBtn.setAttribute("aria-label", player.playing ? "一時停止" : "再生");
		playBtn.title = player.playing ? "一時停止" : "再生";
	}

	// 音量
	const volInput = bar.querySelector<HTMLInputElement>(".bar-volume input");
	if (volInput) {
		volInput.value = String(mediaVolume());
	}
}

/** プログレスバーの定時更新 */
function startProgressTimer() {
	if (progressUpdateTimer) return;
	progressUpdateTimer = setInterval(async () => {
		if (!currentPlaying?.playing || isSeeking) return;

		try {
			const { position, duration } = await currentPlaying.progress();
			currentDuration = duration;
			if (!playerBarEl || playerBarEl.classList.contains("hidden-bar")) return;

			const fill = playerBarEl.querySelector<HTMLElement>(".bar-progress-fill");
			const curr = playerBarEl.querySelector<HTMLElement>(".bar-time-curr");
			const total = playerBarEl.querySelector<HTMLElement>(".bar-time-total");

			if (fill && duration > 0) {
				fill.style.width = `${Math.min(100, Math.max(0, (position / duration) * 100))}%`;
			}
			if (curr) curr.textContent = formatTime(position);
			if (total && duration > 0) total.textContent = formatTime(duration);
		} catch {}
	}, 400);
}

function stopProgressTimer() {
	if (progressUpdateTimer) {
		clearInterval(progressUpdateTimer);
		progressUpdateTimer = null;
	}
}

/** 再生状態に応じたプレイヤーバーおよび PiP ウィンドウの制御 */
function updatePlayerState() {
	if (!currentPlaying || (!currentPlaying.playing && !currentPlaying.started)) {
		playerBarEl?.classList.add("hidden-bar");
		pipWindowEl?.classList.add("hidden");
		document.body.classList.remove("has-digest-player-bar");
		updateRestoreBadge();
		stopProgressTimer();
		return;
	}

	updatePlayerBar(currentPlaying);

	// プレイヤーバーの表示制御
	const shouldShowBar = !isUserDismissed;
	playerBarEl?.classList.toggle("hidden-bar", !shouldShowBar);
	document.body.classList.toggle("has-digest-player-bar", shouldShowBar);

	// PiP 動画ウィンドウの表示制御
	const pip = ensurePipWindow();
	const shouldShowPip =
		currentPlaying.type === "youtube" && !isUserDismissed && !isPipHiddenByUser;
	pip.classList.toggle("hidden", !shouldShowPip);

	if (shouldShowPip) {
		const pipTitle = pip.querySelector<HTMLElement>(".pip-title");
		if (pipTitle) {
			const title = currentPlaying.entry.dataset.label ?? "YouTube";
			pipTitle.textContent = title;
			pipTitle.title = title;
		}
	}

	if (currentPlaying.playing) {
		startProgressTimer();
	} else {
		stopProgressTimer();
	}

	updateAdoptButtons(currentPlaying.entry);
	updateRestoreBadge();
}

let keydownListener: ((e: KeyboardEvent) => void) | null = null;
let unsubscribeAdopt: (() => void) | null = null;

/** 初期化とリスナー登録 */
export function setupFloatingPlayer(): void {
	// クリーンアップ
	stopProgressTimer();
	playerBarEl?.remove();
	playerBarEl = null;
	pipWindowEl?.remove();
	pipWindowEl = null;
	restoreBadgeEl?.remove();
	restoreBadgeEl = null;
	currentPlaying = null;
	isUserDismissed = false;
	isPipHiddenByUser = false;
	isPipCollapsed = false;
	lastMediaKey = null;
	document.body.classList.remove("has-digest-player-bar");

	if (keydownListener) {
		window.removeEventListener("keydown", keydownListener);
		keydownListener = null;
	}
	unsubscribeAdopt?.();

	// アニメーションの Containing Block を一掃
	for (const el of document.querySelectorAll<HTMLElement>(
		".onload-animation",
	)) {
		el.style.transform = "none";
		el.style.animation = "none";
		el.style.opacity = "1";
	}

	// 採用状態変更リスナー
	unsubscribeAdopt = onAdoptChange((entry) => {
		if (currentPlaying?.entry === entry) {
			updateAdoptButtons(entry);
		}
	});

	// ショートカットキー 'A': 再生中の動画・曲の採用・不採用をトグル
	keydownListener = (e: KeyboardEvent) => {
		const active = document.activeElement;
		if (
			active &&
			(active.tagName === "INPUT" ||
				active.tagName === "TEXTAREA" ||
				active.tagName === "SELECT" ||
				active.getAttribute("contenteditable") === "true")
		) {
			return;
		}

		if (
			(e.key === "a" || e.key === "A") &&
			!e.ctrlKey &&
			!e.metaKey &&
			!e.altKey
		) {
			const entry = currentPlaying?.entry;
			if (entry && isReviewMode()) {
				e.preventDefault();
				void toggleAdopt(entry).then(() => {
					updateAdoptButtons(entry);
				});
			}
		}
	};
	window.addEventListener("keydown", keydownListener);

	// メディア状態変更リスナー
	unsubscribeMediaState?.();
	unsubscribeMediaState = onMediaStateChange((player) => {
		if (!player.playing && currentPlaying && currentPlaying !== player) {
			return;
		}

		const mediaKey = player.entry.dataset.key ?? player.entry.dataset.url ?? "";

		// 曲・動画が変わったら手動非表示をリセットして常に表示
		if (mediaKey !== lastMediaKey) {
			lastMediaKey = mediaKey;
			isUserDismissed = false;
			isPipHiddenByUser = false;
		}

		currentPlaying = player;
		updatePlayerState();
	});
}
