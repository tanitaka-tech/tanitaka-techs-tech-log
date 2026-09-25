import path from "node:path";
import { getImage } from "astro:assets";
import { url } from "./url-utils";

// TODO temporary workaround for images dynamic import
// https://github.com/withastro/astro/issues/3373
const localImages = import.meta.glob<ImageMetadata>("../**", {
	import: "default",
});

export function isLocalImage(src: string): boolean {
	return !(
		src.startsWith("/") ||
		src.startsWith("http") ||
		src.startsWith("data:")
	);
}

/**
 * Load an image under /src. `basePath` is the directory relative to /src
 * that `src` is relative to.
 */
export async function loadLocalImage(
	src: string,
	basePath = "/",
): Promise<ImageMetadata | undefined> {
	const normalizedPath = path
		.normalize(path.join("../", basePath, src))
		.replace(/\\/g, "/");
	const file = localImages[normalizedPath];
	if (!file) {
		console.error(
			`\n[ERROR] Image file not found: ${normalizedPath.replace("../", "src/")}`,
		);
		return undefined;
	}
	return await file();
}

/**
 * Resolve an image path (local, public or remote) to an absolute URL,
 * e.g. for og:image.
 */
export async function getAbsoluteImageUrl(
	src: string,
	site: URL,
	basePath = "/",
): Promise<string | undefined> {
	if (!src) return undefined;
	if (src.startsWith("http")) return src;
	if (src.startsWith("/")) return new URL(url(src), site).href;
	const img = await loadLocalImage(src, basePath);
	if (!img) return undefined;
	const optimized = await getImage({ src: img, format: "jpeg", width: 1200 });
	return new URL(optimized.src, site).href;
}
