import { defineConfig } from "vitepress";
import { generateSidebar } from "vitepress-sidebar";

export default defineConfig({
  title: "Sanbei blog",
  description: "Sanbei的博客",
  cleanUrls: true,
  head: [["link", { rel: "icon", href: "/favicon.png" }]],
  markdown: {
    theme: {
      light: "github-light",
      dark: "github-dark",
    },
  },
  sitemap: {
    hostname: "https://sanbei101.cn",
  },
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: "首页", link: "/" },
      { text: "长城突破", link: "/china-wall/" },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/sanbei101" }],
    sidebar: generateSidebar({
      useTitleFromFrontmatter: true,
      collapseDepth: 2,
      useFolderLinkFromIndexFile: true,
      useFolderTitleFromIndexFile: true,
      hyphenToSpace: true,
      debugPrint: true,
    }),
    search: {
      provider: "local",
    },
  },
});
