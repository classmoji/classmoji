import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

const blog = defineCollection({
  loader: glob({ pattern: '**/index.{md,mdx}', base: './src/content/blog' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      description: z.string(),
      pubDate: z.coerce.date(),
      updatedDate: z.coerce.date().optional(),
      author: z.string().default('Classmoji Team'),
      tags: z.array(z.string()).optional(),
      draft: z.boolean().default(false),
      heroImage: image().optional(),
      emoji: z.string().optional(),
      emojiBackground: z.string().optional(),
    }),
});

const docs = defineCollection({
  loader: docsLoader(),
  schema: docsSchema(),
});

export const collections = { blog, docs };
