import type { BlobRef, OriginAdapter, TreeListing, TreeRef } from './types.ts';

const NOT_IMPLEMENTED = 'not implemented';

/**
 * Placeholder for the large-media origin (presigned object storage). It exists
 * so the adapter seam has a second shape to satisfy; every method throws until
 * that backend is real.
 */
export class MediaOrigin implements OriginAdapter {
  readonly canPresign = true;

  readonly maxProxyBytes = 0;

  async fetchBlob(_ref: BlobRef): Promise<Response> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async fetchTree(_ref: TreeRef): Promise<TreeListing> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async presign(_ref: BlobRef): Promise<string> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
