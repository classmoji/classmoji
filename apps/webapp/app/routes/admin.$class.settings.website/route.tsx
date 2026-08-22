import { useEffect, useRef, useState } from 'react';
import { Link, useFetcher, useParams } from 'react-router';
import { Button, Input, Popconfirm, Select, Switch, Tooltip } from 'antd';
import { IconCrown, IconExternalLink } from '@tabler/icons-react';
import { namedAction } from 'remix-utils/named-action';

import { ClassmojiService, FlyCertService, isFlyCertsConfigured } from '@classmoji/services';
import { SettingSection } from '~/components';
import {
  assertClassroomAccess,
  assertClassroomMutationAllowed,
  assertProTier,
} from '~/utils/helpers';
import { resolveSiteOrigin } from '../site-return/siteReturn.ts';
import {
  canToggleSiteEnabled,
  homePageNotice,
  suggestSubdomainFromSlug,
  type SitePageOption,
} from './siteSettings.ts';
import {
  canSubmitDomain,
  certChip,
  certErrorNotice,
  checkDomainInput,
  customDomainErrorHint,
  customDomainRowState,
  dnsRows,
  type CertSnapshot,
} from './customDomain.ts';
import type { SubdomainAvailabilityResponse } from '../api.site.availability/availability.ts';
import type { Route } from './+types/route';

/**
 * Class Settings › Website — where an instructor turns the public course site
 * on.
 *
 * Five rows: claim a subdomain, pick a home page, publish the schedule, connect
 * a custom domain (Pro), remove the site. Navigation is authored inside pages
 * (the Page directory block), so this tab never grows with the COURSE — the
 * fifth row is a deliberate exception, added when custom domains shipped,
 * because a domain is a property of the site itself and belongs nowhere else.
 *
 * Every rule it enforces is enforced again in site.service — the switch is
 * disabled without a home page AND upsertSiteSettings refuses to enable
 * without one; the domain row is drawn from the loader's Pro state AND
 * setCustomDomain refuses a non-Pro classroom. That duplication is the point:
 * the disabled control explains itself before the click, the service check is
 * the one that is true for every caller including the MCP tools.
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

  // Only the fields the form reads. The row also carries timestamps and ids
  // that nothing here renders.
  const site = row
    ? {
        subdomain: row.subdomain,
        is_enabled: row.is_enabled,
        home_page_id: row.home_page_id,
        show_schedule: row.show_schedule,
        custom_domain: row.custom_domain,
        custom_domain_verified_at: row.custom_domain_verified_at,
      }
    : null;

  // The CLASSROOM's tier, not the viewer's. Resolved by the same function
  // `setCustomDomain` consults, so the row can never offer an input the save
  // would refuse — and never lock out a co-owner of a classroom whose OTHER
  // owner holds the subscription, which is what asking the viewing user (the
  // `useSubscription` store) would do.
  const { isPro } = await ClassmojiService.subscription.getProStateForClassroomId(classroom.id);

  const flyConfigured = isFlyCertsConfigured();

  // A plain GET, deliberately: `{ check: true }` makes Fly re-resolve DNS and
  // belongs behind the explicit Check status button, not on every page load.
  // Failing soft to null — a Fly outage must not 500 the whole Website tab,
  // and the chip has a state for "we could not read one".
  let cert: CertSnapshot | null = null;
  if (site?.custom_domain && flyConfigured) {
    cert = await readCertSnapshot(site.custom_domain);
  }

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
    isPro,
    flyConfigured,
    cert,
    suggestedSubdomain: site ? '' : suggestSubdomainFromSlug(classroom.slug),
  };
};

/**
 * Narrow a Fly certificate to the four fields the row renders.
 *
 * `FlyCertificate` also carries `raw` — Fly's entire response — which has no
 * business crossing to the browser: it is loader data, so anything on it is
 * serialized into the page, and it grows whenever Fly adds a field.
 */
const narrowCert = (certificate: {
  status: string | null;
  configured: boolean;
  dnsRequirements: Record<string, unknown>;
  validationErrors: unknown[];
}): CertSnapshot => ({
  status: certificate.status,
  configured: certificate.configured,
  dnsRequirements: certificate.dnsRequirements ?? null,
  validationErrors: certificate.validationErrors ?? [],
});

/** Current certificate state, or null when Fly could not tell us. */
const readCertSnapshot = async (
  domain: string,
  options: { check?: boolean } = {}
): Promise<CertSnapshot | null> => {
  try {
    return narrowCert(await FlyCertService.getCertStatus(domain, options));
  } catch (error: unknown) {
    console.error(`Website settings could not read the certificate for ${domain}:`, error);
    return null;
  }
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

/**
 * The FLY_CERT_ERROR code behind a failed certificate call, or 'UPSTREAM'.
 *
 * Matched on `name` for the same reason `siteErrorPayload` is: a `code` field
 * alone would also match Prisma and Node system errors, and rendering an
 * ECONNRESET as certificate advice helps nobody.
 */
const flyErrorCode = (error: unknown): string => {
  if (error instanceof Error && error.name === 'FlyCertError') {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'UPSTREAM';
};

/**
 * Request a certificate for a freshly claimed domain, best-effort.
 *
 * NEVER throws, and the claim it follows is never rolled back. The domain is in
 * the database by the time this runs; a Fly failure means the instructor has a
 * claimed domain awaiting a certificate — retryable from Check status, which
 * calls `addCert` again — rather than a save that appeared to fail and left a
 * row behind anyway.
 */
const provisionCert = async (domain: string): Promise<{ certError?: string }> => {
  if (!isFlyCertsConfigured()) return { certError: 'NOT_CONFIGURED' };
  try {
    await FlyCertService.addCert(domain);
    return {};
  } catch (error: unknown) {
    console.error(`Website settings could not request a certificate for ${domain}:`, error);
    return { certError: flyErrorCode(error) };
  }
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
    custom_domain?: string;
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

    /**
     * Claim a custom domain, then ask for its certificate.
     *
     * Pro is checked here as well as inside `setCustomDomain`. The service check
     * is the one that holds for every caller; this one exists so a lapsed
     * subscription is refused before we touch anything, and is CAUGHT rather
     * than thrown through — `assertProTier` raises a 403 Response, which React
     * Router would hand to the error boundary and replace the whole tab with an
     * error page over a single unavailable row.
     */
    async saveCustomDomain() {
      try {
        await assertProTier(classSlug);
      } catch {
        return {
          error: 'Custom domains require an active Pro subscription.',
          code: 'PRO_REQUIRED',
        };
      }

      try {
        const updated = await ClassmojiService.site.setCustomDomain(
          classroom.id,
          data.custom_domain ?? ''
        );
        const domain = updated.custom_domain!;
        const { certError } = await provisionCert(domain);
        return { success: `Connected ${domain}`, certError };
      } catch (error: unknown) {
        return siteErrorPayload(error) ?? unexpected('custom domain', error);
      }
    },

    /**
     * Re-read the certificate, forcing Fly to re-resolve DNS.
     *
     * The hostname comes from the DATABASE, never from the posted body: this
     * action reaches an external API with it, and a caller-supplied hostname
     * would let an admin of one classroom drive certificate calls for a domain
     * they have not claimed.
     *
     * A missing certificate re-requests one. That is the retry path for a claim
     * whose issuance failed, and `addCert` is idempotent, so pressing the button
     * on a healthy domain costs nothing.
     */
    async checkCustomDomainCert() {
      try {
        const row = await ClassmojiService.site.getSiteForClassroom(classroom.id);
        const domain = row?.custom_domain;
        if (!domain) return { error: 'No custom domain is connected.', code: 'DOMAIN_MISSING' };
        if (!isFlyCertsConfigured()) {
          return { success: 'Checked', certError: 'NOT_CONFIGURED' };
        }

        try {
          const certificate = narrowCert(
            await FlyCertService.getCertStatus(domain, { check: true })
          );
          return { success: `Checked ${domain}`, cert: certificate };
        } catch (error: unknown) {
          const code = flyErrorCode(error);
          if (code !== 'NOT_FOUND') {
            console.error(`Website settings could not check the certificate for ${domain}:`, error);
            return { success: `Checked ${domain}`, certError: code };
          }
          // Claimed, but never successfully provisioned. Ask again.
          const { certError } = await provisionCert(domain);
          return {
            success: certError ? `Checked ${domain}` : `Requested a certificate for ${domain}`,
            certError,
            cert: certError ? undefined : await readCertSnapshot(domain),
          };
        }
      } catch (error: unknown) {
        return siteErrorPayload(error) ?? unexpected('certificate check', error);
      }
    },

    /**
     * Disconnect the custom domain and release its certificate.
     *
     * NOT Pro-gated, matching `clearCustomDomain`. An owner whose subscription
     * lapsed still has a live DNS record pointing at us and must be able to take
     * it down; putting this behind the paywall would strand exactly the person
     * most likely to need it.
     */
    async removeCustomDomain() {
      try {
        const { released } = await ClassmojiService.site.clearCustomDomain(classroom.id);
        return {
          success: released
            ? `Disconnected ${released} — you can remove its DNS records now`
            : 'No custom domain was connected',
        };
      } catch (error: unknown) {
        return siteErrorPayload(error) ?? unexpected('custom domain removal', error);
      }
    },
  });
};

type ActionResult = {
  success?: string;
  error?: string;
  code?: string;
  /** Set when the claim landed but the certificate request did not. */
  certError?: string;
  /** Fresh certificate state from a Check status press. */
  cert?: CertSnapshot;
};

/** Inline, red, under the control that caused it. Never a toast. */
const RowError = ({ fetcher }: { fetcher: { state: string; data?: ActionResult } }) =>
  fetcher.state === 'idle' && fetcher.data?.error ? (
    <div className="pt-2 text-sm text-red-600 dark:text-red-400">{fetcher.data.error}</div>
  ) : null;

/** Tailwind for each chip tone, light and dark. */
const CHIP_TONES: Record<string, string> = {
  active:
    'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 ring-green-600/20 dark:ring-green-400/20',
  issuing:
    'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300 ring-blue-600/20 dark:ring-blue-400/20',
  pending:
    'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 ring-amber-600/20 dark:ring-amber-400/20',
  unknown:
    'bg-gray-100 text-gray-700 dark:bg-neutral-800 dark:text-neutral-300 ring-gray-500/20 dark:ring-neutral-400/20',
  manual:
    'bg-gray-100 text-gray-700 dark:bg-neutral-800 dark:text-neutral-300 ring-gray-500/20 dark:ring-neutral-400/20',
};

/** The Pro badge on the locked row. */
const ProPill = () => (
  <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-amber-600/20 dark:bg-amber-900/40 dark:text-amber-300 dark:ring-amber-400/20">
    <IconCrown size={12} />
    Pro
  </span>
);

const SettingsWebsite = ({ loaderData }: Route.ComponentProps) => {
  const {
    site,
    pageOptions,
    baseDomain,
    siteOrigin,
    suggestedSubdomain,
    isPro,
    flyConfigured,
    cert,
  } = loaderData;
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
  const domainFetcher = useFetcher<ActionResult>();
  const certFetcher = useFetcher<ActionResult>();
  const domainRemoveFetcher = useFetcher<ActionResult>();

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

  // ── Custom domain (row 4) ──────────────────────────────────────────────────
  const claimedDomain = site?.custom_domain ?? null;
  const [editingDomain, setEditingDomain] = useState(false);
  const [domainInput, setDomainInput] = useState(claimedDomain ?? '');

  // Same staleness problem row 1 has, same fix: the loader's domain can appear,
  // change or vanish without this component unmounting, so the useState initial
  // value above is set once and then lies.
  const lastDomainRef = useRef<string | null>(claimedDomain);
  useEffect(() => {
    if (lastDomainRef.current === claimedDomain) return;
    lastDomainRef.current = claimedDomain;
    setDomainInput(claimedDomain ?? '');
    setEditingDomain(false);
  }, [claimedDomain]);

  useEffect(() => {
    if (domainFetcher.state === 'idle' && domainFetcher.data?.success) setEditingDomain(false);
  }, [domainFetcher.state, domainFetcher.data]);

  const domainState = customDomainRowState({ isPro, site });
  const domainVerdict = checkDomainInput(domainInput);
  const domainSubmitting = domainFetcher.state !== 'idle';
  // The Check press returns fresh state; until then the loader's read stands.
  const liveCert = (certFetcher.state === 'idle' ? certFetcher.data?.cert : undefined) ?? cert;
  const chip = certChip(liveCert, { flyConfigured });
  const records = claimedDomain ? dnsRows(liveCert?.dnsRequirements, claimedDomain) : [];
  const routeRecords = records.filter(record => record.purpose === 'route');
  const proofRecords = records.filter(record => record.purpose === 'proof');
  // A completed check SUPERSEDES the claim's verdict, including when it clears.
  // The save's `certError` lives on its fetcher until the next save, so reading
  // it first would leave "the certificate could not be requested" on screen
  // beside a chip that has since flipped to Issuing — the retry working is
  // exactly when this notice must stop being shown.
  const certNotice = certFetcher.data
    ? certErrorNotice(certFetcher.data.certError)
    : certErrorNotice(domainFetcher.data?.certError);
  const domainHint = customDomainErrorHint(domainFetcher.data?.code);

  const saveDomain = () =>
    domainFetcher.submit(JSON.stringify({ custom_domain: domainVerdict.normalized }), {
      method: 'post',
      action: actionUrl('saveCustomDomain'),
      encType: 'application/json',
    });

  const checkCert = () =>
    certFetcher.submit(JSON.stringify({}), {
      method: 'post',
      action: actionUrl('checkCustomDomainCert'),
      encType: 'application/json',
    });

  const removeDomain = () =>
    domainRemoveFetcher.submit(JSON.stringify({}), {
      method: 'post',
      action: actionUrl('removeCustomDomain'),
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

      {/* Row 4 — a domain the instructor owns (Pro). */}
      <SettingSection
        title="Custom domain"
        description="Serve this course site on a domain you own, like cs52.me."
      >
        <div className={dimmed}>
          {domainState === 'no-site' && (
            <div className="text-sm text-ink-3">
              Claim a Classmoji subdomain first — a custom domain points at the same site.
            </div>
          )}

          {domainState === 'locked' && (
            <div className="rounded-lg border border-line p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-ink-2">
                  Connect your own domain to this site
                </span>
                <ProPill />
              </div>
              <p className="pt-2 text-sm text-ink-3">
                Students reach your course at an address you own instead of your Classmoji
                subdomain. Your Classmoji address keeps working either way.
              </p>
              <Link
                to="/settings/billing"
                className="mt-3 inline-block text-sm font-medium text-ink-1 underline underline-offset-2 hover:text-ink-0"
              >
                Upgrade to Pro
              </Link>
            </div>
          )}

          {domainState === 'lapsed' && (
            <div className="rounded-lg border border-amber-200 p-4 dark:border-amber-900/60">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-base text-ink-0">{claimedDomain}</span>
                <ProPill />
              </div>
              <p className="pt-2 text-sm text-ink-3">
                Custom domains are part of Pro. Until the subscription is active again, visitors to
                this domain are forwarded to your Classmoji address — nothing on your site has
                changed, and restoring Pro brings the domain straight back.
              </p>
              <div className="flex flex-wrap items-center gap-3 pt-3">
                <Link
                  to="/settings/billing"
                  className="text-sm font-medium text-ink-1 underline underline-offset-2 hover:text-ink-0"
                >
                  Restore Pro
                </Link>
                <Popconfirm
                  title="Disconnect this domain?"
                  description={
                    <span className="block max-w-xs">
                      The domain stops pointing at your site and its certificate is released. Your
                      site stays live at its Classmoji address.
                    </span>
                  }
                  okText="Disconnect"
                  okButtonProps={{ danger: true }}
                  cancelText="Cancel"
                  onConfirm={removeDomain}
                >
                  <Button size="small" danger loading={domainRemoveFetcher.state !== 'idle'}>
                    Disconnect domain
                  </Button>
                </Popconfirm>
              </div>
              <RowError fetcher={domainRemoveFetcher} />
            </div>
          )}

          {(domainState === 'claim' || domainState === 'pending' || domainState === 'verified') && (
            <>
              {domainState === 'claim' || editingDomain ? (
                <>
                  <div className="flex flex-wrap items-center gap-3">
                    <Input
                      value={domainInput}
                      onChange={event => setDomainInput(event.target.value)}
                      onPressEnter={() =>
                        canSubmitDomain(domainVerdict, domainSubmitting) && saveDomain()
                      }
                      placeholder="cs52.me"
                      aria-label="Custom domain"
                      className="max-w-sm"
                    />
                    <Button
                      type="primary"
                      disabled={!canSubmitDomain(domainVerdict, domainSubmitting)}
                      loading={domainSubmitting}
                      onClick={saveDomain}
                    >
                      {claimedDomain ? 'Save' : 'Connect'}
                    </Button>
                    {claimedDomain && (
                      <Button
                        type="text"
                        onClick={() => {
                          setDomainInput(claimedDomain);
                          setEditingDomain(false);
                        }}
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                  {(domainVerdict.state === 'invalid' || domainVerdict.state === 'reserved') && (
                    <div className="pt-2 text-sm text-amber-600 dark:text-amber-400">
                      {domainVerdict.message}
                    </div>
                  )}
                  <div className="pt-2 text-sm text-ink-3">
                    Enter the bare hostname — no <span className="font-mono">https://</span>, no
                    path. You will add DNS records at your registrar next; we show exactly which
                    ones once the domain is connected.
                  </div>
                </>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-mono text-base text-ink-0">{claimedDomain}</span>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${CHIP_TONES[chip.tone] ?? CHIP_TONES.unknown}`}
                  >
                    {chip.label}
                  </span>
                  <Button
                    size="small"
                    loading={certFetcher.state !== 'idle'}
                    disabled={!flyConfigured}
                    onClick={checkCert}
                  >
                    Check status
                  </Button>
                  <Button size="small" onClick={() => setEditingDomain(true)}>
                    Change
                  </Button>
                  {domainState === 'verified' && (
                    <Button
                      size="small"
                      href={`https://${claimedDomain}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      icon={<IconExternalLink size={14} />}
                    >
                      Visit
                    </Button>
                  )}
                </div>
              )}

              <RowError fetcher={domainFetcher} />
              {domainHint && <div className="pt-1 text-sm text-ink-3">{domainHint}</div>}
              {certNotice && (
                <div className="pt-2 text-sm text-amber-600 dark:text-amber-400">{certNotice}</div>
              )}

              {claimedDomain && !editingDomain && (
                <>
                  <div className="pt-2 text-sm text-ink-3">{chip.hint}</div>

                  {domainState === 'verified' ? (
                    <div className="pt-2 text-sm text-green-700 dark:text-green-400">
                      Verified — your site has served over this domain, and it is now the address
                      search engines are pointed at.
                    </div>
                  ) : (
                    <div className="pt-2 text-sm text-ink-3">
                      This domain shows as verified once your site has actually served a request on
                      it. Nothing to press — visit it once the certificate is active.
                    </div>
                  )}

                  {liveCert && liveCert.validationErrors.length > 0 && (
                    <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-red-600 dark:text-red-400">
                      {liveCert.validationErrors.map((problem, index) => (
                        <li key={index}>
                          {typeof problem === 'string' ? problem : JSON.stringify(problem)}
                        </li>
                      ))}
                    </ul>
                  )}

                  {records.length > 0 && (
                    <div className="mt-4 rounded-lg border border-line p-4">
                      <p className="pb-3 text-sm text-ink-3">
                        Add these at your DNS provider. Values come from Fly, which issues the
                        certificate — copy them exactly.
                      </p>
                      {/* Guarded separately from `records`: Fly can require an
                          ownership record and no routing one (a CNAME already
                          in place), and a table with a header and no rows reads
                          as "nothing to do here". */}
                      {routeRecords.length > 0 && (
                        <div className="overflow-x-auto">
                          <table className="w-full min-w-[32rem] text-left text-sm">
                            <thead>
                              <tr className="text-ink-3">
                                <th className="pb-2 pr-4 font-medium">Type</th>
                                <th className="pb-2 pr-4 font-medium">Name</th>
                                <th className="pb-2 font-medium">Value</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-line">
                              {routeRecords.map(record => (
                                <tr key={`${record.type}-${record.name}-${record.value}`}>
                                  <td className="py-2 pr-4 font-mono text-ink-2">{record.type}</td>
                                  <td className="py-2 pr-4 font-mono break-all text-ink-2">
                                    {record.name}
                                  </td>
                                  <td className="py-2 font-mono break-all text-ink-0">
                                    {record.value}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}

                      {proofRecords.length > 0 && (
                        <>
                          <p className="pt-4 pb-2 text-sm text-ink-3">
                            Then add <span className="font-medium text-ink-2">any one</span> of
                            these to prove you own the domain. Without one, the certificate stays
                            pending however long the records above have been live.
                          </p>
                          <div className="overflow-x-auto">
                            <table className="w-full min-w-[32rem] text-left text-sm">
                              <tbody className="divide-y divide-line">
                                {proofRecords.map(record => (
                                  <tr key={`${record.type}-${record.name}-${record.value}`}>
                                    <td className="py-2 pr-4 font-mono text-ink-2">
                                      {record.type}
                                    </td>
                                    <td className="py-2 pr-4 font-mono break-all text-ink-2">
                                      {record.name}
                                    </td>
                                    <td className="py-2 font-mono break-all text-ink-0">
                                      {record.value}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  <div className="pt-4">
                    <Popconfirm
                      title="Disconnect this domain?"
                      description={
                        <span className="block max-w-xs">
                          The domain stops pointing at your site and its certificate is released.
                          Your site stays live at its Classmoji address, and your content is not
                          touched.
                        </span>
                      }
                      okText="Disconnect"
                      okButtonProps={{ danger: true }}
                      cancelText="Cancel"
                      onConfirm={removeDomain}
                    >
                      <Button size="small" danger loading={domainRemoveFetcher.state !== 'idle'}>
                        Disconnect domain
                      </Button>
                    </Popconfirm>
                    <RowError fetcher={domainRemoveFetcher} />
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </SettingSection>

      {/* Row 5 — giving the name back. */}
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
