
/* RED MUSIC LOADING SCREENS V2
   USER: simple animated logo + brand progress.
   VIP+: richer animation + preserved "VIP CLIENT" label.
*/
(function () {
  function getRole() {
    try {
      const raw = localStorage.getItem('currentUser') ||
                  localStorage.getItem('user') ||
                  localStorage.getItem('redMusicUser');
      if (raw) {
        const u = JSON.parse(raw);
        return String(u.role || u.status || '').toUpperCase();
      }
    } catch (_) {}
    const text = (document.body && document.body.innerText || '').toUpperCase();
    if (text.includes('OWNER')) return 'OWNER';
    if (text.includes('CO-CREATOR')) return 'CO-CREATOR';
    if (text.includes('RUBY')) return 'RUBY';
    if (text.includes('VIP')) return 'VIP';
    return 'USER';
  }

  function buildLoader() {
    if (document.getElementById('rm-loading-screen')) return;
    const role = getRole();
    const premium = ['VIP','RUBY','CO-CREATOR','OWNER'].includes(role);

    const screen = document.createElement('div');
    screen.id = 'rm-loading-screen';
    screen.innerHTML = `
      <div class="rm-loader-inner">
        <div class="rm-logo-wrap">
          ${premium ? `<div class="rm-particles">
            <i></i><i></i><i></i><i></i><i></i><i></i>
          </div>` : ''}
          <div class="rm-logo-ring"></div>
          ${premium ? `<div class="rm-logo-ring r2"></div>` : ''}
          <div class="rm-logo"><span class="red">Red</span><span class="white">Music</span></div>
        </div>
        ${premium ? '' : '<div class="rm-spinner"></div>'}
        <div class="rm-progress"></div>
        ${premium ? '<div class="rm-vip-badge">VIP CLIENT</div>' : ''}
      </div>`;
    document.documentElement.appendChild(screen);

    const duration = premium ? 1900 : 1200;
    window.setTimeout(() => screen.classList.add('rm-hidden'), duration);
    window.setTimeout(() => screen.remove(), duration + 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildLoader, {once:true});
  } else {
    buildLoader();
  }
})();
