import { describe, it, expect } from 'vitest';

import {
  canSubmitDomain,
  certChip,
  certErrorNotice,
  checkDomainInput,
  customDomainErrorHint,
  customDomainRowState,
  dnsRows,
  type CertSnapshot,
} from '../customDomain.ts';

/**
 * The Custom domain row's judgements. `@classmoji/utils` is deliberately NOT
 * mocked, for the same reason siteSettings.test.ts does not mock it: the domain
 * regex and the platform-domain registry are exactly what `checkDomainInput`
 * is asking about, and a stub would only test the stub.
 */

const site = (fields: Partial<{ custom_domain: string | null; verified: Date | null }> = {}) => ({
  custom_domain: fields.custom_domain ?? null,
  custom_domain_verified_at: fields.verified ?? null,
});

describe('customDomainRowState', () => {
  it('has nothing to attach a domain to without a site row', () => {
    expect(customDomainRowState({ isPro: true, site: null })).toBe('no-site');
    expect(customDomainRowState({ isPro: false, site: null })).toBe('no-site');
  });

  it('locks a FREE classroom that never claimed a domain', () => {
    expect(customDomainRowState({ isPro: false, site: site() })).toBe('locked');
  });

  it('reports LAPSED — not locked — when a FREE classroom still holds a domain', () => {
    // The distinction the Remove button depends on. An owner whose subscription
    // ended still has a live DNS record pointing at us; collapsing this into
    // `locked` would hide Disconnect behind the paywall and strand them.
    expect(customDomainRowState({ isPro: false, site: site({ custom_domain: 'cs52.me' }) })).toBe(
      'lapsed'
    );
  });

  it('stays LAPSED even for a domain that was previously verified', () => {
    expect(
      customDomainRowState({
        isPro: false,
        site: site({ custom_domain: 'cs52.me', verified: new Date('2026-01-01') }),
      })
    ).toBe('lapsed');
  });

  it('offers the input to a PRO classroom with no domain', () => {
    expect(customDomainRowState({ isPro: true, site: site() })).toBe('claim');
  });

  it('is PENDING once claimed but never served', () => {
    expect(customDomainRowState({ isPro: true, site: site({ custom_domain: 'cs52.me' }) })).toBe(
      'pending'
    );
  });

  it('is VERIFIED once the stamp is set', () => {
    expect(
      customDomainRowState({
        isPro: true,
        site: site({ custom_domain: 'cs52.me', verified: new Date('2026-08-22') }),
      })
    ).toBe('verified');
  });

  it('accepts a serialized timestamp as proof, not just a Date', () => {
    // Loader data crosses the wire; a string here must not read as unverified.
    expect(
      customDomainRowState({
        isPro: true,
        site: { custom_domain: 'cs52.me', custom_domain_verified_at: '2026-08-22T10:00:00.000Z' },
      })
    ).toBe('verified');
  });
});

describe('checkDomainInput', () => {
  it('accepts a bare domain', () => {
    expect(checkDomainInput('cs52.me')).toEqual({ state: 'ok', normalized: 'cs52.me' });
  });

  it('accepts a subdomain of a domain the instructor owns', () => {
    expect(checkDomainInput('www.cs52.me').state).toBe('ok');
  });

  it('normalizes case, surrounding space and one trailing dot', () => {
    // Byte-identical to what normalizeCustomDomain will store — a preview of a
    // different string would be a verdict about a value nobody ever saves.
    expect(checkDomainInput('  CS52.ME.  ')).toEqual({ state: 'ok', normalized: 'cs52.me' });
  });

  it('reads nothing as empty rather than invalid', () => {
    expect(checkDomainInput('').state).toBe('empty');
    expect(checkDomainInput('   ').state).toBe('empty');
    expect(checkDomainInput(null).state).toBe('empty');
    expect(checkDomainInput(undefined).state).toBe('empty');
  });

  it('rejects a single label', () => {
    expect(checkDomainInput('cs52').state).toBe('invalid');
  });

  it('rejects a scheme, a path and a port', () => {
    expect(checkDomainInput('https://cs52.me').state).toBe('invalid');
    expect(checkDomainInput('cs52.me/syllabus').state).toBe('invalid');
    expect(checkDomainInput('cs52.me:8080').state).toBe('invalid');
  });

  it('rejects a platform domain as RESERVED, not invalid', () => {
    // Two different mistakes, two different messages.
    expect(checkDomainInput('classmoji.io').state).toBe('reserved');
    expect(checkDomainInput('cs52.classmoji.io').state).toBe('reserved');
    expect(checkDomainInput('anything.fly.dev').state).toBe('reserved');
    expect(checkDomainInput('lvh.me').state).toBe('reserved');
  });

  it('judges shape before ownership', () => {
    // A malformed platform domain reads as malformed: `classmoji.io/` is a typo,
    // not an attempt to claim our hostname.
    expect(checkDomainInput('classmoji.io/').state).toBe('invalid');
  });
});

describe('canSubmitDomain', () => {
  it('permits only a well-formed domain', () => {
    expect(canSubmitDomain(checkDomainInput('cs52.me'), false)).toBe(true);
    expect(canSubmitDomain(checkDomainInput(''), false)).toBe(false);
    expect(canSubmitDomain(checkDomainInput('cs52'), false)).toBe(false);
    expect(canSubmitDomain(checkDomainInput('classmoji.io'), false)).toBe(false);
  });

  it('refuses while a save is already in flight', () => {
    expect(canSubmitDomain(checkDomainInput('cs52.me'), true)).toBe(false);
  });
});

describe('certChip', () => {
  const cert = (fields: Partial<CertSnapshot> = {}): CertSnapshot => ({
    status: fields.status ?? null,
    configured: fields.configured ?? false,
    dnsRequirements: fields.dnsRequirements ?? null,
    validationErrors: fields.validationErrors ?? [],
  });

  it('says manual setup when certificate automation is off', () => {
    // isFlyCertsConfigured() false: the feature degrades to "ask an admin",
    // and it must not look like the instructor did something wrong.
    const chip = certChip(cert({ status: 'active' }), { flyConfigured: false });
    expect(chip.tone).toBe('manual');
    expect(chip.label).toBe('Manual setup');
  });

  it('reports an unreadable certificate as unknown, not as a failure', () => {
    expect(certChip(null, { flyConfigured: true }).tone).toBe('unknown');
  });

  it('is ACTIVE on an issued certificate', () => {
    expect(
      certChip(cert({ status: 'active', configured: true }), { flyConfigured: true }).tone
    ).toBe('active');
  });

  it('matches the active status case-insensitively', () => {
    expect(certChip(cert({ status: 'ACTIVE' }), { flyConfigured: true }).tone).toBe('active');
  });

  it('is PENDING DNS while Fly cannot see the records', () => {
    const chip = certChip(cert({ status: 'pending_validation', configured: false }), {
      flyConfigured: true,
    });
    expect(chip.tone).toBe('pending');
    expect(chip.label).toBe('Pending DNS');
  });

  it('is ISSUING once the records resolve', () => {
    expect(
      certChip(cert({ status: 'pending_validation', configured: true }), { flyConfigured: true })
        .tone
    ).toBe('issuing');
  });

  it('treats an unrecognized status as issuing rather than as an error', () => {
    // Fly's vocabulary is theirs to extend; a new word must not turn a healthy
    // certificate into a scary chip.
    expect(
      certChip(cert({ status: 'awaiting_something_new', configured: true }), {
        flyConfigured: true,
      }).tone
    ).toBe('issuing');
  });
});

describe('dnsRows', () => {
  it('renders nothing without requirements', () => {
    expect(dnsRows(null, 'cs52.me')).toEqual([]);
    expect(dnsRows(undefined, 'cs52.me')).toEqual([]);
    expect(dnsRows({}, 'cs52.me')).toEqual([]);
  });

  it('renders the addresses Fly reported, never a hardcoded pair', () => {
    // The whole reason this is a function and not a constant: A/AAAA addresses
    // are per Fly APP, so staging and production differ.
    const rows = dnsRows({ a: ['198.51.100.7'] }, 'cs52.me');
    expect(rows).toEqual([{ type: 'A', name: 'cs52.me', value: '198.51.100.7', purpose: 'route' }]);
  });

  it('marks A and CNAME as routing, and the rest as ownership proof', () => {
    const rows = dnsRows(
      {
        a: ['198.51.100.7'],
        aaaa: ['2001:db8::1'],
        acme_challenge: ['cs52.me.abc.flydns.net'],
        ownership: ['fly-verify-token'],
      },
      'cs52.me'
    );

    expect(rows.filter(row => row.purpose === 'route').map(row => row.type)).toEqual(['A']);
    expect(rows.filter(row => row.purpose === 'proof').map(row => row.type)).toEqual([
      'AAAA',
      'CNAME',
      'TXT',
    ]);
  });

  it('prefixes the challenge and ownership names under the domain', () => {
    const rows = dnsRows(
      { acme_challenge: ['cs52.me.abc.flydns.net'], ownership: ['token'] },
      'cs52.me'
    );
    expect(rows.map(row => row.name)).toEqual([
      '_acme-challenge.cs52.me',
      '_fly-ownership.cs52.me',
    ]);
  });

  it('accepts a bare string where Fly might send one instead of an array', () => {
    expect(dnsRows({ cname: 'cs52.fly.dev' }, 'www.cs52.me')).toEqual([
      { type: 'CNAME', name: 'www.cs52.me', value: 'cs52.fly.dev', purpose: 'route' },
    ]);
  });

  it('carries an unrecognized requirement through rather than dropping it', () => {
    // An instructor who can read an unfamiliar record off the screen is
    // unblocked; one who cannot has a domain that never issues and no clue why.
    const rows = dnsRows({ caa: ['0 issue "letsencrypt.org"'] }, 'cs52.me');
    expect(rows).toEqual([
      { type: 'CAA', name: 'cs52.me', value: '0 issue "letsencrypt.org"', purpose: 'proof' },
    ]);
  });

  it('unwraps an object-shaped requirement value', () => {
    expect(dnsRows({ cname: [{ value: 'cs52.fly.dev' }] }, 'cs52.me')[0].value).toBe(
      'cs52.fly.dev'
    );
  });

  it('drops empty entries and duplicates', () => {
    const rows = dnsRows({ a: ['198.51.100.7', '198.51.100.7', '', '   ', null] }, 'cs52.me');
    expect(rows).toHaveLength(1);
  });
});

describe('customDomainErrorHint', () => {
  it('gives the next step for each rejection the service raises', () => {
    expect(customDomainErrorHint('PRO_REQUIRED')).toMatch(/Pro/);
    expect(customDomainErrorHint('SITE_NOT_FOUND')).toMatch(/subdomain/i);
    expect(customDomainErrorHint('DOMAIN_INVALID')).toMatch(/cs52\.me/);
    expect(customDomainErrorHint('DOMAIN_RESERVED')).toMatch(/own/);
    expect(customDomainErrorHint('DOMAIN_TAKEN')).toMatch(/another classmoji site/i);
  });

  it('says nothing about a code it does not recognize', () => {
    // The service's own message is already on screen; inventing advice for an
    // unknown code would be worse than silence.
    expect(customDomainErrorHint('HOME_PAGE_REQUIRED')).toBeNull();
    expect(customDomainErrorHint(null)).toBeNull();
    expect(customDomainErrorHint(undefined)).toBeNull();
  });
});

describe('certErrorNotice', () => {
  it('says nothing when the certificate request succeeded', () => {
    expect(certErrorNotice(null)).toBeNull();
    expect(certErrorNotice(undefined)).toBeNull();
  });

  it('never presents a certificate failure as a failed claim', () => {
    // setCustomDomain already committed the row. Telling the instructor the
    // save failed would be false, and would invite a re-claim that clears the
    // verification stamp for no reason.
    for (const code of [
      'NOT_CONFIGURED',
      'UNAUTHORIZED',
      'RATE_LIMITED',
      'UPSTREAM',
      'NOT_FOUND',
    ]) {
      expect(certErrorNotice(code)).toMatch(/^Domain claimed/);
    }
  });

  it('points every retryable failure at Check status', () => {
    expect(certErrorNotice('UNAUTHORIZED')).toMatch(/Check status/);
    expect(certErrorNotice('RATE_LIMITED')).toMatch(/Check status/);
    expect(certErrorNotice('UPSTREAM')).toMatch(/Check status/);
  });

  it('does not offer a retry for an unconfigured environment', () => {
    // Nothing the instructor presses can conjure credentials this process lacks.
    expect(certErrorNotice('NOT_CONFIGURED')).not.toMatch(/Check status/);
  });

  it('still explains an unfamiliar code', () => {
    expect(certErrorNotice('SOMETHING_NEW')).toMatch(/^Domain claimed/);
  });
});
