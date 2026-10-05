const master = location.pathname === '/master/admin/login';
const signup = !master && new URLSearchParams(location.search).has('signup');
const $ = (s) => document.querySelector(s);
if (signup) {
  document.title = 'Sign up · Page Tracker';
  $('#heading').textContent = 'Create your account';
  $('#intro').textContent = 'Your website must return HTTP 200 to complete signup.';
  $('#signup-fields').hidden = false;
  $('#name').required = $('#domain').required = true;
  $('#password').minLength = 12;
  $('#password').autocomplete = 'new-password';
  $('#submit').textContent = 'Create account';
  $('#switch').href = '/login.html';
  $('#switch').textContent = 'Already have an account? Log in';
}
if (master) {
  $('#heading').textContent = 'Master administrator';
  $('#intro').textContent = 'Log in to manage company recordings.';
  $('#switch').hidden = true;
  document.title = 'Master login · Page Tracker';
}
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#submit').disabled = true;
  if (signup) $('#submit').textContent = 'Checking website…';
  $('#feedback').textContent = '';
  const values = Object.fromEntries(new FormData(event.target));
  if (!signup) {
    delete values.name;
    delete values.company_domain;
  }
  try {
    const response = await fetch(
      '/api/auth/' + (master ? 'master/login' : signup ? 'signup' : 'login'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      },
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to sign in.');
    location.assign(master ? '/master/admin' : '/');
  } catch (error) {
    $('#feedback').textContent = error.message;
  } finally {
    $('#submit').disabled = false;
    if (signup) $('#submit').textContent = 'Create account';
  }
});
