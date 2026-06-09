export const slugify = (str: string) => {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
};

export const STEPS = [{ title: 'Basic Info' }, { title: 'Import' }, { title: 'Review' }];
