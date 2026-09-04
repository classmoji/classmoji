/**
 * The content-delivery helpers, re-exported from where pages specs expect them.
 *
 * The implementation is shared with `apps/slides` and lives at the repo root
 * (`tests/content-delivery/`), because both suites have to make IDENTICAL
 * claims about one URL format — a second copy would drift, and two suites
 * asserting slightly different shapes would both stay green while the app
 * emitted neither. This file exists so specs still import from
 * `tests/helpers`, alongside `auth.helpers` and the rest.
 */
export * from '../../../../tests/content-delivery/contentDelivery.helpers';
