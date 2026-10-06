import { api, account } from './account-api.js';
const $ = (s) => document.querySelector(s);
try {
  const user = await account();
  if (user.is_master) location.replace('/master/admin');
  else {
    $('#profile-name').textContent = user.name;
    $('#profile-email').textContent = $('#profile-email-detail').textContent = user.email;
    $('#profile-domain').textContent = user.company_origin;
    $('#initials').textContent = user.name.slice(0, 2).toUpperCase();
    const integration = await api('/api/account/integration');
    $('#connection-status').textContent = integration.verified
      ? 'Website checked • Ready to record'
      : 'This legacy account has not passed the website check. Contact your administrator.';
    const policy = integration.recording_policy;
    $('#recording-policy').textContent = policy
      ? 'Success-only recording enabled. Required match: ' +
        [policy.path, policy.selector].filter(Boolean).join(' and ') +
        '. Install this same tag on every form, validation-error and success page, usually in your shared layout. Submit attempts remain temporary until the rule matches. HTTP 200 alone does not finalize a video.'
      : 'Recording saves on page actions. Success-only mode can be configured by the tracker administrator using RECORDING_SUCCESS_RULES.';
    $('#script-snippet').textContent =
      '<script src="' + location.origin + '/tracker.js" defer></script>';
  }
} catch (error) {
  $('#feedback').textContent = error.message;
}
$('#copy-script').onclick = async () => {
  const value = $('#script-snippet').textContent;
  try {
    if (navigator.clipboard && isSecureContext) await navigator.clipboard.writeText(value);
    else {
      const input = document.createElement('textarea');
      input.value = value;
      document.body.append(input);
      input.select();
      const ok = document.execCommand('copy');
      input.remove();
      if (!ok) throw new Error();
    }
    $('#copy-script').textContent = 'Copied';
  } catch {
    $('#feedback').textContent = 'Select the script and copy it manually.';
  }
};
