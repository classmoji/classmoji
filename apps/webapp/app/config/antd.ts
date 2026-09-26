import { BRAND, BRAND_LIGHT, BRAND_BG, PRIMARY, PRIMARY_600 } from './theme.ts';

// Keep in sync with --font-sans in styles/tailwind.css & global.css. Ant Design
// components don't inherit the body font; without this token they fall back to
// Ant's default system stack (-apple-system, ...), so the UI renders in the OS
// font instead of Mona Sans.
const FONT_SANS =
  "'Mona Sans Variable', 'Mona Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

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
    Tag: {
      bordered: false,
    },
    Progress: {
      defaultColor: BRAND_LIGHT,
      colorSuccess: BRAND,
    },
    Select: {
      optionSelectedBg: '#f3f4f6',
      optionActiveBg: '#f9fafb',
      optionSelectedFontWeight: 600,
    },
    Input: {
      hoverBorderColor: '#d1d5db',
      activeBorderColor: '#9ca3af',
      activeShadow: 'none',
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
