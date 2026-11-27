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

/**
 * antd 5's shadows, as the webapp pins them (apps/webapp/app/config/antd.ts):
 * antd 6 deepened boxShadowTertiary and turned dark-mode shadows white.
 */
const V5_SHADOW =
  '0 6px 16px 0 rgba(0, 0, 0, 0.08), 0 3px 6px -4px rgba(0, 0, 0, 0.12), 0 9px 28px 8px rgba(0, 0, 0, 0.05)';
const ANTD_V5_SHADOWS = {
  boxShadow: V5_SHADOW,
  boxShadowSecondary: V5_SHADOW,
  boxShadowTertiary:
    '0 1px 2px 0 rgba(0, 0, 0, 0.03), 0 1px 6px -1px rgba(0, 0, 0, 0.02), 0 2px 4px 0 rgba(0, 0, 0, 0.02)',
  boxShadowPopoverArrow: '2px 2px 5px rgba(0, 0, 0, 0.05)',
  boxShadowCard:
    '0 1px 2px -2px rgba(0,0,0,0.16), 0 3px 6px 0 rgba(0,0,0,0.12), 0 5px 12px 4px rgba(0,0,0,0.09)',
  dropShadowPopover:
    'drop-shadow(0 6px 16px rgba(0,0,0,0.08)) drop-shadow(0 3px 6px rgba(0,0,0,0.12)) drop-shadow(0 9px 28px rgba(0,0,0,0.05))',
};

/** The webapp's Tag config: outlined with antd 5's 8px margin (antd 6 fills them). */
const TAG_CONFIG = { variant: 'outlined', styles: { root: { marginInlineEnd: 8 } } } as const;

export const APP_ANTD_THEME: ThemeConfig = {
  token: {
    colorPrimary: ACCENT,
    colorTextBase: '#14151a',
    colorLink: '#2b2d35',
    colorLinkHover: '#14151a',
    colorLinkActive: '#14151a',
    fontFamily: FONT_SANS,
    ...ANTD_V5_SHADOWS,
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
    // antd 6 fills a default Tag with colorFillTertiary (#f6f6f6); antd 5's #fafafa.
    Tag: { defaultBg: '#fafafa' },
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
    ...ANTD_V5_SHADOWS,
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
    <ConfigProvider theme={isDark ? APP_ANTD_DARK_THEME : APP_ANTD_THEME} tag={TAG_CONFIG}>
      {children}
    </ConfigProvider>
  );
}
