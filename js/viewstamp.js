// "Is what's on this canvas/diagram still what a redraw would produce?" -- lets a
// tabshown handler skip a redraw. PERF: Finances re-drew its charts and the money-flow
// diagram on EVERY show (~50 ms+ of synchronous work, more on real data) even when
// nothing had changed since the last draw.
//
// A gate remembers a key taken right after its last successful, VISIBLE draw:
//   data generation | element size | devicePixelRatio | theme
// and on show the handler asks stale(). Any of these makes it stale, so the redraw runs:
//  - data changed (generation is bumped by every onDataChange save and by every remote
//    adopt / renderAll, see bumpViewGen's callers),
//  - the element is a different size (window resized while the tab was hidden, a panel
//    collapsed...),
//  - the last draw attempt happened while hidden (0x0 -> mark() stores null),
//  - theme / zoom changed.
// mark() must be called after EVERY draw attempt (it records null if the element is hidden).
import { onDataChange } from './state.js';

let gen = 0;
function bumpViewGen() { gen += 1; }
onDataChange(bumpViewGen);

const darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

function keyFor(el) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null; // hidden
  return `${gen}|${Math.round(r.width)}x${Math.round(r.height)}|${window.devicePixelRatio || 1}|${document.documentElement.getAttribute('data-theme') || ''}|${darkQuery && darkQuery.matches ? 'd' : 'l'}`;
}

// getEl: () => element whose size the drawing depends on (re-looked-up each time; the
// panels re-render their markup).
function createViewGate(getEl) {
  let stamp = null;
  return {
    mark() { stamp = keyFor(getEl()); },
    invalidate() { stamp = null; },
    // true = redraw needed. A hidden / missing element is "stale" too (nothing to measure).
    stale() { const k = keyFor(getEl()); return k === null || k !== stamp; },
  };
}

export { createViewGate, bumpViewGen };
