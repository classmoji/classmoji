/**
 * @classmoji/collab — shared, isomorphic pieces of live collaborative editing:
 * room names, internal API / auth / loader contracts, fractional indexes and
 * user colours. No Node-only or DOM-only imports; safe in every app and the
 * git worker. Slices extend it (deck Y.Doc <-> DeckJson, page meta, locks).
 */
export * from './rooms.ts';
export * from './api.ts';
export * from './fractionalIndex.ts';
export * from './color.ts';
