import { BRAND, BRAND_LIGHT, BRAND_BG, PRIMARY, PRIMARY_600 } from './theme.ts';

// Keep in sync with --font-sans in styles/tailwind.css & global.css. Ant Design
// components don't inherit the body font; without this token they fall back to
// Ant's default system stack (-apple-system, ...), so the UI renders in the OS
// font instead of Mona Sans.
const FONT_SANS =
  "'Mona Sans Variable', 'Mona Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

/**
 * antd 5's shadows, which antd 6 changed: a deeper boxShadowTertiary, and in
 * dark mode every shadow turned into a faint white glow. Both themes spread
 * these so overlays, cards and drawers keep the depth they had. Popovers and
 * tooltips draw theirs with a CSS filter in antd 6, so dropShadowPopover is
 * antd 5's popover shadow as drop-shadows.
 */
const V5_SHADOW =
  '0 6px 16px 0 rgba(0, 0, 0, 0.08), 0 3px 6px -4px rgba(0, 0, 0, 0.12), 0 9px 28px 8px rgba(0, 0, 0, 0.05)';
export const ANTD_V5_SHADOWS = {
  boxShadow: V5_SHADOW,
  boxShadowSecondary: V5_SHADOW,
  boxShadowTertiary:
    '0 1px 2px 0 rgba(0, 0, 0, 0.03), 0 1px 6px -1px rgba(0, 0, 0, 0.02), 0 2px 4px 0 rgba(0, 0, 0, 0.02)',
  boxShadowPopoverArrow: '2px 2px 5px rgba(0, 0, 0, 0.05)',
  boxShadowCard:
    '0 1px 2px -2px rgba(0,0,0,0.16), 0 3px 6px 0 rgba(0,0,0,0.12), 0 5px 12px 4px rgba(0,0,0,0.09)',
  boxShadowDrawerRight:
    '-6px 0 16px 0 rgba(0, 0, 0, 0.08), -3px 0 6px -4px rgba(0, 0, 0, 0.12), -9px 0 28px 8px rgba(0, 0, 0, 0.05)',
  boxShadowDrawerLeft:
    '6px 0 16px 0 rgba(0, 0, 0, 0.08), 3px 0 6px -4px rgba(0, 0, 0, 0.12), 9px 0 28px 8px rgba(0, 0, 0, 0.05)',
  boxShadowDrawerUp: V5_SHADOW,
  boxShadowDrawerDown:
    '0 -6px 16px 0 rgba(0, 0, 0, 0.08), 0 -3px 6px -4px rgba(0, 0, 0, 0.12), 0 -9px 28px 8px rgba(0, 0, 0, 0.05)',
  boxShadowTabsOverflowLeft: 'inset 10px 0 8px -8px rgba(0, 0, 0, 0.08)',
  boxShadowTabsOverflowRight: 'inset -10px 0 8px -8px rgba(0, 0, 0, 0.08)',
  boxShadowTabsOverflowTop: 'inset 0 10px 8px -8px rgba(0, 0, 0, 0.08)',
  boxShadowTabsOverflowBottom: 'inset 0 -10px 8px -8px rgba(0, 0, 0, 0.08)',
  dropShadowPopover:
    'drop-shadow(0 6px 16px rgba(0,0,0,0.08)) drop-shadow(0 3px 6px rgba(0,0,0,0.12)) drop-shadow(0 9px 28px rgba(0,0,0,0.05))',
};

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
    ...ANTD_V5_SHADOWS,
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
    Select: {
      optionSelectedBg: '#f3f4f6',
      optionActiveBg: '#f9fafb',
      // antd 6 paints a selected option under the pointer with this token
      // (antd 5 kept optionSelectedBg there).
      controlItemBgActiveHover: '#f3f4f6',
      optionSelectedFontWeight: 600,
      // antd 6 rings a focused borderless control; antd 5 drew nothing. Only
      // the borderless variant reads this token.
      lineWidthFocus: 0,
    },
    Input: {
      hoverBorderColor: '#d1d5db',
      activeBorderColor: '#9ca3af',
      activeShadow: 'none',
      lineWidthFocus: 0,
    },
    InputNumber: {
      lineWidthFocus: 0,
    },
    DatePicker: {
      lineWidthFocus: 0,
    },
    // Space.Addon, antd 6's replacement for input addons: antd 5's addon
    // background (Input addonBg, colorFillAlter) and 11px padding.
    Addon: {
      colorBgContainerDisabled: 'rgba(20, 21, 26, 0.02)',
      paddingSM: 11,
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
