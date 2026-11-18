import { createReactComponent } from '@tabler/icons-react';

/**
 * Tabler icons whose glyph Tabler 3 redrew, kept as Tabler 2.47 drew them so
 * the interface does not change: the calendar keeps its date mark, the apple
 * its round outline, the bar chart its rising bars. Same component API and
 * classes as the library's own icons.
 */
export const IconApple = createReactComponent('outline', 'apple', 'Apple', [
  ['path', { d: 'M12 14m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0', key: 'svg-0' }],
  ['path', { d: 'M12 11v-6a2 2 0 0 1 2 -2h2v1a2 2 0 0 1 -2 2h-2', key: 'svg-1' }],
  ['path', { d: 'M10 10.5c1.333 .667 2.667 .667 4 0', key: 'svg-2' }],
]);

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

export const IconChartBar = createReactComponent('outline', 'chart-bar', 'ChartBar', [
  [
    'path',
    {
      d: 'M3 12m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z',
      key: 'svg-0',
    },
  ],
  [
    'path',
    {
      d: 'M9 8m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z',
      key: 'svg-1',
    },
  ],
  [
    'path',
    {
      d: 'M15 4m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v14a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z',
      key: 'svg-2',
    },
  ],
  ['path', { d: 'M4 20l14 0', key: 'svg-3' }],
]);
