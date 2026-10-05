import { mountShell } from './shell.js';
export async function api(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', ...options });
  if (response.status === 401) {
    location.replace(
      location.pathname.startsWith('/master/') || new URLSearchParams(location.search).has('master')
        ? '/master/admin/login'
        : '/login.html',
    );
    throw new Error('Please log in.');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
export async function account() {
  const { user } = await api('/api/auth/me');
  mountShell(user);
  document.querySelector('#account').textContent = user.name;
  document.querySelector('#logout').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
      location.replace(
        location.pathname.startsWith('/master/') ||
          new URLSearchParams(location.search).has('master')
          ? '/master/admin/login'
          : '/login.html',
      );
    } catch (error) {
      document.querySelector('#feedback').textContent = error.message;
    }
  });
  return user;
}
export const date = (value) => new Date(value).toLocaleString();
export const duration = (ms) =>
  Math.floor(ms / 60000) + ':' + String(Math.floor(ms / 1000) % 60).padStart(2, '0');

window.addEventListener('pageshow', (event) => {
  if (event.persisted) location.reload();
});
