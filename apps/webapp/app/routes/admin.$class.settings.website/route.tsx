import { useEffect, useRef, useState } from 'react';
import { useFetcher, useParams } from 'react-router';
import { Button, Input, Popconfirm, Select, Switch, Tooltip } from 'antd';
import { IconExternalLink } from '@tabler/icons-react';
import { namedAction } from 'remix-utils/named-action';

import { ClassmojiService } from '@classmoji/services';
import { SettingSection } from '~/components';
import { assertClassroomAccess, assertClassroomMutationAllowed } from '~/utils/helpers';
import { resolveSiteOrigin } from '../site-return/siteReturn.ts';
import {
  canToggleSiteEnabled,
  homePageNotice,
  suggestSubdomainFromSlug,
  type SitePageOption,
} from './siteSettings.ts';
import type { SubdomainAvailabilityResponse } from '../api.site.availability/availability.ts';
import type { Route } from './+types/route';

/**
 * Class Settings › Website — where an instructor turns the public course site
 * on.
 *
 * Four rows, forever: claim a subdomain, pick a home page, publish the
 * schedule, remove the site. Navigation is authored inside pages (the Page
 * directory block), so this tab never grows with the course.
 *
 * Every rule it enforces is enforced again in site.service — the switch is
 * disabled without a home page AND upsertSiteSettings refuses to enable
 * without one. That duplication is the point: the disabled switch explains
 * itself before the click, the service check is the one that is true for
 * every caller including the MCP tools.
 */

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  // OWNER only, matching every other Settings tab.
  const { classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER'],
    resourceType: 'SITE_SETTINGS',
    attemptedAction: 'view',
  });

  const row = await ClassmojiService.site.getSiteForClassroom(classroom.id);

  // Only the four fields the form reads. The row also carries timestamps and
  // ids that nothing here renders.
  const site = row
    ? {
        subdomain: row.subdomain,
        is_enabled: row.is_enabled,
        home_page_id: row.home_page_id,
        show_schedule: row.show_schedule,
      }
    : null;

  // Drafts are excluded rather than shown-and-rejected: a draft can never be a
  // home page (HOME_PAGE_INVALID), so offering one would be a trap.
  const pages = await ClassmojiService.page.findByClassroomId(classroom.id, {
    includeCreator: false,
  });
  const pageOptions: SitePageOption[] = pages
    .filter(page => !page.is_draft)
    .map(page => ({ id: page.id, title: page.title, is_public: page.is_public }))
    .sort((a, b) => a.title.localeCompare(b.title));

  // Two different things, on purpose. The SUFFIX is cosmetic — it tells the
  // instructor what their address will look like, so an unconfigured local
  // environment can still show the real product domain. The ORIGIN is a link
  // we are about to hand a browser, so it comes from resolveSiteOrigin, which
  // fails closed to null when SITE_BASE_DOMAIN is unset or malformed.
  const baseDomain = (process.env.SITE_BASE_DOMAIN ?? '').trim().toLowerCase() || 'classmoji.io';
  const siteOrigin = site ? resolveSiteOrigin(site.subdomain, process.env) : null;

  return {
    site,
    pageOptions,
    baseDomain,
    siteOrigin,
    suggestedSubdomain: site ? '' : suggestSubdomainFromSlug(classroom.slug),
  };
};

/**
 * Every rejection this service raises carries a machine-readable `code`; pass
 * it through so the form can put the message next to the control that caused
 * it instead of toasting it.
 *
 * Matched on `name`, not on the presence of a `code` field — Prisma errors
 * have a `code` too, and a P2002 rendered as an inline hint would be nonsense.
 */
const siteErrorPayload = (error: unknown): { error: string; code: string } | null => {
  if (!(error instanceof Error) || error.name !== 'SiteError') return null;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === 'string' ? { error: error.message, code } : null;
};

const unexpected = (context: string, error: unknown) => {
  console.error(`Website settings ${context} failed:`, error);
  return { error: 'Something went wrong. Please try again.' };
};

export const action = async ({ params, request }: Route.ActionArgs) => {
  const classSlug = params.class!;

  const { classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER'],
    resourceType: 'SITE_SETTINGS',
    attemptedAction: 'modify',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  const data = (await request.json()) as {
    subdomain?: string;
    is_enabled?: boolean;
    home_page_id?: string | null;
    show_schedule?: boolean;
  };

  // Named via `?/action` in the URL, so reading the JSON body above does not
  // consume what namedAction needs.
  return namedAction(request, {
    async claimSubdomain() {
      try {
        const site = await ClassmojiService.site.validateAndClaimSubdomain(
          classroom.id,
          data.subdomain ?? ''
        );
        return { success: `Claimed ${site.subdomain}` };
      } catch (error: unknown) {
        return siteErrorPayload(error) ?? unexpected('claim', error);
      }
    },

    async saveSettings() {
      try {
        // Only the keys actually submitted reach the service — `undefined`
        // means "leave it alone", and each control submits one key.
        await ClassmojiService.site.upsertSiteSettings(classroom.id, {
          ...(data.is_enabled === undefined ? {} : { is_enabled: data.is_enabled }),
          ...(data.home_page_id === undefined ? {} : { home_page_id: data.home_page_id }),
          ...(data.show_schedule === undefined ? {} : { show_schedule: data.show_schedule }),
        });
        return { success: 'Website settings updated' };
      } catch (error: unknown) {
        return siteErrorPayload(error) ?? unexpected('save', error);
      }
    },

    async removeSite() {
      try {
        const removed = await ClassmojiService.site.deleteSiteForClassroom(classroom.id);
        return { success: `Site removed — ${removed.subdomain} is free again` };
      } catch (error: unknown) {
        return siteErrorPayload(error) ?? unexpected('remove', error);
      }
    },
  });
};

type ActionResult = { success?: string; error?: string; code?: string };

/** Inline, red, under the control that caused it. Never a toast. */
const RowError = ({ fetcher }: { fetcher: { state: string; data?: ActionResult } }) =>
  fetcher.state === 'idle' && fetcher.data?.error ? (
    <div className="pt-2 text-sm text-red-600 dark:text-red-400">{fetcher.data.error}</div>
  ) : null;

const SettingsWebsite = ({ loaderData }: Route.ComponentProps) => {
  const { site, pageOptions, baseDomain, siteOrigin, suggestedSubdomain } = loaderData;
  const { class: classSlug } = useParams();

  const actionUrl = (name: string) => `/admin/${classSlug}/settings/website?/${name}`;

  // A local fetcher per control, not the shared global one. The global fetcher
  // consumes `data` the moment it enters `loading` and self-resets to null, so
  // the submitting route never sees the payload — and this tab's whole error
  // story is reading HOME_PAGE_REQUIRED / HOME_PAGE_INVALID back out of it.
  // Separate fetchers also keep each row's spinner on its own row.
  const claimFetcher = useFetcher<ActionResult>();
  const enableFetcher = useFetcher<ActionResult>();
  const homePageFetcher = useFetcher<ActionResult>();
  const scheduleFetcher = useFetcher<ActionResult>();
  const removeFetcher = useFetcher<ActionResult>();
  const availabilityFetcher = useFetcher<SubdomainAvailabilityResponse>();

  const [editing, setEditing] = useState(!site);
  const [subdomain, setSubdomain] = useState(site?.subdomain ?? suggestedSubdomain);

  // The loader's site row can appear (Claim), change (re-Claim) or VANISH
  // (Remove) without this component ever unmounting, so the useState initial
  // values above are set exactly once and then go stale. Removing the site used
  // to leave `editing` false with `site` null, and the read-only branch read
  // `site!.subdomain` straight into an error boundary.
  //
  // Keyed on the claimed label rather than on the row's identity: that is the
  // only part of it this local state mirrors, and it changes on all three
  // transitions. Local edits in progress are preserved, because a keystroke
  // does not change what the DB holds.
  const claimed = site?.subdomain ?? null;
  const lastClaimedRef = useRef<string | null>(claimed);
  useEffect(() => {
    if (lastClaimedRef.current === claimed) return;
    lastClaimedRef.current = claimed;
    setSubdomain(claimed ?? suggestedSubdomain);
    setEditing(!claimed);
  }, [claimed, suggestedSubdomain]);

  const typed = subdomain.trim().toLowerCase();

  // Debounced availability check, 400ms after the last keystroke. The ref keeps
  // the badge from describing a label the box no longer holds.
  const lastQueriedRef = useRef<string>('');
  useEffect(() => {
    if (!editing || !typed) return;
    const handle = setTimeout(() => {
      lastQueriedRef.current = typed;
      const params = new URLSearchParams({ subdomain: typed, class: classSlug ?? '' });
      availabilityFetcher.load(`/api/site/availability?${params.toString()}`);
    }, 400);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed, editing, classSlug]);

  // Leave edit mode once the claim lands; the loader has revalidated by then,
  // so the read-only text below renders the subdomain the DB actually holds.
  useEffect(() => {
    if (claimFetcher.state === 'idle' && claimFetcher.data?.success) setEditing(false);
  }, [claimFetcher.state, claimFetcher.data]);

  const availability =
    availabilityFetcher.state === 'idle' && lastQueriedRef.current === typed
      ? availabilityFetcher.data
      : undefined;
  const claimable = Boolean(availability?.subdomain_available) && claimFetcher.state === 'idle';

  const claim = () =>
    claimFetcher.submit(JSON.stringify({ subdomain: typed }), {
      method: 'post',
      action: actionUrl('claimSubdomain'),
      encType: 'application/json',
    });

  const saveSetting = (
    fetcher: ReturnType<typeof useFetcher<ActionResult>>,
    patch: Record<string, unknown>
  ) =>
    fetcher.submit(JSON.stringify(patch), {
      method: 'post',
      action: actionUrl('saveSettings'),
      encType: 'application/json',
    });

  const removeSite = () =>
    removeFetcher.submit(JSON.stringify({}), {
      method: 'post',
      action: actionUrl('removeSite'),
      encType: 'application/json',
    });

  const enableAllowed = canToggleSiteEnabled(site);
  const notice = homePageNotice(pageOptions, site?.home_page_id);
  // No site yet: rows 2-4 have nothing to act on. Dimmed and disabled rather
  // than hidden, so the shape of the tab does not change when you claim.
  const dimmed = site ? '' : 'opacity-50';

  const statusTone: Record<string, string> = {
    available: 'text-green-600 dark:text-green-400',
    taken: 'text-red-600 dark:text-red-400',
    reserved: 'text-red-600 dark:text-red-400',
    invalid: 'text-amber-600 dark:text-amber-400',
  };

  return (
    <div className="divide-y divide-line">
      {/* Row 1 — the subdomain, and the switch that puts it on the web. */}
      <SettingSection
        title="Course Website"
        description="Publish your pages as a course website on your own subdomain."
      >
        {/* `|| !site` is belt to the effect's braces: there is no arrangement
            of state in which the read-only branch can be reached without a row
            to read. */}
        {editing || !site ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Input
                value={subdomain}
                onChange={event => setSubdomain(event.target.value)}
                onPressEnter={() => claimable && claim()}
                addonAfter={`.${baseDomain}`}
                placeholder="cs52"
                aria-label="Subdomain"
                className="max-w-sm"
              />
              {availability && availability.status !== 'empty' && (
                <span className={`text-sm font-medium ${statusTone[availability.status] ?? ''}`}>
                  {availability.status === 'available'
                    ? `${availability.message} ✓`
                    : availability.message}
                </span>
              )}
              <Button
                type="primary"
                disabled={!claimable}
                loading={claimFetcher.state !== 'idle'}
                onClick={claim}
              >
                Claim
              </Button>
              {site && (
                <Button
                  type="text"
                  onClick={() => {
                    setSubdomain(site.subdomain);
                    setEditing(false);
                  }}
                >
                  Cancel
                </Button>
              )}
            </div>
            <div className="pt-2 text-sm text-ink-3">
              Pre-filled from your class URL — shorten it to something evergreen like{' '}
              <span className="font-medium text-ink-2">cs52</span> if the URL should outlive the
              term.
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono text-base text-ink-0">
                {site!.subdomain}
                <span className="text-ink-3">.{baseDomain}</span>
              </span>
              <Button size="small" onClick={() => setEditing(true)}>
                Change
              </Button>
            </div>
            <div className="pt-2 text-sm text-ink-3">
              {siteOrigin ? (
                <>
                  Your site lives at <span className="font-mono text-ink-2">{siteOrigin}</span>
                </>
              ) : (
                'Course sites are not configured on this environment yet.'
              )}
            </div>
          </>
        )}
        <RowError fetcher={claimFetcher} />

        <div className="flex flex-wrap items-center gap-3 pt-4">
          <Tooltip title={enableAllowed ? '' : 'Choose a home page first'}>
            <span className="inline-flex items-center gap-2">
              <Switch
                checked={Boolean(site?.is_enabled)}
                disabled={!enableAllowed}
                loading={enableFetcher.state !== 'idle'}
                onChange={checked => saveSetting(enableFetcher, { is_enabled: checked })}
                aria-label="Website enabled"
              />
              <span className="text-sm text-ink-2">Website enabled</span>
            </span>
          </Tooltip>

          {site?.is_enabled && siteOrigin && (
            <Button
              size="small"
              href={siteOrigin}
              target="_blank"
              rel="noopener noreferrer"
              icon={<IconExternalLink size={14} />}
            >
              View live site
            </Button>
          )}
        </div>
        {!enableAllowed && site && (
          <div className="pt-2 text-sm text-ink-3">Choose a home page first.</div>
        )}
        <RowError fetcher={enableFetcher} />
      </SettingSection>

      {/* Row 2 — what anonymous visitors land on. */}
      <SettingSection title="Home page" description="Served at the root of your site.">
        <div className={dimmed}>
          <Select
            className="w-full max-w-sm"
            value={site?.home_page_id ?? undefined}
            disabled={!site}
            loading={homePageFetcher.state !== 'idle'}
            placeholder="Choose a page"
            showSearch
            allowClear
            optionFilterProp="label"
            aria-label="Home page"
            onChange={value => saveSetting(homePageFetcher, { home_page_id: value ?? null })}
            options={pageOptions.map(page => ({ value: page.id, label: page.title }))}
            notFoundContent="No published pages yet"
          />
          {notice && <div className="pt-2 text-sm text-ink-3">{notice}</div>}
          <RowError fetcher={homePageFetcher} />
        </div>
      </SettingSection>

      {/* Row 3 — the calendar, as a public page. */}
      <SettingSection
        title="Public schedule"
        description="Publish the course calendar as a schedule page on the site."
      >
        <div className={dimmed}>
          <div className="flex items-center gap-2">
            <Switch
              checked={Boolean(site?.show_schedule)}
              disabled={!site}
              loading={scheduleFetcher.state !== 'idle'}
              onChange={checked => saveSetting(scheduleFetcher, { show_schedule: checked })}
              aria-label="Publish the course schedule"
            />
            <span className="text-sm text-ink-2">Publish the course schedule</span>
          </div>
          <div className="pt-2 text-sm text-ink-3">
            Modules marked <span className="font-medium text-ink-2">Public</span> appear at{' '}
            <span className="font-mono text-ink-2">/schedule</span>. Draft and members-only modules
            stay hidden.
          </div>
          <RowError fetcher={scheduleFetcher} />
        </div>
      </SettingSection>

      {/* Row 4 — giving the name back. */}
      <SettingSection
        title="Remove site"
        description="Takes the site offline and frees the subdomain for another class."
      >
        <div className={dimmed}>
          <div className="rounded-lg border border-red-200 p-4 dark:border-red-900/60">
            <p className="pb-3 text-sm text-ink-3">
              Your pages, modules and their visibility settings are kept — only the site and its
              address go.
            </p>
            <Popconfirm
              title="Remove this site?"
              description={
                <span className="block max-w-xs">
                  The site goes offline immediately and its subdomain becomes available to any other
                  class. Your content is not deleted.
                </span>
              }
              okText="Remove site"
              okButtonProps={{ danger: true }}
              cancelText="Cancel"
              disabled={!site}
              onConfirm={removeSite}
            >
              {/* type="primary" danger, exactly as the Danger Zone tab does it.
                  A plain `danger` button takes the outlined variant, whose dark
                  background resolves to the app's green accent — red text on a
                  green fill. Solid is both the readable option and the one that
                  matches the destructive-action language elsewhere. */}
              <Button
                type="primary"
                danger
                disabled={!site}
                loading={removeFetcher.state !== 'idle'}
              >
                Remove (frees the subdomain)
              </Button>
            </Popconfirm>
            <RowError fetcher={removeFetcher} />
          </div>
        </div>
      </SettingSection>
    </div>
  );
};

export default SettingsWebsite;
