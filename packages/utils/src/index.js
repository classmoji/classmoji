import { customAlphabet } from 'nanoid';

export const generateId = () => {
  const nanoid = customAlphabet('0123456789', 9);
  return parseInt(nanoid(), 10);
};

export const titleToIdentifier = title => {
  if (!title) return '';
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '') // Remove special characters except spaces and hyphens
    .replace(/ +/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Collapse multiple hyphens
    .replace(/^-|-$/g, ''); // Trim leading/trailing hyphens
};

export * from './grades.js';
export * from './emojis.js';
export * from './quiz.js';
export * from './content.js';
export * from './debounce.js';
