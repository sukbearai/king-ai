import { defineConfig } from "vitepress";

const enNav = [
  { text: "Guide", link: "/guide/getting-started" },
  { text: "CLI", link: "/guide/cli" },
  { text: "GUI", link: "/guide/gui" },
  { text: "中文", link: "/zh/" },
];

const enSidebar = [
  {
    text: "Start",
    items: [
      { text: "Overview", link: "/" },
      { text: "Getting Started", link: "/guide/getting-started" },
      { text: "Core Concepts", link: "/guide/concepts" },
    ],
  },
  {
    text: "Operate",
    items: [
      { text: "CLI Reference", link: "/guide/cli" },
      { text: "Trade Intelligence", link: "/guide/trade" },
      { text: "GUI Runtime", link: "/guide/gui" },
      { text: "Configuration", link: "/guide/configuration" },
      { text: "Deploy & Release", link: "/guide/release" },
    ],
  },
];

const zhNav = [
  { text: "指南", link: "/zh/guide/getting-started" },
  { text: "CLI", link: "/zh/guide/cli" },
  { text: "GUI", link: "/zh/guide/gui" },
  { text: "English", link: "/" },
];

const zhSidebar = [
  {
    text: "开始",
    items: [
      { text: "概览", link: "/zh/" },
      { text: "快速开始", link: "/zh/guide/getting-started" },
      { text: "核心概念", link: "/zh/guide/concepts" },
    ],
  },
  {
    text: "使用与运维",
    items: [
      { text: "CLI 参考", link: "/zh/guide/cli" },
      { text: "交易信号", link: "/zh/guide/trade" },
      { text: "GUI Runtime", link: "/zh/guide/gui" },
      { text: "配置", link: "/zh/guide/configuration" },
      { text: "部署与发布", link: "/zh/guide/release" },
    ],
  },
];

export default defineConfig({
  title: "King AI",
  description: "Documentation for the King AI local BYOA multi-agent runtime.",
  cleanUrls: true,
  lastUpdated: true,
  head: [["meta", { name: "theme-color", content: "#0f766e" }]],
  themeConfig: {
    siteTitle: "King AI Docs",
    nav: enNav,
    sidebar: enSidebar,
    search: {
      provider: "local",
    },
    outline: {
      level: [2, 3],
    },
    socialLinks: [{ icon: "github", link: "https://github.com/sukbearai/king-ai" }],
    editLink: {
      pattern: "https://github.com/sukbearai/king-ai/edit/main/apps/docs/src/:path",
      text: "Edit this page on GitHub",
    },
    footer: {
      message: "Local BYOA multi-agent collaboration.",
      copyright: "Copyright King AI contributors.",
    },
  },
  locales: {
    root: {
      label: "English",
      lang: "en-US",
      title: "King AI",
      description: "Documentation for the King AI local BYOA multi-agent runtime.",
      themeConfig: {
        nav: enNav,
        sidebar: enSidebar,
      },
    },
    zh: {
      label: "简体中文",
      lang: "zh-CN",
      title: "King AI",
      description: "King AI 本地 BYOA 多智能体协作运行时文档。",
      themeConfig: {
        nav: zhNav,
        sidebar: zhSidebar,
        outline: {
          label: "本页内容",
          level: [2, 3],
        },
        docFooter: {
          prev: "上一页",
          next: "下一页",
        },
        darkModeSwitchLabel: "外观",
        lightModeSwitchTitle: "切换到浅色模式",
        darkModeSwitchTitle: "切换到深色模式",
        sidebarMenuLabel: "菜单",
        returnToTopLabel: "返回顶部",
        langMenuLabel: "切换语言",
        editLink: {
          pattern: "https://github.com/sukbearai/king-ai/edit/main/apps/docs/src/:path",
          text: "在 GitHub 上编辑此页",
        },
        footer: {
          message: "本地 BYOA 多智能体协作。",
          copyright: "Copyright King AI contributors.",
        },
      },
    },
  },
});
