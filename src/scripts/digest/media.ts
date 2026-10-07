// デイリーダイジェストの動画・曲（YouTube・SoundCloud）。サムネイルからプレーヤーへの差し替え、目次の再生ボタン・再生バー、共通の音量
import { getBarVideoContainer } from "./floating-player";

export const isMediaEntry = (entry: HTMLElement) =>
	entry.matches(".digest-entry-youtube, .digest-entry-soundcloud");

/** ファサードのアクティブ（再生中）状態を最新にする */
export function updateActiveMediaFacades() {
	for (const facade of document.querySelectorAll<HTMLAnchorElement>(
		"a.digest-youtube-facade",
	)) {
		const entryEl = facade.closest(".digest-entry") as HTMLElement | null;
		const player = media.players.find(
			(p) =>
				p.type === "youtube" && (p.entry === entryEl || p.entry === facade),
		);
		facade.classList.toggle("is-active-media", !!player);
		facade.classList.toggle("is-playing-media", !!player?.playing);
	}
}

/** 目次の再生ボタンの表示を、各プレーヤーの再生状態に合わせる */
export function updatePlayButtons() {
	for (const button of document.querySelectorAll<HTMLElement>(
		".digest-toc-play",
	)) {
		const entry = playButtonEntries.get(button);
		const playing =
			!!entry &&
			media.players.some(
				(p) => p.playing && (p.entry === entry || entry.contains(p.frame)),
			);
		button.textContent = playing ? "⏸" : "▶";
		button.setAttribute("aria-label", playing ? "停止" : "再生");
	}
	updateActiveMediaFacades();
	// 停止したときも、止まった位置で再生バーを表示しておく
	updateProgressBars();
}
export const playButtonEntries = new WeakMap<HTMLElement, HTMLElement>();

const formatTime = (seconds: number) => {
	const s = Math.max(0, Math.floor(seconds));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * 目次の再生バー。一度再生した項目にだけ出し、再生位置に合わせて伸ばす。
 * クリック・ドラッグで再生位置を動かせる（ドラッグ中は表示だけを動かし、離したところへ移動する）
 */
export function createProgressBar(entry: HTMLElement, tab: HTMLElement) {
	const bar = document.createElement("span");
	bar.className = "digest-toc-progress";
	bar.setAttribute("role", "slider");
	bar.setAttribute("aria-label", "再生位置");
	bar.tabIndex = -1;
	const fill = document.createElement("span");
	fill.className = "digest-toc-progress-fill";
	bar.append(fill);
	progressBars.set(bar, { entry, duration: 0, seeking: false });
	const state = progressBars.get(bar);
	if (!state) return bar;
	const ratioAt = (clientX: number) => {
		const r = bar.getBoundingClientRect();
		return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
	};
	const player = () =>
		media.players.find((p) => p.entry === entry || entry.contains(p.frame));
	bar.addEventListener("pointerdown", (e) => {
		e.stopPropagation();
		e.preventDefault();
		// 目次の項目はドラッグで並べ替えられるので、再生バーを動かしている間はそれを止める
		tab.draggable = false;
		state.seeking = true;
		bar.setPointerCapture(e.pointerId);
		fill.style.width = `${ratioAt(e.clientX) * 100}%`;
	});
	bar.addEventListener("pointermove", (e) => {
		if (!state.seeking) return;
		fill.style.width = `${ratioAt(e.clientX) * 100}%`;
		bar.title = formatTime(ratioAt(e.clientX) * state.duration);
	});
	const end = (e: PointerEvent) => {
		if (!state.seeking) return;
		state.seeking = false;
		tab.draggable = tab.dataset.reorderable === "true";
		const p = player();
		if (p && state.duration > 0) p.seek(ratioAt(e.clientX) * state.duration);
	};
	bar.addEventListener("pointerup", end);
	bar.addEventListener("pointercancel", () => {
		state.seeking = false;
		tab.draggable = tab.dataset.reorderable === "true";
	});
	// 目次の項目の選択（click）に伝わらないようにする
	bar.addEventListener("click", (e) => e.stopPropagation());
	return bar;
}
const progressBars = new WeakMap<
	HTMLElement,
	{ entry: HTMLElement; duration: number; seeking: boolean }
>();

/** 目次の再生バーを、各プレーヤーの再生位置に合わせる（再生中のものがある間だけ定期的に呼ぶ） */
async function updateProgressBars() {
	for (const bar of document.querySelectorAll<HTMLElement>(
		".digest-toc-progress",
	)) {
		const state = progressBars.get(bar);
		if (!state) continue;
		const player = media.players.find(
			(p) => p.entry === state.entry || state.entry.contains(p.frame),
		);
		bar.classList.toggle("visible", !!player?.started);
		if (!player?.started || state.seeking) continue;
		const { position, duration } = await player.progress();
		state.duration = duration;
		const fill = bar.firstElementChild as HTMLElement;
		fill.style.width = duration > 0 ? `${(position / duration) * 100}%` : "0%";
		bar.title = `${formatTime(position)} / ${formatTime(duration)}`;
		bar.setAttribute("aria-valuenow", String(Math.round(position)));
		bar.setAttribute("aria-valuemax", String(Math.round(duration)));
	}
}
setInterval(() => {
	if (media.players.some((p) => p.playing)) updateProgressBars();
}, 500);

/** 項目の動画・曲を再生・停止する。まだプレーヤーになっていなければ、読み込んで再生する */
export function togglePlay(entry: HTMLElement) {
	const player = media.players.find(
		(p) => p.entry === entry || entry.contains(p.frame),
	);
	if (player) {
		if (player.playing) {
			player.pause();
			player.playing = false;
			notifyMediaState(player);
		} else {
			pauseOthers(player.frame);
			player.playing = true;
			player.started = true;
			player.play();
			notifyMediaState(player);
		}
		updatePlayButtons();
		return;
	}
	// まだマウントされていない場合、他を停止してからマウント実行
	pauseOthers();
	const ytFacade = entry.querySelector<HTMLAnchorElement>(
		"a.digest-youtube-facade",
	);
	if (ytFacade) {
		mountYoutube(ytFacade);
		return;
	}
	const scFacade = entry.querySelector<HTMLAnchorElement>(
		"a.digest-soundcloud-facade",
	);
	if (scFacade) {
		mountSoundcloud(scFacade, true);
		return;
	}
}

// YouTube・SoundCloud は最初サムネイルだけを表示し、クリックでプレーヤーに差し替える。
// 1本再生したら他（YouTube と SoundCloud の両方）を一時停止する
export type MediaPlayer = {
	type: "youtube" | "soundcloud";
	entry: HTMLElement;
	frame: HTMLIFrameElement;
	playing: boolean;
	/** 一度でも再生したか（目次の再生バーを出すかどうか） */
	started: boolean;
	play: () => void;
	pause: () => void;
	setVolume: (volume: number) => void;
	/** 再生位置と長さ（秒） */
	progress: () => Promise<{ position: number; duration: number }>;
	seek: (seconds: number) => void;
};

export type MediaStateListener = (player: MediaPlayer) => void;
const mediaStateListeners: MediaStateListener[] = [];
export function onMediaStateChange(listener: MediaStateListener): () => void {
	mediaStateListeners.push(listener);
	return () => {
		const index = mediaStateListeners.indexOf(listener);
		if (index !== -1) mediaStateListeners.splice(index, 1);
	};
}
export function notifyMediaState(player: MediaPlayer): void {
	for (const cb of mediaStateListeners) {
		try {
			cb(player);
		} catch {}
	}
}

/** ページにあるすべての動画・曲のエントリを取得 */
export function getAllMediaEntries(): HTMLElement[] {
	return [
		...document.querySelectorAll<HTMLElement>(
			".digest-entry-youtube, .digest-entry-soundcloud",
		),
	];
}

/** ページにある動画・曲のプレーヤーと音量のスライダー。ページ遷移のたびに空にする（index.ts） */
export const media = {
	players: [] as MediaPlayer[],
	volumeInputs: [] as HTMLInputElement[],
};
export const pauseOthers = (frame?: HTMLIFrameElement) => {
	for (const other of media.players) {
		if (other.frame !== frame) {
			other.pause();
			if (other.playing) {
				other.playing = false;
				notifyMediaState(other);
			}
		}
	}
};

// 動画・曲の音量（0〜100）。SoundCloud のプレーヤーには音量の操作がないので、カルーセルの下に自前の
// スライダーを常に出し、YouTube と SoundCloud の全プレーヤーで共有してブラウザに覚えておく
const MEDIA_VOLUME_KEY = "digest-media-volume";

export function mediaVolume(): number {
	try {
		// 以前は SoundCloud だけの音量として保存していた
		const raw =
			localStorage.getItem(MEDIA_VOLUME_KEY) ??
			localStorage.getItem("digest-soundcloud-volume");
		const v = Number(raw);
		return raw !== null && Number.isFinite(v) ? v : 60;
	} catch {
		return 60;
	}
}

export function setMediaVolume(volume: number): void {
	try {
		localStorage.setItem(MEDIA_VOLUME_KEY, String(volume));
	} catch {}
	for (const p of media.players) p.setVolume(volume);
	for (const input of media.volumeInputs) input.value = String(volume);
}

/** 音量のスライダー。動画・曲のあるカルーセルの下に付ける */
export function createVolumeControl() {
	const label = document.createElement("label");
	label.className = "digest-volume";
	label.innerHTML =
		'<span aria-hidden="true">🔊</span><span class="sr-only">動画・曲の音量</span>';
	const input = document.createElement("input");
	input.type = "range";
	input.min = "0";
	input.max = "100";
	input.value = String(mediaVolume());
	input.addEventListener("input", () => setMediaVolume(Number(input.value)));
	media.volumeInputs.push(input);
	label.append(input);
	return label;
}
const youtubeApiCallbacks: (() => void)[] = [];

function withYouTubeApi(callback: () => void) {
	if (window.YT?.Player) return callback();
	youtubeApiCallbacks.push(callback);
	window.onYouTubeIframeAPIReady = () => {
		for (const cb of youtubeApiCallbacks.splice(0)) cb();
	};
	if (document.getElementById("youtube-iframe-api")) return;
	const script = document.createElement("script");
	script.id = "youtube-iframe-api";
	script.src = "https://www.youtube.com/iframe_api";
	document.body.appendChild(script);
}

/**
 * YouTube の動画を画面下部プレイヤーバーの動画枠（.bar-video-container）に小さく埋め込んで再生する
 */
export function mountYoutube(facade: HTMLAnchorElement) {
	if (!facade.isConnected) return;
	const entryEl = (facade.closest(".digest-entry") ?? facade) as HTMLElement;

	// 既存の YouTube プレーヤーがあれば停止してクリーンアップ
	const existingIndex = media.players.findIndex((p) => p.type === "youtube");
	if (existingIndex !== -1) {
		const existing = media.players[existingIndex];
		try {
			existing.pause();
		} catch {}
		media.players.splice(existingIndex, 1);
	}

	const container = getBarVideoContainer();
	container.innerHTML = "";

	const iframe = document.createElement("iframe");
	iframe.className = "digest-youtube digest-youtube-bar-frame";
	const origin = encodeURIComponent(location.origin);
	iframe.src = `https://www.youtube.com/embed/${facade.dataset.videoId}?enablejsapi=1&autoplay=1&origin=${origin}`;
	iframe.referrerPolicy = "strict-origin-when-cross-origin";
	iframe.title = facade.dataset.title ?? "";
	iframe.allow =
		"accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture";
	iframe.allowFullscreen = true;
	container.appendChild(iframe);

	// biome-ignore lint/suspicious/noExplicitAny: YouTube player instance
	let ytPlayerInstance: any = null;
	let ready = false;

	const entry: MediaPlayer = {
		type: "youtube",
		entry: entryEl,
		frame: iframe,
		playing: true, // クリックされたら再生開始とみなす
		started: true,
		play: () => {
			if (ready && ytPlayerInstance) {
				ytPlayerInstance.playVideo?.();
			}
		},
		pause: () => ytPlayerInstance?.pauseVideo?.(),
		setVolume: (v) => ytPlayerInstance?.setVolume?.(v),
		progress: async () => ({
			position: ytPlayerInstance?.getCurrentTime?.() ?? 0,
			duration: ytPlayerInstance?.getDuration?.() ?? 0,
		}),
		seek: (seconds) => ytPlayerInstance?.seekTo?.(seconds, true),
	};

	media.players.push(entry);
	pauseOthers(iframe);
	notifyMediaState(entry);
	updatePlayButtons();

	withYouTubeApi(() => {
		const YT = window.YT;
		if (!YT) return;
		const player = new YT.Player(iframe, {
			events: {
				onReady: () => {
					ready = true;
					ytPlayerInstance = player;
					player.setVolume?.(mediaVolume());
					player.playVideo?.();
				},
				onError: () => {
					// 埋め込み不可などの場合、ファサードに外部リンクを表示する
					entryEl.classList.add("has-embed-error");
				},
				onStateChange: (event) => {
					// 読み込み中（3: BUFFERING）も再生中として扱う
					entry.playing =
						event.data === YT.PlayerState.PLAYING || event.data === 3;
					if (entry.playing) entry.started = true;
					updatePlayButtons();
					notifyMediaState(entry);
					if (entry.playing) pauseOthers(iframe);
				},
			},
		});
		ytPlayerInstance = player;
	});
}

export function setupYoutube() {
	const facades = [
		...document.querySelectorAll<HTMLAnchorElement>("a.digest-youtube-facade"),
	].filter((a) => !a.dataset.ready);
	if (facades.length === 0) return;
	// 最初のクリックで待たないよう先に読み込んでおく
	withYouTubeApi(() => {});
	for (const facade of facades) {
		facade.dataset.ready = "true";
		facade.addEventListener("click", (e) => {
			e.preventDefault();
			const entryEl = (facade.closest(".digest-entry") ??
				facade) as HTMLElement;
			togglePlay(entryEl);
		});
	}
}

const soundcloudApiCallbacks: (() => void)[] = [];
let soundcloudApiLoaded = false;

function withSoundcloudApi(callback: () => void) {
	if (window.SC?.Widget) return callback();
	soundcloudApiCallbacks.push(callback);
	let script = document.getElementById(
		"soundcloud-widget-api",
	) as HTMLScriptElement | null;
	if (!script) {
		script = document.createElement("script");
		script.id = "soundcloud-widget-api";
		script.src = "https://w.soundcloud.com/player/api.js";
		script.onload = () => {
			soundcloudApiLoaded = true;
			for (const cb of soundcloudApiCallbacks.splice(0)) cb();
		};
		document.body.appendChild(script);
	} else if (soundcloudApiLoaded || window.SC?.Widget) {
		for (const cb of soundcloudApiCallbacks.splice(0)) cb();
	}
}

/**
 * アートワーク（ファサード）を SoundCloud のプレーヤーに差し替える（音量はカルーセルの下のスライダー）。
 * autoPlay はクリックで差し替えたとき（読み込みが済む前に押されたとき）だけ
 */
function mountSoundcloud(facade: HTMLAnchorElement, autoPlay: boolean) {
	if (!facade.isConnected) return;
	const player = document.createElement("div");
	player.className = "digest-soundcloud-player";
	const iframe = document.createElement("iframe");
	iframe.className = "digest-soundcloud";
	const track = encodeURIComponent(
		`https://api.soundcloud.com/tracks/${facade.dataset.trackId}`,
	);
	iframe.src = `https://w.soundcloud.com/player/?url=${track}&auto_play=${autoPlay}&visual=true&show_comments=false&show_reposts=false`;
	iframe.title = facade.dataset.title ?? "";
	iframe.allow = "autoplay; encrypted-media";
	player.append(iframe);
	facade.replaceWith(player);
	const entryEl = (player.closest(".digest-entry") ??
		facade.closest(".digest-entry") ??
		player) as HTMLElement;
	// biome-ignore lint/suspicious/noExplicitAny: SoundCloud widget instance
	let scWidgetInstance: any = null;
	let ready = false;
	let playWhenReady = autoPlay;
	const entry: MediaPlayer = {
		type: "soundcloud",
		entry: entryEl,
		frame: iframe,
		playing: autoPlay,
		started: autoPlay,
		progress: () =>
			new Promise((resolve) =>
				scWidgetInstance
					? scWidgetInstance.getPosition((pos: number) =>
							scWidgetInstance.getDuration((dur: number) =>
								resolve({ position: pos / 1000, duration: dur / 1000 }),
							),
						)
					: resolve({ position: 0, duration: 0 }),
			),
		seek: (seconds) => scWidgetInstance?.seekTo(seconds * 1000),
		play: () => {
			if (ready && scWidgetInstance) {
				scWidgetInstance.play();
			} else {
				playWhenReady = true;
				// もし ready が遅れている場合のフォールバック: iframe を auto_play=true でリロード
				if (!iframe.src.includes("auto_play=true")) {
					iframe.src = `https://w.soundcloud.com/player/?url=${track}&auto_play=true&visual=true&show_comments=false&show_reposts=false`;
				}
			}
		},
		pause: () => {
			playWhenReady = false;
			scWidgetInstance?.pause();
		},
		setVolume: (v) => scWidgetInstance?.setVolume(v),
	};
	media.players.push(entry);
	if (autoPlay) {
		pauseOthers(iframe);
		notifyMediaState(entry);
	}

	withSoundcloudApi(() => {
		const SC = window.SC;
		if (!SC) return;
		const widget = SC.Widget(iframe);
		scWidgetInstance = widget;

		const setPlaying = (playing: boolean) => {
			entry.playing = playing;
			if (playing) entry.started = true;
			updatePlayButtons();
			notifyMediaState(entry);
		};
		widget.bind(SC.Widget.Events.READY, () => {
			ready = true;
			widget.setVolume(mediaVolume());
			if (playWhenReady) {
				widget.play();
			}
		});
		widget.bind(SC.Widget.Events.PLAY, () => {
			setPlaying(true);
			pauseOthers(iframe);
		});
		widget.bind(SC.Widget.Events.PAUSE, () => setPlaying(false));
		widget.bind(SC.Widget.Events.FINISH, () => setPlaying(false));
	});
}

export function setupSoundcloud() {
	const facades = [
		...document.querySelectorAll<HTMLAnchorElement>(
			"a.digest-soundcloud-facade",
		),
	].filter((a) => !a.dataset.ready);
	if (facades.length === 0) return;
	withSoundcloudApi(() => {});
	for (const facade of facades) {
		facade.dataset.ready = "true";
		// クリックされたら他を停止して差し替えて再生する
		facade.addEventListener("click", (e) => {
			e.preventDefault();
			pauseOthers();
			mountSoundcloud(facade, true);
		});
	}
}
