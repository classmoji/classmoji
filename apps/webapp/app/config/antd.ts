import { BRAND, BRAND_LIGHT, BRAND_BG, PRIMARY, PRIMARY_600 } from './theme.js';

const theme = {
  token: {
    colorPrimary: PRIMARY,
    colorTextBase: '#2b2d35', // ink-1
    colorBgSolidActive: BRAND,
    colorBorder: '#dfe4ee', // line
    borderRadius: 8,
  },
  components: {
    Button: {
      algorithm: true,
      colorPrimary: PRIMARY,
      colorPrimaryHover: PRIMARY_600,
      colorTextLightSolid: '#ffffff',
      defaultBg: '#ffffff',
      defaultColor: '#14151a',
      defaultBorderColor: '#c9d0de',
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
    FloatButton: {
      colorPrimary: BRAND,
      colorBgElevated: BRAND,
      colorText: '#000000',
      colorTextLightSolid: '#000000',
    },
  },
};

export default theme;
