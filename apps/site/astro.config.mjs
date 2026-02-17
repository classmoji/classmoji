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
          label: '👨‍🏫 For Instructors',
          items: [
            { label: 'Getting Started', slug: 'docs/instructors' },
          ],
        },
        {
          label: '🧑‍💻 For Students',
          items: [
            { label: 'Getting Started', slug: 'docs/students' },
          ],
        },
        {
          label: '🌐 Open Source',
          items: [
            { label: 'Contributing', slug: 'docs/contributing' },
            { label: 'GitHub Repo', link: 'https://github.com/classmoji/classmoji' },
            { label: 'Roadmap', link: 'https://github.com/orgs/classmoji/projects/classmoji-roadmap' },
          ],
        },
      ],
      social: [
        {
          icon: 'github',
          label: 'GitHub',
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