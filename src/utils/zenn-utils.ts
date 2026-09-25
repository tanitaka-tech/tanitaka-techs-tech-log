import { zennConfig } from "../config";

export type ZennArticle = {
	title: string;
	url: string;
	published: Date;
};

let cache: Promise<ZennArticle[]> | undefined;

function pickTag(xml: string, tag: string): string {
	const match = xml.match(
		new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`),
	);
	return match?.[1].trim() ?? "";
}

async function fetchZennArticles(): Promise<ZennArticle[]> {
	const feedUrl = `https://zenn.dev/${zennConfig.username}/feed`;
	try {
		const res = await fetch(feedUrl);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const xml = await res.text();
		return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => ({
			title: pickTag(item, "title"),
			url: pickTag(item, "link"),
			published: new Date(pickTag(item, "pubDate")),
		}));
	} catch (e) {
		// don't fail the whole build when Zenn is unreachable
		console.warn(`[WARN] Failed to fetch Zenn feed (${feedUrl}): ${e}`);
		return [];
	}
}

/** Fetch the Zenn feed once per build. */
export function getZennArticles(): Promise<ZennArticle[]> {
	if (!zennConfig.enable) return Promise.resolve([]);
	cache ??= fetchZennArticles();
	return cache;
}
