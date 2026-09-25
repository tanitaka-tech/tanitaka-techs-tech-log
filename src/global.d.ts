import type { AstroIntegration } from "@swup/astro";

declare global {
	interface Window {
		// type from '@swup/astro' is incorrect
		swup: AstroIntegration;
		// X の埋め込み用 widgets.js
		twttr?: { widgets: { load: (el?: Element) => void } };
		// YouTube IFrame Player API（ダイジェストの動画を同時に再生させないため）
		YT?: {
			Player: new (
				el: HTMLIFrameElement,
				options: { events: { onStateChange: (e: { data: number }) => void } },
			) => { pauseVideo?: () => void };
			PlayerState: { PLAYING: number };
		};
		onYouTubeIframeAPIReady?: () => void;
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
