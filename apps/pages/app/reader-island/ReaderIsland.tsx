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
import { ISLAND_ERROR_MESSAGE } from './islandDom.ts';
import {
  READER_ISLAND_DATA_ID,
  READER_ISLAND_ROOT_ID,
  serializeIslandData,
  type ReaderIslandData,
} from './contract.ts';

/** Shown in place of the loading line when the island never mounted (CSS only): the failure state's words. */
export const ISLAND_STALLED_MESSAGE = ISLAND_ERROR_MESSAGE;

/** Shown to a browser with scripting off. */
export const ISLAND_NOSCRIPT_MESSAGE = 'This page needs JavaScript to show its content.';

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
  stalledFallback = false,
}: {
  assets: ReaderIslandAssets;
  data: ReaderIslandData;
  /** Classes on the mount element (a wrapper the surface's styles or driver key on). */
  className?: string;
  /**
   * The class site: a page that never mounts (scripts off, the entry blocked
   * or gone after a deploy) must not sit on its loading line. With this, the
   * mount element carries a `<noscript>` line, and the loading line gives way
   * to a failure line after a while by a CSS animation alone
   * (`reader-island-wait*` in site/styles.ts, inline in the document so it
   * works when no other file loads). React replaces the mount element's
   * children when the reader mounts, so a working page never shows either.
   * Off on the MCP's page render, whose driver waits on its own markers.
   */
  stalledFallback?: boolean;
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
        {stalledFallback ? (
          <>
            <div className="reader-island-wait">
              <span className="reader-island-wait-loading">Loading content...</span>
              <span className="reader-island-wait-failed">{ISLAND_STALLED_MESSAGE}</span>
            </div>
            <noscript>
              <div className="reader-island-noscript">{ISLAND_NOSCRIPT_MESSAGE}</div>
            </noscript>
          </>
        ) : (
          <div className="flex items-center justify-center py-12">
            <div className="text-gray-500 dark:text-gray-400">Loading content...</div>
          </div>
        )}
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
