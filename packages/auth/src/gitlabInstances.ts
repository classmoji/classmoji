/**
 * Sign-in with a self-managed GitLab.
 *
 * better-auth's providers are fixed at boot, but instances are rows added at
 * runtime (each with its own OAuth application), so this plugin resolves the
 * OAuth client per request. gitlab.com, the default instance, stays on
 * better-auth's built-in `gitlab` provider.
 *
 * Endpoints (under /api/auth):
 *  - POST /gitlab-instance/sign-in  { instanceId, callbackURL, errorCallbackURL }
 *  - POST /gitlab-instance/setup    { host, clientId, clientSecret, callbackURL, errorCallbackURL }
 *    Registers a new instance. Nothing is stored until the OAuth round trip
 *    with those credentials succeeds, which proves they work and that the
 *    person has an account there; setup is their first sign-in.
 *  - POST /gitlab-instance/link     { instanceId, callbackURL, errorCallbackURL }
 *    Connects a self-managed GitLab account to the SIGNED-IN user ("Connect
 *    Gitlab" in settings). A user has at most one GitLab account.
 *  - GET  /gitlab-instance/callback  The redirect URI registered on every
 *    instance's application. Which instance it is comes from the OAuth state.
 *
 * Accounts use provider id `gitlab`, like gitlab.com ones, with the instance
 * in the account id (`<instance id>:<gitlab user id>`; see scopeGitlabId).
 */

import { APIError, createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
// eslint's resolver misses these subpath exports; TypeScript resolves them.
// eslint-disable-next-line import/no-unresolved
import { setSessionCookie } from 'better-auth/cookies';
/* eslint-disable import/no-unresolved */
import {
  createAuthorizationURL,
  generateState,
  handleOAuthUserInfo,
  parseState,
  setTokenUtil,
  validateAuthorizationCode,
} from 'better-auth/oauth2';
/* eslint-enable import/no-unresolved */
import type { BetterAuthPlugin } from 'better-auth';
import * as z from 'zod';
import getPrisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import { scopeGitlabId } from '@classmoji/utils';
import { mapGitLabProfile } from './providerProfile.ts';

export const GITLAB_INSTANCE_CALLBACK_PATH = '/gitlab-instance/callback';

/** Sign-in asks only for identity; "Connect Gitlab" asks for the rest. */
const SIGN_IN_SCOPES = ['read_user'];

interface GitLabProfile {
  id: number;
  username: string;
  name?: string | null;
  email?: string | null;
  public_email?: string | null;
  avatar_url?: string | null;
  state?: string;
  locked?: boolean;
  confirmed_at?: string | null;
}

/** What rides in the OAuth state for a setup round trip (secret encrypted). */
interface PendingSetup {
  host: string;
  clientId: string;
  clientSecret: string;
}

const redirectBody = {
  callbackURL: z.string().optional(),
  errorCallbackURL: z.string().optional(),
};

const svc = () => ClassmojiService.gitlabInstance;

/** An authorize URL on `host`, with state saved the way better-auth's own flows do. */
async function authorizeUrl(
  ctx: Parameters<typeof generateState>[0],
  client: { host: string; clientId: string; clientSecret: string },
  additionalData: Record<string, unknown>,
  link?: { email: string; userId: string }
) {
  const { state, codeVerifier } = await generateState(ctx, link, additionalData);
  const url = await createAuthorizationURL({
    id: 'gitlab',
    options: { clientId: client.clientId, clientSecret: client.clientSecret },
    authorizationEndpoint: `${client.host}/oauth/authorize`,
    redirectURI: `${ctx.context.baseURL}${GITLAB_INSTANCE_CALLBACK_PATH}`,
    state,
    codeVerifier,
    scopes: SIGN_IN_SCOPES,
  });
  return url.toString();
}

function refuse(error: unknown): never {
  const message = error instanceof Error ? error.message : 'Gitlab sign-in failed';
  throw new APIError('BAD_REQUEST', { message });
}

export const gitlabInstances = () =>
  ({
    id: 'gitlab-instances',
    endpoints: {
      signInGitlabInstance: createAuthEndpoint(
        '/gitlab-instance/sign-in',
        {
          method: 'POST',
          body: z.object({ instanceId: z.string().min(1), ...redirectBody }),
        },
        async ctx => {
          let client;
          try {
            client = await svc().oauthClient(ctx.body.instanceId);
          } catch (error: unknown) {
            refuse(error);
          }
          const url = await authorizeUrl(ctx, client, {
            gitlabInstanceId: client.instanceId,
          });
          return ctx.json({ url, redirect: true });
        }
      ),

      linkGitlabInstance: createAuthEndpoint(
        '/gitlab-instance/link',
        {
          method: 'POST',
          body: z.object({ instanceId: z.string().min(1), ...redirectBody }),
          use: [sessionMiddleware],
        },
        async ctx => {
          const { user } = ctx.context.session;
          // One GitLab account per user: its instance decides which GitLab
          // their classrooms and connection live on.
          const accounts = await ctx.context.internalAdapter.findAccounts(user.id);
          if (accounts.some(a => a.providerId === 'gitlab')) {
            throw new APIError('BAD_REQUEST', {
              message: 'This account already has a Gitlab account connected.',
            });
          }
          let client;
          try {
            client = await svc().oauthClient(ctx.body.instanceId);
          } catch (error: unknown) {
            refuse(error);
          }
          const url = await authorizeUrl(
            ctx,
            client,
            { gitlabInstanceId: client.instanceId },
            { email: user.email, userId: user.id }
          );
          return ctx.json({ url, redirect: true });
        }
      ),

      setupGitlabInstance: createAuthEndpoint(
        '/gitlab-instance/setup',
        {
          method: 'POST',
          body: z.object({
            host: z.string().min(1).max(255),
            clientId: z.string().trim().min(1).max(255),
            clientSecret: z.string().trim().min(1).max(255),
            ...redirectBody,
          }),
        },
        async ctx => {
          let host: string;
          try {
            host = await svc().probe(ctx.body.host);
          } catch (error: unknown) {
            refuse(error);
          }
          if (await svc().findByHost(host)) {
            throw new APIError('BAD_REQUEST', {
              message: `${host} is already set up. Sign in with it instead.`,
            });
          }
          const setup: PendingSetup = {
            host,
            clientId: ctx.body.clientId,
            clientSecret: svc().encryptSecret(ctx.body.clientSecret),
          };
          const url = await authorizeUrl(
            ctx,
            { host, clientId: setup.clientId, clientSecret: ctx.body.clientSecret },
            { gitlabSetup: setup }
          );
          return ctx.json({ url, redirect: true });
        }
      ),

      gitlabInstanceCallback: createAuthEndpoint(
        GITLAB_INSTANCE_CALLBACK_PATH,
        {
          method: 'GET',
          query: z.object({
            code: z.string().optional(),
            error: z.string().optional(),
            error_description: z.string().optional(),
            state: z.string().optional(),
          }),
        },
        async ctx => {
          const state = (await parseState(ctx)) as Awaited<ReturnType<typeof parseState>> & {
            gitlabInstanceId?: string | null;
            gitlabSetup?: PendingSetup;
          };
          const fail = (error: string): never => {
            const base = state.errorURL || `${ctx.context.baseURL}/error`;
            throw ctx.redirect(`${base}${base.includes('?') ? '&' : '?'}error=${error}`);
          };
          if (ctx.query.error || !ctx.query.code) {
            fail(ctx.query.error === 'access_denied' ? 'access_denied' : 'gitlab_error');
          }

          // The OAuth client this round trip started with.
          const setup = state.gitlabSetup;
          let client: { host: string; clientId: string; clientSecret: string };
          let instanceId: string | null;
          if (setup) {
            client = {
              host: setup.host,
              clientId: setup.clientId,
              clientSecret: svc().decryptSecret(setup.clientSecret),
            };
            instanceId = null; // assigned once the instance is stored below
          } else if (state.gitlabInstanceId) {
            try {
              const resolved = await svc().oauthClient(state.gitlabInstanceId);
              client = resolved;
              instanceId = resolved.instanceId;
            } catch {
              return fail('gitlab_instance_unavailable');
            }
          } else {
            return fail('please_restart_the_process');
          }

          let tokens;
          try {
            tokens = await validateAuthorizationCode({
              code: ctx.query.code as string,
              codeVerifier: state.codeVerifier,
              redirectURI: `${ctx.context.baseURL}${GITLAB_INSTANCE_CALLBACK_PATH}`,
              options: { clientId: client.clientId, clientSecret: client.clientSecret },
              tokenEndpoint: `${client.host}/oauth/token`,
            });
          } catch (error: unknown) {
            ctx.context.logger.error('Gitlab code exchange failed', error);
            return fail(setup ? 'gitlab_setup_credentials' : 'oauth_code_verification_failed');
          }

          const response = await fetch(`${client.host}/api/v4/user`, {
            headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: 'application/json' },
          }).catch(() => null);
          const profile = response?.ok ? ((await response.json()) as GitLabProfile) : null;
          if (!profile || profile.state !== 'active' || profile.locked) {
            return fail('user_info_is_missing');
          }
          const email = (profile.email || profile.public_email || '').toLowerCase();
          // Sign-in needs an email for the new user; linking an existing one doesn't.
          if (!email && !state.link) return fail('email_is_missing');

          // Setup: the credentials just worked, so the instance is real.
          if (setup) {
            try {
              const created = await svc().create({
                host: setup.host,
                clientId: setup.clientId,
                clientSecret: client.clientSecret,
                createdByUserId: null,
              });
              instanceId = created.id;
            } catch (error: unknown) {
              // Someone else finished setting it up first: use theirs.
              const existing = await svc().findByHost(setup.host);
              if (!existing?.id) {
                ctx.context.logger.error('Gitlab instance setup failed', error);
                return fail('gitlab_setup_failed');
              }
              instanceId = existing.id;
            }
          }

          const accountId = scopeGitlabId(instanceId, profile.id);
          const mapped = await mapGitLabProfile(getPrisma(), profile, instanceId);

          // "Connect Gitlab" from settings: attach this GitLab account to the
          // signed-in user who started the round trip, instead of signing in.
          if (state.link) {
            const adapter = ctx.context.internalAdapter;
            const existing = await adapter.findAccountByProviderId(accountId, 'gitlab');
            if (existing && existing.userId !== state.link.userId) {
              return fail('account_already_linked_to_different_user');
            }
            const own = await adapter.findAccounts(state.link.userId);
            if (own.some(a => a.providerId === 'gitlab' && a.accountId !== accountId)) {
              return fail('gitlab_already_connected');
            }
            const tokenFields = {
              accessToken: await setTokenUtil(tokens.accessToken, ctx.context),
              refreshToken: await setTokenUtil(tokens.refreshToken, ctx.context),
              accessTokenExpiresAt: tokens.accessTokenExpiresAt,
              scope: tokens.scopes?.join(','),
            };
            if (existing) {
              await adapter.updateAccount(existing.id, tokenFields);
            } else {
              await adapter.createAccount({
                userId: state.link.userId,
                providerId: 'gitlab',
                accountId,
                ...tokenFields,
              });
            }
            throw ctx.redirect(new URL(state.callbackURL, ctx.context.baseURL).toString());
          }

          const result = await handleOAuthUserInfo(ctx, {
            userInfo: {
              id: accountId,
              email,
              name: profile.name || profile.username,
              image: profile.avatar_url ?? undefined,
              emailVerified: Boolean(profile.confirmed_at),
              ...mapped,
            },
            account: {
              providerId: 'gitlab',
              accountId,
              ...tokens,
              scope: tokens.scopes?.join(','),
            },
            callbackURL: state.callbackURL,
          });
          if (result.error || !result.data) {
            return fail(
              String(result.error ?? 'unable_to_sign_in')
                .split(' ')
                .join('_')
            );
          }

          if (setup && instanceId) {
            await getPrisma()
              .gitLabInstance.updateMany({
                where: { id: instanceId, created_by_user_id: null },
                data: { created_by_user_id: result.data.user.id },
              })
              .catch(() => {});
          }

          await setSessionCookie(ctx, result.data);
          const next = new URL(state.callbackURL, ctx.context.baseURL);
          if (setup) next.searchParams.set('gitlab_setup', 'done');
          throw ctx.redirect(next.toString());
        }
      ),
    },
  }) satisfies BetterAuthPlugin;
