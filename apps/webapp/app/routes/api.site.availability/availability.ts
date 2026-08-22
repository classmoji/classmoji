/**
 * The subdomain-availability response, as a pure function.
 *
 * The route around it is auth plus one service call; everything worth pinning
 * down is the mapping from the service's `{ available, normalized, reason }`
 * onto a wire shape the admin form can switch on — including the two cases the
 * service never produces (nothing typed, and an unrecognized reason).
 */

/** What the field is showing, as one discriminator the client switches on. */
export type SubdomainStatus = 'empty' | 'available' | 'invalid' | 'reserved' | 'taken';

/** The shape `ClassmojiService.site.checkSubdomainAvailability` returns. */
export interface ServiceAvailability {
  available: boolean;
  normalized: string;
  reason?: string;
}

/**
 * Mirrors `/api/classrooms/availability`'s `{ slug_available }` contract, with
 * `status` carrying the detail a subdomain needs and a slug does not: an
 * unavailable label is unavailable for one of three quite different reasons,
 * and only one of them ("taken") is worth retrying with a different class.
 */
export interface SubdomainAvailabilityResponse {
  subdomain_available: boolean;
  /** The trimmed, lowercased label the caller would actually get. */
  normalized: string;
  status: SubdomainStatus;
  /** Short label for the inline badge. Empty when there is nothing to say. */
  message: string;
}

const REASON_STATUS: Record<string, SubdomainStatus> = {
  SUBDOMAIN_INVALID: 'invalid',
  SUBDOMAIN_RESERVED: 'reserved',
  SUBDOMAIN_TAKEN: 'taken',
};

export const SUBDOMAIN_STATUS_MESSAGE: Record<SubdomainStatus, string> = {
  empty: '',
  available: 'Available',
  invalid: 'Invalid',
  reserved: 'Reserved',
  taken: 'Taken',
};

/**
 * `null` means nothing was typed — reported as `empty`, NOT as available.
 *
 * This is the one place the subdomain check deliberately diverges from the
 * classroom-slug route, which answers `slug_available: true` for empty input.
 * There, the answer only suppresses an error message. Here it also gates a
 * Claim button, and an empty label is not something anyone can claim.
 *
 * An unavailable answer with a reason we do not recognize degrades to
 * `invalid` rather than `available`: the boolean is what the button reads, so
 * an unknown rejection must never open the gate.
 */
export function buildAvailabilityResponse(
  availability: ServiceAvailability | null
): SubdomainAvailabilityResponse {
  if (!availability) {
    return { subdomain_available: false, normalized: '', status: 'empty', message: '' };
  }

  const status: SubdomainStatus = availability.available
    ? 'available'
    : (REASON_STATUS[availability.reason ?? ''] ?? 'invalid');

  return {
    subdomain_available: status === 'available',
    normalized: availability.normalized,
    status,
    message: SUBDOMAIN_STATUS_MESSAGE[status],
  };
}
