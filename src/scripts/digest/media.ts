// デイリーダイジェストの動画・曲（YouTube・SoundCloud）。サムネイルからプレーヤーへの差し替え、目次の再生ボタン・再生バー、共通の音量

export const isMediaEntry = (entry: HTMLElement) =>
	entry.matches(".digest-entry-youtube, .digest-entry-soundcloud");

/** 目次の再生ボタンの表示を、各プレーヤーの再生状態に合わせる */
export function updatePlayButtons() {
	for (const button of document.querySelectorAll<HTMLElement>(
		".digest-toc-play",
	)) {
		const entry = playButtonEntries.get(button);
		const playing =
			!!entry &&
			media.players.some((p) => p.playing && entry.contains(p.frame));
		button.textContent = playing ? "⏸" : "▶";
		button.setAttribute("aria-label", playing ? "停止" : "再生");
	}
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
	const player = () => media.players.find((p) => entry.contains(p.frame));
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
		const player = media.players.find((p) => state.entry.contains(p.frame));
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

/** 項目の動画・曲を再生・停止する。まだプレーヤーになっていなければ、サムネイルを押したのと同じく読み込んで再生する */
export function togglePlay(entry: HTMLElement) {
	const player = media.players.find((p) => entry.contains(p.frame));
	if (player) {
		if (player.playing) player.pause();
		else {
			pauseOthers(player.frame);
			player.play();
		}
		return;
	}
	entry
		.querySelector<HTMLElement>(
			".digest-youtube-facade, .digest-soundcloud-facade",
		)
		?.click();
}

// YouTube・SoundCloud は最初サムネイルだけを表示し、クリックでプレーヤーに差し替える。
// 1本再生したら他（YouTube と SoundCloud の両方）を一時停止する
export type MediaPlayer = {
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
/** ページにある動画・曲のプレーヤーと音量のスライダー。ページ遷移のたびに空にする（index.ts） */
export const media = {
	players: [] as MediaPlayer[],
	volumeInputs: [] as HTMLInputElement[],
};
export const pauseOthers = (frame?: HTMLIFrameElement) => {
	for (const other of media.players) if (other.frame !== frame) other.pause();
};

// 動画・曲の音量（0〜100）。SoundCloud のプレーヤーには音量の操作がないので、カルーセルの下に自前の
// スライダーを常に出し、YouTube と SoundCloud の全プレーヤーで共有してブラウザに覚えておく
const MEDIA_VOLUME_KEY = "digest-media-volume";

function mediaVolume() {
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

function setMediaVolume(volume: number) {
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
 * プレーヤーの下に「読み込み直す」「YouTube で開く」を付ける（最初は隠しておく）。
 * YouTube が bot の確認（ログインを求める画面）を出したとき、別のタブでログインしてから読み込み直せるように。
 * 確認の画面はプレーヤーではないので、プレーヤーの準備完了（onReady）が来ない・エラーになったときだけ出す
 */
function youtubePlayer(
	iframe: HTMLIFrameElement,
	url: string,
	onReload: () => void,
) {
	const player = document.createElement("div");
	player.className = "digest-youtube-player";
	const help = document.createElement("div");
	help.className = "digest-youtube-help";
	help.hidden = true;
	const reload = document.createElement("button");
	reload.type = "button";
	reload.textContent = "読み込み直す";
	reload.addEventListener("click", onReload);
	const open = document.createElement("a");
	open.href = url;
	open.target = "_blank";
	open.rel = "noopener";
	open.textContent = "YouTube で開く";
	help.append("再生できないとき: ", reload, open);
	player.append(iframe, help);
	return player;
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
			const iframe = document.createElement("iframe");
			iframe.className = "digest-youtube";
			// youtube-nocookie.com はログインの Cookie を使わないので、「bot ではないことを確認」でログインしても
			// 解除されない。www.youtube.com を使い、YouTube が確認に使う Referer と origin も渡す
			const origin = encodeURIComponent(location.origin);
			iframe.src = `https://www.youtube.com/embed/${facade.dataset.videoId}?enablejsapi=1&autoplay=1&origin=${origin}`;
			iframe.referrerPolicy = "strict-origin-when-cross-origin";
			iframe.title = facade.dataset.title ?? "";
			iframe.allow =
				"accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture";
			iframe.allowFullscreen = true;
			// 読み込み直すときは、サムネイルに戻してからもう一度押したことにする（プレーヤーも作り直す）
			const wrapper = youtubePlayer(iframe, facade.href, () => {
				clearTimeout(timer);
				media.players = media.players.filter((p) => p.frame !== iframe);
				wrapper.replaceWith(facade);
				facade.click();
			});
			const help = wrapper.querySelector<HTMLElement>(".digest-youtube-help");
			const showHelp = (show: boolean) => {
				if (help) help.hidden = !show;
			};
			let ready = false;
			// 準備完了が来なければ、bot の確認などで再生できていない
			const YOUTUBE_READY_TIMEOUT_MS = 8000;
			const timer = setTimeout(
				() => showHelp(!ready),
				YOUTUBE_READY_TIMEOUT_MS,
			);
			facade.replaceWith(wrapper);
			pauseOthers();
			withYouTubeApi(() => {
				const YT = window.YT;
				if (!YT) return;
				const entry: MediaPlayer = {
					frame: iframe,
					playing: false,
					started: false,
					play: () => player.playVideo?.(),
					pause: () => player.pauseVideo?.(),
					setVolume: (v) => player.setVolume?.(v),
					progress: async () => ({
						position: player.getCurrentTime?.() ?? 0,
						duration: player.getDuration?.() ?? 0,
					}),
					seek: (seconds) => player.seekTo?.(seconds, true),
				};
				const player = new YT.Player(iframe, {
					events: {
						onReady: () => {
							ready = true;
							clearTimeout(timer);
							showHelp(false);
							player.setVolume?.(mediaVolume());
						},
						// 埋め込み不可・削除済みなど
						onError: () => showHelp(true),
						onStateChange: (event) => {
							// 目次の再生ボタンの表示に使う
							// 読み込み中（3: BUFFERING）も再生中として扱い、ボタンの表示がちらつかないようにする
							entry.playing =
								event.data === YT.PlayerState.PLAYING || event.data === 3;
							if (entry.playing) entry.started = true;
							if (entry.playing) showHelp(false);
							updatePlayButtons();
							if (entry.playing) pauseOthers(iframe);
						},
					},
				});
				media.players.push(entry);
			});
		});
	}
}

function withSoundcloudApi(callback: () => void) {
	if (window.SC?.Widget) return callback();
	let script = document.getElementById(
		"soundcloud-widget-api",
	) as HTMLScriptElement | null;
	if (!script) {
		script = document.createElement("script");
		script.id = "soundcloud-widget-api";
		script.src = "https://w.soundcloud.com/player/api.js";
		document.body.appendChild(script);
	}
	script.addEventListener("load", callback, { once: true });
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
	if (autoPlay) pauseOthers();
	withSoundcloudApi(() => {
		const SC = window.SC;
		if (!SC) return;
		const widget = SC.Widget(iframe);
		// 準備ができる前に再生を押されたら、準備ができたところで再生する（それまでの play は無視されるため）
		let ready = false;
		let playWhenReady = false;
		const entry: MediaPlayer = {
			frame: iframe,
			playing: false,
			started: false,
			progress: () =>
				new Promise((resolve) =>
					widget.getPosition((pos) =>
						widget.getDuration((dur) =>
							resolve({ position: pos / 1000, duration: dur / 1000 }),
						),
					),
				),
			seek: (seconds) => widget.seekTo(seconds * 1000),
			play: () => {
				if (ready) widget.play();
				else playWhenReady = true;
			},
			pause: () => {
				playWhenReady = false;
				widget.pause();
			},
			setVolume: (v) => widget.setVolume(v),
		};
		const setPlaying = (playing: boolean) => {
			entry.playing = playing;
			if (playing) entry.started = true;
			updatePlayButtons();
		};
		widget.bind(SC.Widget.Events.READY, () => {
			ready = true;
			widget.setVolume(mediaVolume());
			if (playWhenReady) widget.play();
		});
		widget.bind(SC.Widget.Events.PLAY, () => {
			setPlaying(true);
			pauseOthers(iframe);
		});
		widget.bind(SC.Widget.Events.PAUSE, () => setPlaying(false));
		widget.bind(SC.Widget.Events.FINISH, () => setPlaying(false));
		media.players.push(entry);
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
	// プレーヤーの読み込みに時間がかかるので、押されてから読み込むのではなく、画面に近づいたら先に読み込んでおく
	const observer = new IntersectionObserver(
		(records) => {
			for (const r of records) {
				if (!r.isIntersecting) continue;
				observer.unobserve(r.target);
				mountSoundcloud(r.target as HTMLAnchorElement, false);
			}
		},
		{ rootMargin: "600px 0px" },
	);
	for (const facade of facades) {
		facade.dataset.ready = "true";
		observer.observe(facade);
		// 読み込む前に押されたときは、その場で差し替えて再生する
		facade.addEventListener("click", (e) => {
			e.preventDefault();
			observer.unobserve(facade);
			mountSoundcloud(facade, true);
		});
	}
}
