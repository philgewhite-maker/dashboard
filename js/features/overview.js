import { data } from '../state.js';
import { escapeHtml } from '../utils.js';

function ageDecade(age) {
const n = parseInt(age, 10);
if (isNaN(n)) return null;
return `${Math.floor(n / 10) * 10}s`;
}

function groupConnectionsBy(getKeys) {
const groups = {};
data.connections.forEach((c) => {
const keys = getKeys(c);
keys.forEach((k) => {
if (!k) return;
if (!groups[k]) groups[k] = [];
groups[k].push(c);
});
});
return groups;
}

function overviewDimension(title, groups) {
const keys = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
if (keys.length === 0) return '';
const chips = keys.map((k) => `<button class="overview-chip" data-overview-key="${escapeHtml(k)}">${escapeHtml(k)} (${groups[k].length})</button>`).join('');
return `<div class="overview-group"><h3>${escapeHtml(title)}</h3><div class="overview-chips">${chips}</div></div>`;
}

function renderOverview() {
const el = document.getElementById('overview-content');
if (data.connections.length === 0) {
el.innerHTML = '<div class="empty">Add some connections to see them grouped here.</div>';
return;
}
const byLocation = groupConnectionsBy((c) => [c.location].filter(Boolean));
const byLanguage = groupConnectionsBy((c) => c.languages || []);
const byNationality = groupConnectionsBy((c) => c.nationality || []);
const byAge = groupConnectionsBy((c) => [ageDecade(c.age)].filter(Boolean));
const byTags = groupConnectionsBy((c) => c.tags || []);
const byStage = groupConnectionsBy((c) => [c.stage].filter(Boolean));

el.innerHTML = [
overviewDimension('Stage', byStage),
overviewDimension('Location', byLocation),
overviewDimension('Language', byLanguage),
overviewDimension('Nationality', byNationality),
overviewDimension('Age', byAge),
overviewDimension('Tags', byTags),
].filter(Boolean).join('') || '<div class="empty">Add locations, languages, nationality, ages, or tags to your connections to see them grouped here.</div>';

el.querySelectorAll('.overview-chip').forEach((chip) => {
chip.addEventListener('click', () => {
const key = chip.dataset.overviewKey;
const searchInput = document.getElementById('conn-search');
searchInput.value = key;
searchInput.dispatchEvent(new Event('input'));
searchInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
});
}

export { renderOverview };
