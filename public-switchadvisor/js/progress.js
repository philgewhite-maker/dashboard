// Everything the person has ticked, answered or been shown, kept in this browser
// only -- like their salary figures, none of it goes to the server. Step ids come
// from the server and are stable across rebuilds of the plan, so a tick survives
// the plan being recalculated.
//
//   steps:    { [stepId]: { done, answer, at } }   a tick, or a branch answered
//   accepted: { plan, digest, inputSig, builtAt, carried: [cards] } | null
//             the plan the person is following. It is frozen: new offers never
//             rewrite it under them, they are offered as an update.
//   flags:    small one-off facts (wizard position, "no accounts", dismissed prompts)
const KEY = 'switchadvisor-progress';

let cache = null;

function blank() { return { steps: {}, accepted: null, flags: {} }; }

function load() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || 'null');
    cache = parsed && typeof parsed === 'object' ? { ...blank(), ...parsed } : blank();
  } catch (e) { cache = blank(); }
  return cache;
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (e) { /* private mode: it just won't be remembered */ }
}

export function stepState(id) { return load().steps[id] || {}; }

export function patchStep(id, patch) {
  const s = load();
  const next = { ...(s.steps[id] || {}), ...patch };
  if (patch.done === false) delete next.done;
  if (patch.answer === '' || patch.answer === null) delete next.answer;
  if (Object.keys(next).length === 0) delete s.steps[id]; else s.steps[id] = next;
  save();
}

// Forget a step and everything underneath it (its branch answers and sub-ticks).
export function clearStepTree(id) {
  const s = load();
  Object.keys(s.steps).forEach((k) => { if (k === id || k.startsWith(`${id}~`)) delete s.steps[k]; });
  save();
}

export function hasAnyProgress(prefix) {
  return Object.keys(load().steps).some((k) => k.startsWith(prefix) && (load().steps[k].done || load().steps[k].answer));
}

export function getAccepted() { return load().accepted; }
export function setAccepted(a) { load().accepted = a; save(); }

export function getFlag(name, fallback = null) {
  const v = load().flags[name];
  return v === undefined ? fallback : v;
}
export function setFlag(name, value) {
  const s = load();
  if (value === null || value === undefined) delete s.flags[name]; else s.flags[name] = value;
  save();
}

// A short fingerprint of everything the person controls (accounts, figures, options),
// so the page can tell "you changed your details" from "the offers moved".
export function fingerprint(obj) {
  const text = JSON.stringify(obj);
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
