import { BRAND, BRAND_LIGHT, BRAND_BG, PRIMARY, PRIMARY_600, SECONDARY } from './theme.js';

const theme = {
  token: {
    colorPrimary: PRIMARY,
    colorTextBase: '#374151', // Softer dark gray text
    colorBgSolidActive: BRAND,
  },
  components: {
    Button: {
      algorithm: true,
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
    FloatButton: {
      colorPrimary: BRAND,
      colorBgElevated: BRAND,
      colorText: '#000000',
      colorTextLightSolid: '#000000',
    },
  },
};

export default theme;
