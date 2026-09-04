/**
 * The `sizes` hint this app ships with a responsive image.
 *
 * Restated from `@classmoji/services` rather than imported: this value is read
 * in a CLIENT component, and the services package pulls in Prisma. The one in
 * `contentDelivery.service.ts` is the source of the reasoning (an image block is
 * laid out at the full width of the article column); the two must stay in step,
 * and the class-site render — which is server-side — uses that one directly.
 */
export const IMAGE_SIZES = '(max-width: 1024px) 100vw, 1024px';
