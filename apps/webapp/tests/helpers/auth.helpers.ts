import { Cookie } from '@playwright/test';
import { TEST_USER, TEST_ORG, ROLE_TEST_USERS, TestRole } from './env.helpers';
// Import the actual cookie from the app to use correct serialization
import { userCookie } from '../../app/utils/cookies.js';

export interface TestUser {
  id: string;
  login: string;
  role: 'OWNER' | 'ASSISTANT' | 'STUDENT';
  token: string;
  expiresAt: string;
}

/**
 * Get the token for a specific role from environment variables.
 * Throws if the required token is not set.
 */
function getTokenForRole(role: TestRole): string {
  const roleConfig = ROLE_TEST_USERS[role];
  const token = process.env[roleConfig.tokenEnvVar];

  if (!token) {
    throw new Error(
      `${roleConfig.tokenEnvVar} is not set. ` +
        `Required for ${role} role tests. ` +
        `Add it to your .env file.`
    );
  }

  return token;
}

/**
 * Test users for each role.
 * Each role uses a different GitHub user for realistic permission testing.
 *
 * Required env vars:
 * - GITHUB_PROF_TOKEN: Token for admin/owner user
 * - GITHUB_TA_TOKEN: Token for TA/assistant user
 * - GITHUB_STUDENT_TOKEN: Token for student user
 *
 * Optional (to use different GitHub accounts per role):
 * - TEST_TA_USER_ID + TEST_TA_USER_LOGIN
 * - TEST_STUDENT_USER_ID + TEST_STUDENT_USER_LOGIN
 */
export const TEST_USERS: Record<TestRole, TestUser> = {
  owner: {
    id: ROLE_TEST_USERS.owner.id,
    login: ROLE_TEST_USERS.owner.login,
    role: 'OWNER',
    token: getTokenForRole('owner'),
    expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(), // 8 hours
  },
  assistant: {
    id: ROLE_TEST_USERS.assistant.id,
    login: ROLE_TEST_USERS.assistant.login,
    role: 'ASSISTANT',
    token: getTokenForRole('assistant'),
    expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
  },
  student: {
    id: ROLE_TEST_USERS.student.id,
    login: ROLE_TEST_USERS.student.login,
    role: 'STUDENT',
    token: getTokenForRole('student'),
    expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
  },
};

/**
 * Create the user-auth cookie using the app's actual cookie serialization
 *
 * This uses React Router's createCookie serialization to ensure the format
 * matches exactly what the app expects.
 *
 * @see apps/webapp/app/utils/cookies.js
 * @see apps/webapp/app/routes/login.callback/route.jsx
 */
export async function createAuthCookieAsync(user: TestUser): Promise<Cookie> {
  // Use the app's cookie serializer to get the correct format
  const setCookieHeader = await userCookie.serialize({
    token: user.token,
    userLogin: user.login,
    userId: user.id,
    expiresAt: user.expiresAt,
    type: 'oauth-user',
    tokenType: 'bearer',
  });

  // Parse the Set-Cookie header to extract the value
  // Format: "user-auth=<value>; Path=/; ..."
  const match = setCookieHeader.match(/^user-auth=([^;]+)/);
  const cookieValue = match ? match[1] : '';

  return {
    name: 'user-auth',
    value: cookieValue,
    domain: 'localhost',
    path: '/',
    httpOnly: false,
    secure: false,
    sameSite: 'Lax',
  };
}

/**
 * Synchronous version for cases where async isn't available
 * Falls back to manual JSON encoding
 */
export function createAuthCookie(user: TestUser): Cookie {
  const cookieValue = JSON.stringify({
    token: user.token,
    userLogin: user.login,
    userId: user.id,
    expiresAt: user.expiresAt,
    type: 'oauth-user',
    tokenType: 'bearer',
  });

  return {
    name: 'user-auth',
    value: encodeURIComponent(cookieValue),
    domain: 'localhost',
    path: '/',
    httpOnly: false,
    secure: false,
    sameSite: 'Lax',
  };
}

/**
 * Decode and parse an auth cookie value
 */
export function parseAuthCookie(cookieValue: string): Partial<TestUser> | null {
  try {
    const decoded = decodeURIComponent(cookieValue);
    const parsed = JSON.parse(decoded);
    return {
      id: parsed.userId,
      login: parsed.userLogin,
      token: parsed.token,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

/**
 * Get the dashboard URL for a specific role
 */
export function getDashboardUrl(role: 'OWNER' | 'ASSISTANT' | 'STUDENT', org: string = TEST_ORG): string {
  switch (role) {
    case 'OWNER':
      return `/admin/${org}/dashboard`;
    case 'ASSISTANT':
      return `/assistant/${org}/dashboard`;
    case 'STUDENT':
      return `/student/${org}/dashboard`;
  }
}

/**
 * Get the base route prefix for a specific role
 */
export function getRoutePrefix(role: 'OWNER' | 'ASSISTANT' | 'STUDENT', org: string = TEST_ORG): string {
  switch (role) {
    case 'OWNER':
      return `/admin/${org}`;
    case 'ASSISTANT':
      return `/assistant/${org}`;
    case 'STUDENT':
      return `/student/${org}`;
  }
}
