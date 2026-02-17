export const slugify = str => {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
};

export const getTermCode = (term, year) => {
  const termMap = { WINTER: 'w', SPRING: 's', SUMMER: 'x', FALL: 'f' };
  const shortYear = String(year).slice(-2);
  return `${shortYear}${termMap[term] || 'x'}`;
};

export const STEPS = [
  { title: 'Basic Info' },
  { title: 'Import' },
  { title: 'Review' },
];
