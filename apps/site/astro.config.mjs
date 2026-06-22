import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'url';
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
            {
              label: 'Video tutorials',
              slug: 'docs/video-tutorials',
              badge: { text: 'New', variant: 'tip' },
            },
          ],
        },
        {
          label: '👨‍🏫 For Instructors',
          items: [
            { label: 'Create a classroom', slug: 'docs/instructors/create-classroom' },
            {
              label: 'Github Classroom',
              slug: 'docs/instructors/import-github-classroom',
              badge: { text: 'New', variant: 'tip' },
            },
            { label: 'Manage your roster', slug: 'docs/instructors/roster' },
            { label: 'Repositories & assignments', slug: 'docs/instructors/modules-and-assignments' },
            {
              label: 'Autograding',
              slug: 'docs/instructors/autograding',
              badge: { text: 'New', variant: 'tip' },
            },
            { label: 'Build pages', slug: 'docs/instructors/pages' },
            { label: 'Build modules', slug: 'docs/instructors/modules' },
            { label: 'Grade assignments', slug: 'docs/instructors/grading' },
            { label: 'Configure tokens', slug: 'docs/instructors/tokens' },
          ],
        },
        {
          label: '🎒 For Students',
          items: [
            { label: 'Join a classroom', slug: 'docs/students/join-a-classroom' },
            { label: 'Submit assignments', slug: 'docs/students/submit-assignments' },
            { label: 'Use tokens', slug: 'docs/students/use-tokens' },
            { label: 'View grades', slug: 'docs/students/view-grades' },
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
            { label: 'Local development', slug: 'docs/open-source/local-development' },
            { label: 'Github repo', link: 'https://github.com/classmoji/classmoji' },
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
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        '~': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
  }
});