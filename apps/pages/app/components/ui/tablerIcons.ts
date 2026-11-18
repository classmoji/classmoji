import { createReactComponent } from '@tabler/icons-react';

/**
 * Tabler icons whose glyph Tabler 3 redrew, kept as Tabler 2.47 drew them so
 * the interface does not change: the calendar keeps its date mark. Same
 * component API and classes as the library's own icons.
 */
export const IconCalendar = createReactComponent('outline', 'calendar', 'Calendar', [
  [
    'path',
    {
      d: 'M4 7a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12z',
      key: 'svg-0',
    },
  ],
  ['path', { d: 'M16 3v4', key: 'svg-1' }],
  ['path', { d: 'M8 3v4', key: 'svg-2' }],
  ['path', { d: 'M4 11h16', key: 'svg-3' }],
  ['path', { d: 'M11 15h1', key: 'svg-4' }],
  ['path', { d: 'M12 15v3', key: 'svg-5' }],
]);
