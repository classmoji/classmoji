/**
 * The class site's link redaction. It moved to `utils/linkRedaction.server.ts`
 * when the shared reader started shipping the same documents to every surface;
 * the site's render keeps importing it from here.
 */
export { redactDocumentForViewer } from '~/utils/linkRedaction.server.ts';
