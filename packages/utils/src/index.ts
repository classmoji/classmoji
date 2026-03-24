import { customAlphabet } from 'nanoid';

export const generateId = (): number => {
  const nanoid = customAlphabet('0123456789', 9);
  return parseInt(nanoid(), 10);
};

export const titleToIdentifier = (title: string): string => {
  if (!title) return '';
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/ +/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
};

export * from './grades.ts';
export * from './emojis.ts';
export * from './quiz.ts';
export * from './content.ts';
export * from './debounce.ts';
