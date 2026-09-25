import { siteConfig } from "@/config";
import rss from "@astrojs/rss";
import { getSortedPosts } from "@utils/content-utils";
import { getPostUrlBySlug } from "@utils/url-utils";
import type { APIContext } from "astro";
import MarkdownIt from "markdown-it";
import sanitizeHtml from "sanitize-html";

const parser = new MarkdownIt();

export async function GET(context: APIContext) {
	const blog = await getSortedPosts();

	return rss({
		title: siteConfig.title,
		description: siteConfig.subtitle || "No description",
		site: new URL(
			import.meta.env.BASE_URL,
			context.site ?? "https://tanitaka-tech.github.io",
		),
		items: blog.map((post) => {
			const content =
				typeof post.body === "string" ? post.body : String(post.body || "");

			return {
				title: post.data.title,
				pubDate: post.data.published,
				description: post.data.description || "",
				link: getPostUrlBySlug(post.slug),
				content: sanitizeHtml(parser.render(content), {
					allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
				}),
			};
		}),
		customData: `<language>${siteConfig.lang}</language>`,
	});
}
