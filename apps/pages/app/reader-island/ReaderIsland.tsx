/**
 * The server-rendered half of the reader island: what a document needs to
 * mount the shared reader without hydrating — the island's stylesheets and
 * module preloads, the mount element (with a loading line until the reader
 * takes it over), the data block, and the entry module script.
 *
 * The route reads the assets in its loader (`assets.server.ts`) and the data
 * from its own payload builder, and renders `<ReaderIsland>` where the reader
 * belongs. Nothing here runs in a browser; the document is not hydrated.
 */
import {
  READER_ISLAND_DATA_ID,
  READER_ISLAND_ROOT_ID,
  serializeIslandData,
  type ReaderIslandData,
} from './contract.ts';

/** Where the island's files are (`readerIslandAssets.js`). */
export interface ReaderIslandAssets {
  dev: boolean;
  /** The entry module's URL (the source path in dev, hashed in a build). */
  entry: string;
  /** Stylesheets of the entry and the reader chunk's static graph. */
  css: string[];
  /** `modulepreload` URLs: the reader chunk and its static imports. */
  preloads: string[];
}

/** The tags, as data (what `ReaderIsland` renders; the unit suite reads it). */
export interface ReaderIslandTags {
  stylesheets: string[];
  modulePreloads: string[];
  moduleScript: string;
}

/** The tags a document needs for the island. Throws when the build has no entry. */
export function readerIslandTags(assets: ReaderIslandAssets): ReaderIslandTags {
  if (!assets.entry) throw new Error('[reader-island] no entry module in this build');
  return {
    stylesheets: [...assets.css],
    modulePreloads: [...assets.preloads],
    moduleScript: assets.entry,
  };
}

export function ReaderIsland({
  assets,
  data,
  className,
}: {
  assets: ReaderIslandAssets;
  data: ReaderIslandData;
  /** Classes on the mount element (a wrapper the surface's styles or driver key on). */
  className?: string;
}) {
  const tags = readerIslandTags(assets);
  return (
    <>
      {tags.stylesheets.map(href => (
        <link key={href} rel="stylesheet" href={href} />
      ))}
      {tags.modulePreloads.map(href => (
        <link key={href} rel="modulepreload" href={href} />
      ))}
      <div id={READER_ISLAND_ROOT_ID} className={className}>
        <div className="flex items-center justify-center py-12">
          <div className="text-gray-500 dark:text-gray-400">Loading content...</div>
        </div>
      </div>
      <script
        type="application/json"
        id={READER_ISLAND_DATA_ID}
        dangerouslySetInnerHTML={{ __html: serializeIslandData(data) }}
      />
      <script type="module" src={tags.moduleScript} />
    </>
  );
}
