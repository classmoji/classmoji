import type { ThemeConfig } from 'antd';

/**
 * The slides app's antd theme: antd's defaults, with antd 5's look kept where
 * antd 6 changed a default that a token can set back. Dialogs that pass their
 * own `theme={{ algorithm }}` inherit these tokens.
 *
 * The rest of antd 6's changes are undone in
 * @classmoji/ui-components/styles/antd.css.
 */
export const SLIDES_ANTD_THEME: ThemeConfig = {
  token: {
    // antd 6's dark algorithm derives its shadows from a white colorShadow (a
    // faint glow on the dark dialogs); black gives back antd 5's shadows.
    colorShadow: '#000',
    // antd 6 deepened this one shadow.
    boxShadowTertiary:
      '0 1px 2px 0 rgba(0, 0, 0, 0.03), 0 1px 6px -1px rgba(0, 0, 0, 0.02), 0 2px 4px 0 rgba(0, 0, 0, 0.02)',
    // colorShadow is a seed antd 6 reads but does not type.
  } as ThemeConfig['token'],
  components: {
    // Space.Addon (antd 6's input addon, the "px" cells of the properties
    // panel): antd 5's 11px padding and 14px text, small size included. Its
    // background is set back in ui-components/styles/antd.css.
    Addon: {
      paddingSM: 11,
      paddingXS: 11,
      fontSizeSM: 14,
    },
  } as ThemeConfig['components'],
};
