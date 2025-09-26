// @ts-check
// `@type` JSDoc annotations allow editor autocompletion and type checking
// (when paired with `@ts-check`).
// There are various equivalent ways to declare your Docusaurus config.
// See: https://docusaurus.io/docs/api/docusaurus-config

import { themes as prismThemes } from 'prism-react-renderer';
import dotenv from 'dotenv';

dotenv.config();

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const config = {
  title: 'classmoji',
  tagline: 'From 🤷 to 🎯 all in one platform.',
  favicon: 'img/favicon.ico',

  // Set the production url of your site here
  url: 'https://classmoji.io',
  // Set the /<baseUrl>/ pathname under which your site is served
  // For GitHub pages deployment, it is often '/<projectName>/'
  baseUrl: '/',

  // GitHub pages deployment config.
  // If you aren't using GitHub pages, you don't need these.
  organizationName: 'classmoji', // Usually your GitHub org/user name.
  projectName: 'classmoji', // Usually your repo name.

  onBrokenLinks: 'throw',
  onBrokenMarkdownLinks: 'warn',

  // Even if you don't use internationalization, you can use this field to set
  // useful metadata like html lang. For example, if your site is Chinese, you
  // may want to replace "en" with "zh-Hans".

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.js',

          // Please change this to your repo.
          // Remove this to remove the "edit this page" links.
          editUrl:
            'https://github.com/facebook/docusaurus/tree/main/packages/create-docusaurus/templates/shared/',
        },
        blog: {
          showReadingTime: true,
          feedOptions: {
            type: ['rss', 'atom'],
            xslt: true,
          },
          // Please change this to your repo.
          // Remove this to remove the "edit this page" links.
          editUrl:
            'https://github.com/facebook/docusaurus/tree/main/packages/create-docusaurus/templates/shared/',
          // Useful options to enforce blogging best practices
          onInlineTags: 'warn',
          onInlineAuthors: 'warn',
          onUntruncatedBlogPosts: 'warn',
        },
        theme: {
          customCss: './src/css/custom.css',
        },
      },
    ],
  ],

  themeConfig: {
    // Replace with your project's social card
    image: 'img/docusaurus-social-card.jpg',
    navbar: {
      // title: 'classmoji',
      logo: {
        alt: 'My Site Logo',
        src: 'img/logo.png',
        height: 200,
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docSidebar',
          position: 'left',
          label: 'Guide',
        },
        { to: '/use-cases', label: 'Use Cases', position: 'left' },
        { to: '/faq', label: 'FAQ', position: 'left' },
        // { to: '/pricing', label: 'Pricing', position: 'left' },
        { to: '/blog', label: 'Blog', position: 'left' },
        { to: '/changelog', label: 'Changelog', position: 'left' },

        {
          label: 'Sign In',
          href: `https://github.com/login/oauth/authorize?client_id=Iv1.1e71225d72d223cb&scope=repo%20admin:org`,
          position: 'right',
          target: '_self',
          className: 'navbar__signin-button',
        },
        {
          'href': 'https://github.com/orgs/classmoji/discussions',
          'position': 'right',
          'className': 'header-github-link',
          'aria-label': 'GitHub discussions',
        },
        {
          'href':
            'https://join.slack.com/t/classmoji/shared_invite/zt-3b59s28sl-gkaDSF23LtVco3V5gD1gbg',
          'position': 'right',
          'className': 'header-slack-link',
          'aria-label': 'Slack',
        },
      ],
    },
    prism: {
      theme: prismThemes.github,
    },
  },
  stylesheets: [
    {
      href: 'https://fonts.googleapis.com/css2?family=Noto+Sans:ital,wght@0,100..900;1,100..900&display=swap',
      type: 'text/css',
      rel: 'stylesheet', // ✅ Required
    },
  ],
  plugins: [
    './src/plugins/tailwind-config.js',
    [
      '@dipakparmar/docusaurus-plugin-umami',
      {
        websiteID: 'f81d35e9-d9cc-46d8-88f6-89b0f23b8500', // Required
        analyticsDomain: 'analytics.classmoji.io', // Required
      },
    ],
  ],
};

export default config;
