import React from 'react';
import type { ReactNode } from 'react';
import { ConfigProvider, theme } from 'antd';
import type { ThemeConfig } from 'antd';
import { useIsDark } from '../../hooks/useIsDark';

/**
 * The webapp's Ant Design themes (apps/webapp/app/config/antd.ts and
 * antdDark.ts, with the default accent the root layout applies), so mockup
 * tables, tags and buttons render exactly like the product's.
 */
const ACCENT = '#21883d';
const FONT_SANS =
  "'Mona Sans Variable', 'Mona Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

export const APP_ANTD_THEME: ThemeConfig = {
  token: {
    colorPrimary: ACCENT,
    colorTextBase: '#14151a',
    colorLink: '#2b2d35',
    colorLinkHover: '#14151a',
    colorLinkActive: '#14151a',
    fontFamily: FONT_SANS,
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

/** The dark theme, on the demo's slate panel tokens (panel-dark, line-dark, inkd-*). */
export const APP_ANTD_DARK_THEME: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: ACCENT,
    fontFamily: FONT_SANS,
    colorTextBase: '#f1f2f6',
    colorBgContainer: '#171a25',
    colorBgElevated: '#1e2232',
    colorBorder: '#323648',
    colorBorderSecondary: '#262a38',
    colorText: '#f1f2f6',
    colorTextSecondary: '#a4a9b8',
    colorTextTertiary: '#9398a6',
    colorTextQuaternary: '#767c8c',
    colorLink: '#d9dbe3',
    colorLinkHover: '#f1f2f6',
    colorLinkActive: '#f1f2f6',
  },
  components: {
    Button: {
      colorPrimary: ACCENT,
      colorPrimaryHover: ACCENT,
      colorPrimaryActive: ACCENT,
      colorTextLightSolid: '#ffffff',
      defaultBg: '#1e2232',
      defaultColor: '#f1f2f6',
      defaultBorderColor: '#323648',
      primaryShadow: 'none',
      defaultShadow: 'none',
    },
    Table: {
      headerBg: '#1c2030',
      headerColor: '#d9dbe3',
      rowHoverBg: '#1e2232',
      colorBgContainer: '#171a25',
      borderColor: '#262a38',
    },
    Input: { hoverBorderColor: '#474c62', activeBorderColor: '#5b6178', activeShadow: 'none' },
  },
};

export function AppAntd({ children }: { children: ReactNode }) {
  const isDark = useIsDark();
  return (
    <ConfigProvider theme={isDark ? APP_ANTD_DARK_THEME : APP_ANTD_THEME}>{children}</ConfigProvider>
  );
}
