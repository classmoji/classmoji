import { createHash } from 'node:crypto';

/**
 * An RFC 4122 version-5 (SHA-1, name-based) uuid, lowercase.
 *
 * On its own so the read half of the media barrel can export it without the
 * AWS client `mediaImportCopy.ts` imports: the class-to-class copy derives its
 * copy ids with it, and the Cloudinary migration task derives its media ids
 * (`uuidV5(namespace, publicId + ':' + classroomId)`) the same way.
 */
export function uuidV5(namespace: string, name: string): string {
  const bytes = createHash('sha1')
    .update(Buffer.from(namespace.replace(/-/g, ''), 'hex'))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
