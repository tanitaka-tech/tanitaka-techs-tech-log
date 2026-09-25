import type { Favicon } from "@/types/config.ts";

export const defaultFavicons: Favicon[] = [32, 128, 180, 192].map((size) => ({
	src: `/favicon/favicon-${size}.png`,
	sizes: `${size}x${size}`,
}));
