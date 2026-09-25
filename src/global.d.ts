import type { AstroIntegration } from "@swup/astro";

declare global {
	interface Window {
		// type from '@swup/astro' is incorrect
		swup: AstroIntegration;
		// Bluesky の埋め込み用 embed.js
		bluesky?: { scan: () => void };
		// X の埋め込み用 widgets.js
		twttr?: { widgets: { load: (el?: Element) => void } };
		// YouTube IFrame Player API（ダイジェストの動画を同時に再生させないため）
		YT?: {
			Player: new (
				el: HTMLIFrameElement,
				options: {
					events: {
						onReady?: () => void;
						onError?: (e: { data: number }) => void;
						onStateChange: (e: { data: number }) => void;
					};
				},
			) => {
				pauseVideo?: () => void;
				playVideo?: () => void;
				setVolume?: (volume: number) => void;
				getCurrentTime?: () => number;
				getDuration?: () => number;
				seekTo?: (seconds: number, allowSeekAhead: boolean) => void;
			};
			PlayerState: { PLAYING: number };
		};
		onYouTubeIframeAPIReady?: () => void;
		// SoundCloud Widget API（同じく、他のプレーヤーと同時に再生させないため）
		SC?: {
			Widget: ((el: HTMLIFrameElement) => {
				bind: (event: string, callback: () => void) => void;
				pause: () => void;
				play: () => void;
				setVolume: (volume: number) => void;
				getPosition: (callback: (ms: number) => void) => void;
				getDuration: (callback: (ms: number) => void) => void;
				seekTo: (ms: number) => void;
			}) & {
				Events: { PLAY: string; PAUSE: string; FINISH: string; READY: string };
			};
		};
		pagefind: {
			search: (query: string) => Promise<{
				results: Array<{
					data: () => Promise<SearchResult>;
				}>;
			}>;
		};
	}
}

interface SearchResult {
	url: string;
	meta: {
		title: string;
	};
	excerpt: string;
	content?: string;
	word_count?: number;
	filters?: Record<string, unknown>;
	anchors?: Array<{
		element: string;
		id: string;
		text: string;
		location: number;
	}>;
	weighted_locations?: Array<{
		weight: number;
		balanced_score: number;
		location: number;
	}>;
	locations?: number[];
	raw_content?: string;
	raw_url?: string;
	sub_results?: SearchResult[];
}
