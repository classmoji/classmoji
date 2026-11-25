import { v8CssVariablesResolver, type MantineThemeOverride } from '@mantine/core';

/**
 * Mantine 8's look, kept under Mantine 9 for every provider in the app
 * (BlockNote's Mantine menus, toolbars and panels draw with the nearest
 * provider's theme). Mantine 9 changed three defaults:
 * - the default radius (`sm`, 4px, became `md`, 8px);
 * - font weights now come from `fontWeights.medium` (600). Buttons and
 *   action icons were 600 in Mantine 8 already; the labels below were 500;
 * - the `light` variant colours (solid instead of translucent; the resolver
 *   keeps the translucent ones).
 */
const MANTINE_8_LABEL = { fontWeight: 500 };

export const MANTINE_8_THEME = {
  defaultRadius: 'sm',
  components: {
    Menu: { styles: { label: MANTINE_8_LABEL } },
    InputWrapper: { styles: { label: MANTINE_8_LABEL } },
    Combobox: { styles: { groupLabel: MANTINE_8_LABEL } },
    SegmentedControl: { styles: { label: MANTINE_8_LABEL } },
    Notification: { styles: { title: MANTINE_8_LABEL } },
  },
} satisfies MantineThemeOverride;

export const mantine8CssVariables = v8CssVariablesResolver;
