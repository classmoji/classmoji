import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
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
  schema: docsSchema(),
});

export const collections = { blog, docs };
