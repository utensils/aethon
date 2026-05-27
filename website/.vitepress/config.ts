import { defineConfig } from "vitepress";

// utensils.io is the org's GitHub Pages custom domain — every repo
// Pages site is served at https://utensils.io/<repo>/.
const SITE_URL = "https://utensils.io/aethon/";
const REPO = "utensils/aethon";

export default defineConfig({
  lang: "en-US",
  title: "Aethon",
  description:
    "An agent-driven desktop shell. The agent decides what you see.",
  base: "/aethon/",
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: SITE_URL },
  head: [
    ["link", { rel: "icon", type: "image/x-icon", href: "/aethon/favicon.ico" }],
    ["link", { rel: "icon", type: "image/png", href: "/aethon/icon.png" }],
    ["meta", { name: "theme-color", content: "#ff6a18" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "Aethon" }],
    [
      "meta",
      {
        property: "og:description",
        content: "An agent-driven desktop shell. The agent decides what you see.",
      },
    ],
    ["meta", { property: "og:url", content: SITE_URL }],
    ["meta", { property: "og:image", content: `${SITE_URL}aethon-hero-dark.svg` }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
  ],
  themeConfig: {
    logo: { src: "/aethon-logo.svg", alt: "Aethon" },
    siteTitle: "Aethon",

    nav: [
      { text: "Guide", link: "/guide/installation", activeMatch: "/guide/" },
      {
        text: "Reference",
        link: "/reference/keyboard-shortcuts",
        activeMatch: "/reference/",
      },
      { text: "Troubleshooting", link: "/troubleshooting" },
      {
        text: "v0.2.0",
        items: [
          {
            text: "Releases",
            link: "https://github.com/utensils/aethon/releases",
          },
          {
            text: "Changelog",
            link: "https://github.com/utensils/aethon/blob/main/CHANGELOG.md",
          },
          {
            text: "Spec",
            link: "https://github.com/utensils/aethon/blob/main/SPEC.md",
          },
        ],
      },
    ],

    sidebar: {
      "/guide/": [
        {
          text: "Getting started",
          collapsed: false,
          items: [
            { text: "Installation", link: "/guide/installation" },
            { text: "Quick start", link: "/guide/quick-start" },
            { text: "Configuration", link: "/guide/configuration" },
          ],
        },
        {
          text: "Working with Aethon",
          collapsed: false,
          items: [
            { text: "Projects", link: "/guide/projects" },
            { text: "Agent tabs", link: "/guide/agent-tabs" },
            {
              text: "Shells & share modes",
              link: "/guide/shells-and-share-modes",
            },
            { text: "Command palette", link: "/guide/command-palette" },
            {
              text: "Settings & search",
              link: "/guide/settings-and-search",
            },
          ],
        },
        {
          text: "Customizing Aethon",
          collapsed: false,
          items: [
            { text: "Layouts", link: "/guide/layouts" },
            { text: "Themes", link: "/guide/themes" },
            {
              text: "Skills & extensions",
              link: "/guide/skills-and-extensions",
            },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            {
              text: "Keyboard shortcuts",
              link: "/reference/keyboard-shortcuts",
            },
            { text: "Slash commands", link: "/reference/slash-commands" },
            { text: "config.toml", link: "/reference/config-reference" },
            { text: "Runtime API", link: "/reference/runtime-api" },
          ],
        },
      ],
    },

    socialLinks: [{ icon: "github", link: `https://github.com/${REPO}` }],

    editLink: {
      pattern: `https://github.com/${REPO}/edit/main/website/:path`,
      text: "Edit this page on GitHub",
    },

    search: { provider: "local" },

    footer: {
      message:
        'Released under the <a href="https://github.com/utensils/aethon/blob/main/LICENSE">MIT License</a>.',
      copyright:
        '© 2026 <a href="https://github.com/utensils">Utensils</a> · James Brink',
    },

    outline: { level: [2, 3] },
  },
});
