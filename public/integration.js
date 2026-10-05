import { account } from './account-api.js';
try {
  await account();
} catch (error) {
  document.querySelector('#feedback').textContent = error.message;
}
