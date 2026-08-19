export const slugify = (str: string) => {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
};

// Typing-safe form of `slugify`, for the field the user edits character by
// character. It lowercases and converts invalid characters but leaves dashes
// where they are: trimming edge dashes on every keystroke deletes the dash the
// moment it is typed, so a hyphenated slug can never be entered by hand.
// `slugify` runs on blur to settle the final value.
export const slugifyInput = (str: string) => str.toLowerCase().replace(/[^a-z0-9-]+/g, '-');

export const STEPS = [{ title: 'Basic Info' }, { title: 'Import' }, { title: 'Review' }];
