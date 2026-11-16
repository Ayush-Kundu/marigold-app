import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // The Mac app runs this server from INSIDE the signed Marigold.app. Writing the page cache
  // there breaks the code signature, and macOS then ignores Accessibility/Screen Recording
  // grants. Keep that cache in memory.
  experimental: { isrFlushToDisk: false },
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
