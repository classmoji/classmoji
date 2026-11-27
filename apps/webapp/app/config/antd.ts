import { BRAND, BRAND_LIGHT, BRAND_BG, PRIMARY, PRIMARY_600 } from './theme.ts';

// Keep in sync with --font-sans in styles/tailwind.css & global.css. Ant Design
// components don't inherit the body font; without this token they fall back to
// Ant's default system stack (-apple-system, ...), so the UI renders in the OS
// font instead of Mona Sans.
const FONT_SANS =
  "'Mona Sans Variable', 'Mona Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

/**
 * antd 5's shadows. antd 6 deepened boxShadowTertiary (both modes), and its
 * dark algorithm derives every shadow from a white `colorShadow`, a faint
 * glow; with `colorShadow: '#000'` (antdDark.ts) the rest come out exactly as
 * antd 5's. Popover and tooltip shapes are restored in
 * @classmoji/ui-components/styles/antd.css.
 */
export const ANTD_V5_BOX_SHADOW_TERTIARY =
  '0 1px 2px 0 rgba(0, 0, 0, 0.03), 0 1px 6px -1px rgba(0, 0, 0, 0.02), 0 2px 4px 0 rgba(0, 0, 0, 0.02)';

/**
 * antd 6 draws Tags filled (no border) and without the trailing 8px margin
 * antd 5 gave them. Neither is a theme token, so this is the root
 * ConfigProvider's `tag` config: outlined by default (a Tag that asks for
 * `variant="filled"` stays filled) and antd 5's margin back.
 */
export const TAG_CONFIG = {
  variant: 'outlined',
  styles: { root: { marginInlineEnd: 8 } },
} as const;

/**
 * The root App's message config. antd 6 draws toasts 8px higher than antd 5
 * (its list sits at `top - 16px` inside 24px of padding); top 16 is antd 5's.
 */
export const MESSAGE_CONFIG = { top: 16 } as const;

const theme = {
  token: {
    colorPrimary: PRIMARY,
    // Near-black base so antd content (tables, lists, cards) matches the crisp
    // body ink (--ink-0). The previous gray-700 (#374151) made the main section
    // read washed-out/gray. antd derives colorText at ~88% opacity, so rendered
    // body text lands around ink-1 rather than pure black.
    colorTextBase: '#14151a',
    colorBgSolidActive: BRAND,
    // Links read as ink, not as the brand green. antd derives colorLink from
    // colorPrimary, which paints every <a>, Typography.Link and
    // `Button type="link"` green — including plain text that only happens to be
    // a link. Green stays for what it means: primary actions.
    colorLink: '#2b2d35', // --ink-1
    colorLinkHover: '#14151a', // --ink-0
    colorLinkActive: '#14151a',
    fontFamily: FONT_SANS,
    boxShadowTertiary: ANTD_V5_BOX_SHADOW_TERTIARY,
  },
  components: {
    Button: {
      algorithm: true,
      // `algorithm: true` re-derives this component's palette from the
      // overrides below, so Button's link colour comes from its own
      // colorPrimary — green — and ignores the global colorLink. Set it here
      // too, or `type="link"` stays green whatever the token says.
      colorLink: '#2b2d35',
      colorLinkHover: '#14151a',
      colorLinkActive: '#14151a',
      // Primary button styling (green background, white text)
      colorPrimary: PRIMARY,
      colorPrimaryHover: PRIMARY_600,
      colorTextLightSolid: '#ffffff',
      // Default button styling
      defaultBg: '#F7F8FA',
      defaultColor: '#000000',
      defaultBorderColor: '#D2D9E0',
      // Remove box shadow
      primaryShadow: 'none',
      defaultShadow: 'none',
      dangerShadow: 'none',
    },
    Table: {
      headerBg: '#ffffff',
      rowSelectedBg: BRAND_BG,
      rowSelectedHoverBg: BRAND_LIGHT,
      rowHoverBg: '#fafafa',
    },
    Tabs: {
      inkBarColor: PRIMARY,
      itemSelectedColor: PRIMARY,
      itemHoverColor: PRIMARY,
    },
    Progress: {
      defaultColor: BRAND_LIGHT,
      colorSuccess: BRAND,
    },
    Tag: {
      // antd 6 derives the default Tag fill from colorFillTertiary (#f6f6f6);
      // antd 5's was #fafafa.
      defaultBg: '#fafafa',
    },
    Select: {
      optionSelectedBg: '#f3f4f6',
      optionActiveBg: '#f9fafb',
      // antd 6 paints a selected option under the pointer with this token
      // (antd 5 kept optionSelectedBg there).
      controlItemBgActiveHover: '#f3f4f6',
      optionSelectedFontWeight: 600,
    },
    // antd 6 rings a keyboard-focused borderless control and a focused clear
    // (×) button, which antd 5 did not. Kept on purpose: they are keyboard
    // focus indicators (no lineWidthFocus pin here).
    Input: {
      hoverBorderColor: '#d1d5db',
      activeBorderColor: '#9ca3af',
      activeShadow: 'none',
    },
    // Space.Addon, antd 6's replacement for input addons: antd 5's 11px
    // padding and 14px text, small size included. Its background is set back
    // in ui-components/styles/antd.css.
    Addon: {
      paddingSM: 11,
      paddingXS: 11,
      fontSizeSM: 14,
    },
    FloatButton: {
      colorPrimary: BRAND,
      colorBgElevated: BRAND,
      colorText: '#000000',
      colorTextLightSolid: '#000000',
    },
  },
};

export default theme;
