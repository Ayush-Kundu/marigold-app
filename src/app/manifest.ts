import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Marigold",
    short_name: "Marigold",
    description: "An AI agent that quietly gets things done for you.",
    start_url: "/",
    display: "standalone",
    background_color: "#0c0c0e",
    theme_color: "#17120a",
    orientation: "portrait",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
