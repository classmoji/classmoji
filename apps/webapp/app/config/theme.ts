/**
 * Central Theme Configuration
 *
 * These values are used for JavaScript contexts (Ant Design, inline styles).
 * For Tailwind classes, use: bg-primary-500, text-primary-600, etc.
 *
 * To change the brand color, update BOTH:
 * 1. This file (for JS/Ant Design)
 * 2. tailwind.css @theme section (for Tailwind classes)
 *
 * Current: Pastel Violet
 */

// ============================================
// PRIMARY COLOR - Pastel Violet (Classmoji accent)
// ============================================
export const PRIMARY_50 = '#ece9ff';
export const PRIMARY_100 = '#dedaff';
export const PRIMARY_200 = '#c8c0ff';
export const PRIMARY_300 = '#a89cff';
export const PRIMARY_400 = '#8a7afd';
export const PRIMARY_500 = '#6d5efc';
export const PRIMARY_600 = '#5a4cf0';
export const PRIMARY_700 = '#4a3fbb';
export const PRIMARY_800 = '#3a3197';
export const PRIMARY_900 = '#2a2470';

// ============================================
// SECONDARY COLOR PALETTE - Pastel Rose
// ============================================
export const SECONDARY_50 = '#fde5ea';
export const SECONDARY_100 = '#f5c5d0';
export const SECONDARY_400 = '#e89bb0';
export const SECONDARY_500 = '#d36a85';
export const SECONDARY_600 = '#9a1f3a';

// Legacy BRAND aliases (for backwards compatibility)
export const BRAND_50 = PRIMARY_50;
export const BRAND_100 = PRIMARY_100;
export const BRAND_400 = PRIMARY_400;
export const BRAND_500 = PRIMARY_500;
export const BRAND_600 = PRIMARY_600;
export const BRAND_700 = PRIMARY_700;
export const BRAND_800 = PRIMARY_800;
export const BRAND_900 = PRIMARY_900;

// Convenience aliases
export const PRIMARY = PRIMARY_500;
export const PRIMARY_LIGHT = PRIMARY_400;
export const PRIMARY_DARK = PRIMARY_600;
export const PRIMARY_BG = PRIMARY_100;
export const SECONDARY = SECONDARY_500;

// Legacy aliases
export const BRAND = PRIMARY;
export const BRAND_LIGHT = PRIMARY_LIGHT;
export const BRAND_DARK = PRIMARY_DARK;
export const BRAND_BG = PRIMARY_BG;
export const BRAND_TEXT = '#ffffff';
export const SIDEBAR_ACTIVE_BG = PRIMARY_100;
export const SIDEBAR_ACTIVE_TEXT = PRIMARY_700;

export default {
  // Primary (Apple Green)
  PRIMARY,
  PRIMARY_50,
  PRIMARY_100,
  PRIMARY_200,
  PRIMARY_300,
  PRIMARY_400,
  PRIMARY_500,
  PRIMARY_600,
  PRIMARY_700,
  PRIMARY_800,
  PRIMARY_900,
  PRIMARY_LIGHT,
  PRIMARY_DARK,
  PRIMARY_BG,
  // Secondary (Apple Red)
  SECONDARY,
  SECONDARY_50,
  SECONDARY_100,
  SECONDARY_400,
  SECONDARY_500,
  SECONDARY_600,
  // Legacy BRAND aliases
  BRAND,
  BRAND_50,
  BRAND_100,
  BRAND_400,
  BRAND_500,
  BRAND_600,
  BRAND_700,
  BRAND_800,
  BRAND_900,
  BRAND_LIGHT,
  BRAND_DARK,
  BRAND_BG,
  BRAND_TEXT,
  SIDEBAR_ACTIVE_BG,
  SIDEBAR_ACTIVE_TEXT,
};
