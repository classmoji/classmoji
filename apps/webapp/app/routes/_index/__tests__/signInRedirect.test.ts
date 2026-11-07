/**
 * After an email sign-in or a verified code, the sign-in page goes to its
 * callbackURL only when the auth server's answer is not already a redirect
 * the auth client follows by itself (`{ redirect: true, url }`). Otherwise the
 * page would replace the server's choice, e.g. the consent page of an app
 * connection started while signed out.
 */

import { describe, expect, it } from 'vitest';
import { authServerRedirects } from '../signInRedirect';

describe('authServerRedirects', () => {
  it.each([
    ['email sign-in with a callbackURL', { redirect: true, url: '/select-organization' }],
    [
      'an app connection continued on the consent page',
      { redirect: true, url: 'https://classmoji.io/oauth/consent?consent_code=abc' },
    ],
  ])('is true for %s: the client already navigates', (_label, data) => {
    expect(authServerRedirects(data)).toBe(true);
  });

  it.each([
    ['a verified code (status, token, user)', { status: true, token: 't', user: { id: 'u' } }],
    ['a redirect flag with no url', { redirect: true }],
    ['an empty url', { redirect: true, url: '' }],
    ['redirect: false', { redirect: false, url: '/select-organization' }],
    ['a truthy non-boolean flag', { redirect: 'true', url: '/x' }],
    ['a non-string url', { redirect: true, url: 42 }],
    ['a page body rather than an auth response', '<!doctype html><html></html>'],
    ['null', null],
    ['undefined', undefined],
  ])('is false for %s: the page goes to its callbackURL', (_label, data) => {
    expect(authServerRedirects(data)).toBe(false);
  });
});
