import { escapeHtml } from './utils.js';

// A fixed, simple grid -- 3 accounts wide, wrapping to further rows for
// more -- each cell a bank name, arrows only between adjacent/CASS-linked
// cells (donor -> recipient). Deliberately simpler than the dashboard's
// own financeaccounts.js flow diagram (no DOM-measured positions): a
// small, dependency-free inline SVG built from a fixed column count, since
// a handful of accounts per person never needs anything smarter.

const COLS = 3;
const CELL_W = 170;
const CELL_H = 70;
const GAP_X = 50;
const GAP_Y = 40;
const PAD = 20;

function cellCenter(index) {
  const col = index % COLS;
  const row = Math.floor(index / COLS);
  return {
    x: PAD + col * (CELL_W + GAP_X) + CELL_W / 2,
    y: PAD + row * (CELL_H + GAP_Y) + CELL_H / 2,
    col, row,
  };
}

const CASS_LABEL = { yes: 'CASS participant', no: 'CASS dead end', unsure: 'CASS status unsure' };
const CASS_CLASS = { yes: 'var(--good, #2a8a4a)', no: 'var(--warn, #b5651d)', unsure: 'var(--muted, #888)' };

export function cassGridSvg(grid) {
  const nodes = grid.nodes || [];
  if (!nodes.length) return '<div class="empty">Add an account to see the CASS map.</div>';
  const rows = Math.ceil(nodes.length / COLS);
  const width = PAD * 2 + COLS * CELL_W + (COLS - 1) * GAP_X;
  const height = PAD * 2 + rows * CELL_H + Math.max(0, rows - 1) * GAP_Y;
  const indexById = {};
  nodes.forEach((n, i) => { indexById[n.id] = i; });

  const cells = nodes.map((n, i) => {
    const { x, y } = cellCenter(i);
    const strokeColor = CASS_CLASS[n.cassStatus] || '#888';
    return `<g>
      <rect x="${x - CELL_W / 2}" y="${y - CELL_H / 2}" width="${CELL_W}" height="${CELL_H}" rx="8"
        fill="${n.open ? 'var(--card-bg, #fff)' : 'var(--muted-bg, #eee)'}" stroke="${strokeColor}" stroke-width="2"/>
      <text x="${x}" y="${y - 6}" text-anchor="middle" font-size="13" font-weight="600">${escapeHtml(n.nickname || n.bank)}</text>
      <text x="${x}" y="${y + 14}" text-anchor="middle" font-size="11" fill="var(--muted-text, #666)">${n.open ? '' : 'Closed · '}${escapeHtml(CASS_LABEL[n.cassStatus] || '')}</text>
      ${n.cassReady ? `<text x="${x}" y="${y + CELL_H / 2 - 6}" text-anchor="middle" font-size="10" fill="var(--accent, #2a6ac0)">CASS-ready</text>` : ''}
    </g>`;
  }).join('');

  const edges = (grid.edges || []).map((e) => {
    const fromI = indexById[e.from];
    const toI = indexById[e.to];
    if (fromI == null || toI == null) return '';
    const from = cellCenter(fromI);
    const to = cellCenter(toI);
    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    return `<g>
      <line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="var(--accent, #2a6ac0)" stroke-width="2" marker-end="url(#cass-arrow)"/>
      ${e.label ? `<text x="${midX}" y="${midY - 6}" text-anchor="middle" font-size="10" fill="var(--accent, #2a6ac0)">${escapeHtml(e.label)}</text>` : ''}
    </g>`;
  }).join('');

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" style="max-width:${width}px">
    <defs>
      <marker id="cass-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="var(--accent, #2a6ac0)"/>
      </marker>
    </defs>
    ${edges}
    ${cells}
  </svg>`;
}

export function renderCassGrid(me) {
  const mount = document.getElementById('cass-grid-mount');
  if (mount) mount.innerHTML = cassGridSvg(me.cassGrid || { nodes: [], edges: [] });
}
