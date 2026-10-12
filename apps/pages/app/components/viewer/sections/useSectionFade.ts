import { useEffect, useMemo, useRef, useState } from 'react';
import { checkableSectionRanges } from '@classmoji/page-schema/sections';

/**
 * Ticked sections fade; reading one brings it back.
 *
 * A section is the heading plus the siblings after it up to the next heading
 * of its level or higher, read off the document JSON
 * (`checkableSectionRanges`), never off the DOM. Each ticked section becomes
 * CSS on its blocks' `.bn-block-outer[data-id]`: the heading's own text and
 * children fade (not its tick box), the rest of the section fades whole.
 *
 * BlockNote's blocks are flat siblings, so "hovering the section" cannot be a
 * selector on a wrapper. The container carries the ids of the sections the
 * pointer (or keyboard focus) is in, `data-active-sections`, and the rules
 * restore those. Pointing at the tick box itself does not count, so ticking
 * shows the fade at once. Reduced motion: the fade still happens, without
 * the transition.
 */
export function useSectionFade(
  content: unknown,
  checked: ReadonlySet<string>,
  enabled: boolean
): { css: string; containerRef: (element: HTMLElement | null) => void } {
  const ranges = useMemo(
    () => (enabled ? checkableSectionRanges(content) : new Map<string, string[]>()),
    [content, enabled]
  );

  // Block id → the sections it belongs to (nested sections overlap).
  const sectionsOf = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const [heading, ids] of ranges) {
      for (const id of ids) {
        const list = map.get(id);
        if (list) list.push(heading);
        else map.set(id, [heading]);
      }
    }
    return map;
  }, [ranges]);

  const css = useMemo(() => {
    if (!enabled || typeof CSS === 'undefined' || typeof CSS.escape !== 'function') return '';
    const rules: string[] = [];
    const root = '.pg-reader-sections';
    for (const [heading, ids] of ranges) {
      const active = `${root}[data-active-sections~="${CSS.escape(heading)}"]`;
      const headingOuter = `.bn-block-outer[data-id="${CSS.escape(heading)}"]`;
      const own = [
        `${headingOuter} > .bn-block > .bn-block-content > :not(.pg-section-check)`,
        `${headingOuter} > .bn-block > .bn-block-group`,
      ];
      const rest = ids
        .filter(id => id !== heading)
        .map(id => `.bn-block-outer[data-id="${CSS.escape(id)}"]`);
      const targets = [...own, ...rest];
      // On every section, ticked or not, so both directions animate.
      rules.push(
        `@media (prefers-reduced-motion: no-preference) { ${targets
          .map(t => `${root} ${t}`)
          .join(',\n')} { transition: opacity 250ms ease; } }`
      );
      if (!checked.has(heading)) continue;
      rules.push(`${targets.map(t => `${root} ${t}`).join(',\n')} { opacity: 0.45; }`);
      rules.push(`${targets.map(t => `${active} ${t}`).join(',\n')} { opacity: 0.8; }`);
    }
    return rules.join('\n');
  }, [ranges, checked, enabled]);

  // Which sections the pointer / keyboard focus is in, on the container.
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const hovered = useRef<string[]>([]);
  const focused = useRef<string[]>([]);
  const sectionsOfRef = useRef(sectionsOf);
  sectionsOfRef.current = sectionsOf;

  const write = (el: HTMLElement) => {
    const ids = [...new Set([...hovered.current, ...focused.current])];
    if (ids.length) el.setAttribute('data-active-sections', ids.join(' '));
    else el.removeAttribute('data-active-sections');
  };

  const sectionsAt = (target: EventTarget | null): string[] => {
    if (!(target instanceof Element)) return [];
    const out: string[] = [];
    let node: Element | null = target.closest('.bn-block-outer[data-id]');
    while (node) {
      const list = sectionsOfRef.current.get(node.getAttribute('data-id') ?? '');
      if (list) out.push(...list);
      node = node.parentElement?.closest('.bn-block-outer[data-id]') ?? null;
    }
    return out;
  };

  useEffect(() => {
    const el = container;
    if (!el || !enabled) return;
    const onOver = (event: PointerEvent) => {
      const target = event.target as Element | null;
      hovered.current = target?.closest?.('.pg-section-check') ? [] : sectionsAt(target);
      write(el);
    };
    const onLeave = () => {
      hovered.current = [];
      write(el);
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Element | null;
      let visible = false;
      try {
        visible = Boolean(target?.matches?.(':focus-visible'));
      } catch {
        visible = false;
      }
      focused.current = visible ? sectionsAt(target) : [];
      write(el);
    };
    const onFocusOut = () => {
      focused.current = [];
      write(el);
    };
    el.addEventListener('pointerover', onOver);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('focusin', onFocusIn);
    el.addEventListener('focusout', onFocusOut);
    return () => {
      el.removeEventListener('pointerover', onOver);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('focusin', onFocusIn);
      el.removeEventListener('focusout', onFocusOut);
    };
  }, [enabled, container]);

  return { css, containerRef: setContainer };
}
