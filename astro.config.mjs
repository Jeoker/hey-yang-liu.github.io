import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://jeoker.github.io",
  base: "/hey-yang-liu.github.io",
  output: "static",
  vite: {
    plugins: [tailwindcss()],
  },
});
