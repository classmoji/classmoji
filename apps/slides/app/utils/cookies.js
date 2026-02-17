// Slides app now uses BetterAuth via @classmoji/auth package
// This file is kept for backwards compatibility but auth is handled in root.jsx loader

import { createCookie } from 'react-router';

// Legacy cookie - no longer used but kept for reference
const cookieOptions = process.env.NODE_ENV === 'production'
  ? {
    path: '/',
    domain: '.classmoji.io',
    secure: true,
    sameSite: 'lax',
  }
  : {
    path: '/',
  };

export const userCookie = createCookie('user-auth', cookieOptions);

// Legacy function - no longer used
export const getUserCookie = async request => {
  const cookieHeader = request.headers.get('Cookie');
  return userCookie.parse(cookieHeader);
};
