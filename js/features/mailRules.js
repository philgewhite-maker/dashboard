// The sender/subject-match sibling of data.prefs.captureRules' marker/
// suffix triggers (js/features/captureOutcomes.js) -- a mail RULE
// (data.mailRules, js/state.js's blankMailRule) matches a message by its
// own from/subject instead of a hand-typed marker, created from a real
// email via the Mail panel's "Add rule" action and auto-running on every
// "Refresh mail" from then on. Shared with mail.js's own subject-marker
// path (processMailMarkers) via runOutcomeOnMessage, so there's one copy
// of the direct/draft branching rather than two near-identical ones.
import { data, queueSave, blankCaptureDraft } from '../state.js';
import { CAPTURE_OUTCOMES } from './captureOutcomes.js';

// Plain substring match, case-insensitive, AND across whichever of
// from/subject are actually set on the rule (an empty field means "don't
// filter on this one") -- not a Gmail query like MAIL_SEARCH_KINDS' own
// 'from'/'subject' kinds, since a rule only ever evaluates against
// messages already fetched by the existing searches, never builds a
// query of its own.
function matchMailRule(rules, m) {
return rules.find((r) =>
(!r.from || (m.from || '').toLowerCase().includes(r.from.toLowerCase())) &&
(!r.subject || (m.subject || '').toLowerCase().includes(r.subject.toLowerCase()))
) || null;
}

// Runs one CAPTURE_OUTCOMES entry against one message -- a direct
// outcome writes a real record immediately; a draft outcome runs its
// (possibly AI) extraction now and lands the result in Capture Drafts
// for review, same shape every other capture sense already follows.
// Returns which branch ran ('direct'|'draft') so a caller can tally a
// status note, or null if the outcome id doesn't exist (a rule left
// pointing at a since-removed outcome).
async function runOutcomeOnMessage(outcomeKey, m) {
const outcome = CAPTURE_OUTCOMES[outcomeKey];
if (!outcome) return null;
if (outcome.commitMode === 'draft') {
const step = await outcome.buildStep({ mailMessageId: m.id, subject: m.subject, from: m.from, url: m.link });
data.captureDrafts.unshift(blankCaptureDraft({
rawText: m.subject, steps: [step],
source: { kind: 'mail', label: m.subject, url: m.link },
}));
return 'draft';
}
await outcome.run({ title: m.subject, url: m.link, source: { kind: 'mail', label: m.subject, url: m.link } });
return 'direct';
}

// Every OPEN message checked against every mail rule, run on a match --
// the automatic sibling of processMailMarkers (mail.js), called
// alongside it on every "Refresh mail". `messageStatus` is passed in
// rather than imported, since it's mail.js's own closure (reads
// existingTaskFor/existingTripLegFor/existingDateEventFor, all scoped to
// that file) -- same message a caller already has in hand. A message is
// only ever matched once per refresh (the first rule that matches wins,
// same "first match" convention matchCaptureRule's own callers already
// follow) and, once processed, messageStatus() itself keeps it from ever
// being re-offered on a later refresh -- no separate bookkeeping needed
// here, same as the subject-marker path's own "runs once" guarantee.
async function processMailRules(sections, messageStatus) {
let direct = 0, drafted = 0;
for (const { messages } of sections) {
for (const m of messages) {
if (messageStatus(m) !== 'open') continue;
const rule = matchMailRule(data.mailRules, m);
if (!rule) continue;
try {
const result = await runOutcomeOnMessage(rule.outcome, m);
if (result === 'draft') drafted++; else if (result === 'direct') direct++;
} catch (err) {
console.error(`Mail rule "${rule.label || rule.id}" failed for "${m.subject}":`, err);
}
}
}
if (direct || drafted) queueSave();
const parts = [];
if (direct) parts.push(`${direct} auto-processed`);
if (drafted) parts.push(`${drafted} queued for review`);
return parts.join(', ');
}

export { matchMailRule, runOutcomeOnMessage, processMailRules };
