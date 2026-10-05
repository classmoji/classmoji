import React from 'react';
import type { ReactNode } from 'react';
import { ConfigProvider } from 'antd';
import type { ThemeConfig } from 'antd';

/**
 * The webapp's Ant Design theme (apps/webapp/app/config/antd.ts, with the
 * default accent the root layout applies), so mockup tables, tags and buttons
 * render exactly like the product's.
 */
const ACCENT = '#21883d';

export const APP_ANTD_THEME: ThemeConfig = {
  token: {
    colorPrimary: ACCENT,
    colorTextBase: '#14151a',
    colorLink: '#2b2d35',
    colorLinkHover: '#14151a',
    colorLinkActive: '#14151a',
    fontFamily:
      "'Mona Sans Variable', 'Mona Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
  },
  components: {
    Button: {
      colorPrimary: ACCENT,
      colorPrimaryHover: ACCENT,
      colorPrimaryActive: ACCENT,
      colorTextLightSolid: '#ffffff',
      defaultBg: '#F7F8FA',
      defaultColor: '#000000',
      defaultBorderColor: '#D2D9E0',
      primaryShadow: 'none',
      defaultShadow: 'none',
    },
    Table: { headerBg: '#ffffff', rowHoverBg: '#fafafa' },
    Input: { hoverBorderColor: '#d1d5db', activeBorderColor: '#9ca3af', activeShadow: 'none' },
  },
};

export function AppAntd({ children }: { children: ReactNode }) {
  return <ConfigProvider theme={APP_ANTD_THEME}>{children}</ConfigProvider>;
}
