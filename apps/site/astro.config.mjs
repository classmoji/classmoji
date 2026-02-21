import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import mdx from '@astrojs/mdx';
import starlight from '@astrojs/starlight';
import starlightThemeBlack from 'starlight-theme-black';

// https://astro.build/config
export default defineConfig({
  integrations: [
    starlight({
      title: '🍎 classmoji',
      description: 'Documentation for Classmoji - the git-native LMS for CS education',
      components: {
        SiteTitle: './src/components/SiteTitle.astro',
      },
      plugins: [
        starlightThemeBlack({
          navLinks: [
            { label: 'Back to main site', link: 'https://classmoji.io' },
          ],
          footerText: '🍎 Built by educators and students. [Contribute on GitHub](https://github.com/classmoji/classmoji)',
        }),
      ],
      sidebar: [
        {
          label: '👋 Introduction',
          items: [
            { label: 'Welcome', slug: 'docs' },
            { label: 'Getting started', slug: 'docs/introduction/getting-started' },
            { label: 'Core concepts', slug: 'docs/introduction/fundamentals' },
          ],
        },
        {
          label: '👨‍🏫 For Instructors',
          items: [
            { label: 'Create a classroom', slug: 'docs/instructors' },
            { label: 'Manage your roster', slug: 'docs/instructors/roster' },
            { label: 'Modules & assignments', slug: 'docs/instructors/modules-and-assignments' },
            { label: 'Grade assignments', slug: 'docs/instructors/grading' },
            { label: 'Configure tokens', slug: 'docs/instructors/tokens' },
            { label: 'Build pages', slug: 'docs/instructors/pages' },
          ],
        },
        {
          label: '🐳 Self-hosting',
          items: [
            { label: 'Deploy with Docker', slug: 'docs/self-hosting/docker' },
            { label: 'Environment variables', slug: 'docs/self-hosting/environment-variables' },
          ],
        },
        {
          label: '🌐 Open Source',
          items: [
            { label: 'Contributing', slug: 'docs/open-source/contributing' },
            { label: 'Gitbub repo', link: 'https://github.com/classmoji/classmoji' },
            { label: 'Roadmap', link: 'https://github.com/orgs/classmoji/projects/2' },
          ],
        },
      ],
      social: [
        {
          icon: 'github',
          label: 'Github',
          href: 'https://github.com/classmoji/classmoji',
        },
      ],
      customCss: [
        './src/styles/starlight.css',
      ],
    }),
    mdx(),
  ],
  server: {
    port: 4000
  },
  vite: {
    plugins: [tailwindcss()]
  }
});