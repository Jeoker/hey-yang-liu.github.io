import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://heyyangliu.io",
  output: "static",
  vite: {
    plugins: [tailwindcss()],
  },
});
