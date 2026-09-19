/**
 * Walking a BlockNote document for the asset references inside it.
 *
 * A stored block holds a plain repo path (or a legacy absolute URL); the signed
 * delivery URL is derived at render and never written back. That makes two
 * passes necessary and this module owns both halves of the mechanics:
 *
 *   - on the way OUT, collect every reference so a loader can resolve them in
 *     one batch and hand the client a `ref → signed URL` map;
 *   - on the way IN, rewrite — turning any signed URL the browser handed back
 *     into the path it came from, so a save can never freeze a signature into
 *     content.json.
 *
 * Pure and dependency-free on purpose: the policy (which tier, which classroom,
 * what a reference resolves to) belongs to the caller, and what lives here is
 * only the tree walk — which is the part worth testing in isolation.
 */

/** Props that hold a reference to a file in the content repo. */
const REF_PROPS = ['url', 'imageUrl'] as const;

export type BlockLike = {
  props?: Record<string, unknown>;
  children?: unknown;
  [key: string]: unknown;
};

/** A plain object — the only thing in a document that can carry props. */
export function isBlockLike(value: unknown): value is BlockLike {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refsOf(block: BlockLike, out: string[]): void {
  const props = block.props;
  if (!isBlockLike(props)) return;
  for (const name of REF_PROPS) {
    const value = props[name];
    if (typeof value === 'string' && value.length > 0) out.push(value);
  }
}

/**
 * Every asset reference in a block tree, in document order, duplicates included.
 *
 * Recurses through `children`, which is how BlockNote nests everything —
 * columns, column lists, toggles, list items — so a reference inside a
 * two-column layout is found exactly like a top-level one.
 */
export function collectBlockAssetRefs(blocks: unknown): string[] {
  const out: string[] = [];

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!isBlockLike(node)) return;
    refsOf(node, out);
    if (node.children) walk(node.children);
  };

  walk(blocks);
  return out;
}

/**
 * A CLONE of the tree with every reference passed through `map`.
 *
 * Cloning is not a style choice. The class-site path renders from a cached
 * document, and rewriting it in place would leave one viewer's signed,
 * tier-specific URLs in the cache for the next viewer — who may be in a
 * different tier, or looking at it after the signature expired. Nodes with no
 * reference under them are returned by identity, so the copy is shallow
 * wherever nothing changed.
 */
export function mapBlockAssetRefs<T>(blocks: T, map: (ref: string) => string): T {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      let changed = false;
      const next = node.map(child => {
        const mapped = walk(child);
        if (mapped !== child) changed = true;
        return mapped;
      });
      return changed ? next : node;
    }
    if (!isBlockLike(node)) return node;

    let props = node.props;
    if (isBlockLike(props)) {
      for (const name of REF_PROPS) {
        const value = props[name];
        if (typeof value !== 'string' || value.length === 0) continue;
        const mapped = map(value);
        if (mapped === value) continue;
        props = props === node.props ? { ...props } : props;
        (props as Record<string, unknown>)[name] = mapped;
      }
    }

    const children = node.children ? walk(node.children) : node.children;
    if (props === node.props && children === node.children) return node;
    return { ...node, ...(props ? { props } : {}), ...(node.children ? { children } : {}) };
  };

  return walk(blocks) as T;
}
