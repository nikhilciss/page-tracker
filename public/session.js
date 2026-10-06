import { setupTabs } from './session-view.js';
setupTabs();
const analytics = new URLSearchParams(location.search).get('analytics');
if (!analytics) await import('./recording-session.js');
else await import('./semantic-session.js');
