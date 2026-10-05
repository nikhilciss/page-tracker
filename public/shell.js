export function mountShell(user) {
  document.body.classList.add('shell');
  const master = !!user.is_master,
    current = location.pathname;
  const aside = document.createElement('aside');
  aside.className = 'sidebar';
  aside.setAttribute('aria-label', 'Main navigation');
  aside.innerHTML =
    '<a class="brand" href="' +
    (master ? '/master/admin' : '/') +
    '"><span class="brand-mark">◉</span><span>PageTracker<small>SESSION INTELLIGENCE</small></span></a><div class="nav-label">WORKSPACE</div><nav></nav><div class="sidebar-foot"><strong>Your sessions. Your infrastructure.</strong>Self-hosted recording &amp; replay</div>';
  const links = master
    ? [
        ['▦', 'Companies', '/master/admin'],
        ['≡', 'Integration guide', '/integration.html'],
      ]
    : [
        ['▦', 'Session overview', '/'],
        ['◎', 'Profile & integration', '/profile.html'],
        ['≡', 'Integration guide', '/integration.html'],
      ];
  for (const [icon, label, url] of links) {
    const a = document.createElement('a');
    a.href = url;
    a.innerHTML =
      '<span class="nav-icon" aria-hidden="true">' + icon + '</span><span>' + label + '</span>';
    if (current === url || (url === '/' && current === '/session.html')) {
      a.className = 'active';
      a.setAttribute('aria-current', 'page');
    }
    aside.querySelector('nav').append(a);
  }
  document.body.prepend(aside);
  const toggle = document.createElement('button');
  toggle.className = 'nav-toggle';
  toggle.textContent = '☰';
  toggle.setAttribute('aria-label', 'Toggle navigation');
  toggle.setAttribute('aria-expanded', 'false');
  const backdrop = document.createElement('button');
  backdrop.className = 'nav-backdrop';
  backdrop.setAttribute('aria-label', 'Close navigation');
  const close = () => {
    document.body.classList.remove('nav-open');
    toggle.setAttribute('aria-expanded', 'false');
  };
  toggle.onclick = () => {
    const open = document.body.classList.toggle('nav-open');
    toggle.setAttribute('aria-expanded', String(open));
  };
  backdrop.onclick = close;
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  document.body.append(backdrop);
  document.querySelector('header').prepend(toggle);
}
