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
// For the rare email the one-click actions above get wrong -- an order
// covering more than one separate thing, something easy to miscategorise.
// Never a topic's preferred action (nothing above is either, by design --
// see js/features/mail.js's own dialog), always reachable under "Other
// actions" on every message.
complex: { label: '🪄 Complex…', title: 'Tell it what this email actually is and what you want out of it, then route to Task / Date event(s) / Trip leg', kind: 'picker' },
// Independent of creating any dashboard record at all -- just makes sure
// a real calendar invite on this email is actually reflected on Google
// Calendar (adopts an existing hand-typed/Gmail-imported event instead of
// duplicating it, same search-first discipline airbnb.js's own push
// already uses). Shown on every message, same reasoning as 'complex'
// above -- the list view has no attachment metadata to gate on without
// an extra fetch per row, so whether there's actually an invite is
// discovered when this is opened, not before.
checkCalendar: { label: '📅 Check calendar', title: "Parse any calendar invite on this email and make sure it's reflected on your real Google Calendar", kind: 'picker' },
// Creates a data.mailRules row (js/state.js's blankMailRule) matching
// THIS message's own from/subject, runs it on this message immediately,
// then auto-runs on every future "Refresh mail" too -- the sender/
// subject-match sibling of the marker/suffix system (data.prefs.
// captureRules) already used for images, shared URLs, and email subject
// markers. Deliberately excluded from a topic's own preferredActionIds
// choices in Settings (js/features/settings.js's renderMailTopics) --
// "create a rule" isn't a sensible thing to promote to a topic's own
// quick-action row, it still shows in every message's "Other actions".
addRule: { label: '+ rule', title: 'Auto-run an action for every future email from this sender/subject, starting with this one', kind: 'picker' },
};

export { MAIL_ACTIONS };
