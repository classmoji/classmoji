import { createCookie } from 'react-router';

// Cookie configuration - domain set for cross-subdomain sharing in production
// This allows cookies to be shared between app.classmoji.io and slides.classmoji.io
const cookieOptions =
  process.env.NODE_ENV === 'production'
    ? {
        path: '/',
        domain: '.classmoji.io',
        secure: true,
        sameSite: 'lax',
        httpOnly: true,
      }
    : {
      path: '/',
        httpOnly: true,
      };

// NOTE: userCookie is only kept for test helpers compatibility.
// App code now uses BetterAuth via @classmoji/auth package.
// This can be removed once tests are migrated to BetterAuth sessions.
export const userCookie = createCookie('user-auth', cookieOptions);
