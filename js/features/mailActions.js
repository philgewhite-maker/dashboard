// The catalog of what a mail message can become — a declarative list only
// (id, label, whether it needs a picker before it can commit), same
// id-keyed-registry spirit as captureOutcomes.js's CAPTURE_OUTCOMES, but
// deliberately its own object rather than folded into that one: every
// CAPTURE_OUTCOMES entry is `commitMode: 'direct'` (a one-click write, see
// that file's own header comment), while 'tripLeg' here needs a target-trip
// picker and an AI extraction pass before it can commit — a genuinely
// different contract, not a fit for CAPTURE_OUTCOMES' run(ctx) shape.
//
// The actual picker/confirm logic for each action lives in mail.js, which
// already owns the DOM closures (message row state, the picker toggle
// mechanic) — this file only says what exists and how to show it, not how
// to run it. A topic (js/state.js's blankMailTopic) points at up to 3 of
// these ids as its preferred actions; anything not preferred for a given
// message's topic still shows under "Other actions".
// Icon convention across Mail's action buttons (this file and mail.js):
// ✨ = this control ALWAYS calls AI when clicked. 🪄 = this control resolves
// through a waterfall that tries something free/deterministic first and
// only calls AI when that's not enough (dateEvent's own extract button,
// mail.js). Since the icon carries the meaning, a label doesn't need to
// also spell out "AI" (aiTask's tooltip still does, for anyone relying on
// hover text rather than the glyph).
const MAIL_ACTIONS = {
task: { label: '+ task', title: 'Capture as a task', kind: 'direct' },
aiTask: { label: '✨ Task', title: 'Read the email and propose a task — title, notes, due date', kind: 'picker' },
tripLeg: { label: '+ trip leg', title: 'Pull flight/hotel/car-hire details from this email into a trip', kind: 'picker' },
dateEvent: { label: '+ date event', title: 'Add this as a Planner idea, optionally linked to a connection — reads the calendar invite or the email for a real date and venue', kind: 'picker' },
};

export { MAIL_ACTIONS };
