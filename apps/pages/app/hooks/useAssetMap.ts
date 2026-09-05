import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRevalidator } from 'react-router';

/**
 * The client half of render-time URL resolution.
 *
 * The document stores references (`pages/lab-1/assets/hero.png`); the loader
 * ships a parallel `ref → signed URL` map; this hook is what turns one into the
 * other at display time and nowhere else. Two properties matter:
 *
 *  - the map is a REF, not state, so `resolveFileUrl` is a stable identity that
 *    BlockNote can hold for the life of an editor without remounting it;
 *  - an upload extends the map in place, because the just-uploaded blob has a
 *    signed URL before the asset map on the server has a row for it.
 *
 * A miss returns the reference unchanged, which is the correct answer for an
 * external image, a `data:` URI, and for a deployment where the delivery layer
 * is switched off entirely.
 */
export function useAssetMap(
  resolvedAssets: Record<string, string> | null | undefined,
  /**
   * Identity of the document this map belongs to (the page id).
   *
   * The route stays MOUNTED across navigations — same route, new params — so
   * without this the map accumulates across pages. References are repo-relative
   * and repeat (`assets/hero.png` exists in many page folders), so a stale
   * entry is not a harmless miss: it is classroom A's signed URL rendered on
   * classroom B's page.
   */
  resetKey?: string
) {
  const mapRef = useRef<Map<string, string>>(new Map());
  const seededFor = useRef<string | undefined>(resetKey);

  // Seeded during render, not in an effect: BlockNote asks for a file URL as
  // part of its first paint, and an effect would run after that — showing one
  // frame of broken images on every load.
  useMemo(() => {
    if (seededFor.current !== resetKey) {
      seededFor.current = resetKey;
      // A fresh map, not a merge — including the upload entries `remember` added,
      // which belong to the document being navigated away from.
      mapRef.current = new Map();
    }
    if (!resolvedAssets) return;
    for (const [ref, url] of Object.entries(resolvedAssets)) mapRef.current.set(ref, url);
  }, [resolvedAssets, resetKey]);

  /** BlockNote's `resolveFileUrl`: display URL in, stored ref untouched. */
  const resolveFileUrl = useCallback(async (url: string) => mapRef.current.get(url) ?? url, []);

  /** Synchronous lookup for markup this app renders itself (the cover image). */
  const displayUrl = useCallback(
    (ref: string | null | undefined) => (ref ? (mapRef.current.get(ref) ?? ref) : ref),
    []
  );

  /** Record a freshly uploaded asset's display URL against the ref being stored. */
  const remember = useCallback((ref: string, url: string | null | undefined) => {
    if (ref && url) mapRef.current.set(ref, url);
  }, []);

  // A STABLE object identity. Callers put this in effect dependency arrays, and
  // an identity that changed every render would re-run those effects on every
  // render — including one that bumps a remount epoch, which would then never
  // stop.
  return useMemo(
    () => ({ resolveFileUrl, displayUrl, remember }),
    [resolveFileUrl, displayUrl, remember]
  );
}

/**
 * A signed delivery URL, by shape — no need to ship the origin to the client.
 *
 * `blob` and `theme` only. A `/missing/` URL is the deterministic 404 the
 * resolver mints for a reference the asset map has never heard of: it will 404
 * again after any number of revalidations, so retrying one is guaranteed waste.
 */
const DELIVERY_URL =
  /\/c\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:blob|theme)\//;

/**
 * Re-resolve once when a signed URL comes back 403.
 *
 * An `edit` URL lives four hours. A tab left open past that has a document full
 * of references whose signatures have expired, and every image on it breaks at
 * once — with no user action that would refresh them, because the document
 * itself did not change. One revalidation re-runs the loader, which mints a
 * fresh set.
 *
 * Strictly once per mount. A revalidation that does not fix the image (the file
 * really is gone, the origin really is down) must not become a loop that
 * re-runs the loader on every failed retry. `error` does not bubble, so the
 * listener is registered in the CAPTURE phase to see it at all.
 *
 * Returns an epoch to feed a read-only viewer's `key`, since the refreshed map
 * only reaches BlockNote when the component that read it is rebuilt.
 */
export function useAssetRetry(): number {
  const revalidator = useRevalidator();
  const [epoch, setEpoch] = useState(0);
  const retried = useRef(false);

  useEffect(() => {
    const onError = (event: Event) => {
      if (retried.current) return;
      const target = event.target;
      if (!(target instanceof HTMLImageElement)) return;
      if (!DELIVERY_URL.test(target.currentSrc || target.src)) return;

      retried.current = true;
      setEpoch(value => value + 1);
      revalidator.revalidate();
    };

    document.addEventListener('error', onError, true);
    return () => document.removeEventListener('error', onError, true);
  }, [revalidator]);

  return epoch;
}
