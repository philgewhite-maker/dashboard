import { API_BASE } from './config.js';

const TOKEN_KEY = 'switchadvisor-invite-token';

export function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
export function setToken(token) { localStorage.setItem(TOKEN_KEY, token); }

// Salary figures never leave this browser except inside a request: they are
// sent with each "me" call, used for that answer, and not stored on the server.
const PROFILE_KEY = 'switchadvisor-live-profile';
export function getLiveProfile() {
  try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}') || {}; } catch (e) { return {}; }
}
export function setLiveProfile(p) {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch (e) { /* private mode: it just won't be remembered */ }
}

export class ApiError extends Error {}

async function call(action, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (auth) headers['X-Invite-Token'] = getToken();
  const res = await fetch(`${API_BASE}?action=${action}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.error || `Request failed (${res.status})`);
  return json;
}

export const redeemInvite = (token) => call('redeem', { method: 'POST', body: { token }, auth: false });
export const getMe = () => call('me', { method: 'POST', body: getLiveProfile() });
export const upsertAccount = (account) => call('account-upsert', { method: 'POST', body: { account } });
export const deleteAccount = (id) => call('account-delete', { method: 'POST', body: { id } });
export const getBankList = () => call('banklist', { auth: false });
export const getReferralInfo = () => call('referrals', { auth: false });
