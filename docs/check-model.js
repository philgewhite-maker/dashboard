// Drift check for docs/data-model.html. Run on the live site's console:
//   const r = await import('./docs/check-model.js').then((m) => m.checkModel()); console.table(r.dangling); r
// Reports: top-level keys the doc doesn't know about, documented keys that no
// longer exist, and references pointing at a record that is gone.
import { data } from '../js/state.js';

export async function checkModel() {
  const model = await (await fetch(new URL('./data-model.json', import.meta.url))).json();
  const documented = new Set(Object.values(model.groups).flat());
  const actual = Object.keys(data);
  const undocumented = actual.filter((k) => !documented.has(k));
  const gone = [...documented].filter((k) => !(k in data));
  const dangling = [];
  model.fks.forEach(([src, field, tgt]) => {
    const targets = new Set((data[tgt] || []).map((x) => x.id));
    let refs = 0; let bad = 0;
    (data[src] || []).forEach((r) => {
      [].concat(r[field]).forEach((v) => {
        if (v === undefined || v === null || v === '') return;
        refs++;
        if (!targets.has(v)) bad++;
      });
    });
    if (bad) dangling.push({ ref: `${src}.${field} -> ${tgt}`, refs, dangling: bad });
  });
  return { verifiedAgainst: model.verifiedAgainst, undocumented, gone, dangling };
}
