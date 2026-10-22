import { API_BASE } from './config.js';

const TOKEN_KEY = 'switchadvisor-invite-token';

export function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
export function setToken(token) { localStorage.setItem(TOKEN_KEY, token); }

export class ApiError extends Error {}

async function call(action, { method = 'GET', body, auth = true, admin = false } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (auth) headers['X-Invite-Token'] = getToken();
  if (admin) headers['X-Admin-Secret'] = sessionStorage.getItem('switchadvisor-admin-secret') || '';
  const res = await fetch(`${API_BASE}?action=${action}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.error || `Request failed (${res.status})`);
  return json;
}

export const redeemInvite = (token) => call('redeem', { method: 'POST', body: { token }, auth: false });
export const getMe = () => call('me');
export const updateProfile = (fields) => call('update-profile', { method: 'POST', body: fields });
export const upsertAccount = (account) => call('account-upsert', { method: 'POST', body: { account } });
export const deleteAccount = (id) => call('account-delete', { method: 'POST', body: { id } });
export const getBankList = () => call('banklist', { auth: false });
export const getReferralInfo = () => call('referrals', { auth: false });
export const createInvite = (label) => call('invite-create', { method: 'POST', body: { label }, auth: false, admin: true });
export const listInvites = () => call('invite-list', { auth: false, admin: true });
