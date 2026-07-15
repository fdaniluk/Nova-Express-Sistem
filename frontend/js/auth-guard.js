(function () {
  document.body.style.visibility = 'hidden';

  fetch('/api/auth/me')
    .then(function (res) {
      if (res.status === 401) {
        location.replace('/pages/login.html');
        return;
      }
      return res.json().then(function (user) {
        window.currentUser = user;

        if (user.ver_dashboard !== 1) {
          document.querySelectorAll(
            'a[href="/index.html"], a[href="../index.html"], a[href="index.html"]'
          ).forEach(function (el) {
            el.style.display = 'none';
          });
          const path = window.location.pathname;
          if (path === '/' || path === '/index.html') {
            location.replace('/pages/envios.html');
            return;
          }
        }

        if (user.rol !== 'admin') {
          document.querySelectorAll(
            'a[href="usuarios.html"], a[href="pages/usuarios.html"], a[href="/pages/usuarios.html"], ' +
            'a[href="configuracion.html"], a[href="pages/configuracion.html"], a[href="/pages/configuracion.html"]'
          ).forEach(function (el) {
            el.style.display = 'none';
          });
          const path = window.location.pathname;
          if (path.endsWith('usuarios.html') || path.endsWith('configuracion.html')) {
            location.replace('/pages/envios.html');
            return;
          }
        }

        const btnLogout = document.getElementById('btn-logout');
        if (btnLogout) {
          btnLogout.addEventListener('click', function () {
            fetch('/api/auth/logout', { method: 'POST' }).finally(function () {
              location.replace('/pages/login.html');
            });
          });
        }

        document.body.style.visibility = '';
      });
    })
    .catch(function () {
      document.body.style.visibility = '';
    });
})();
