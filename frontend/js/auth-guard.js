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
            'a[href="usuarios.html"], a[href="pages/usuarios.html"], a[href="/pages/usuarios.html"]'
          ).forEach(function (el) {
            el.style.display = 'none';
          });
          const path = window.location.pathname;
          if (path.endsWith('usuarios.html')) {
            location.replace('/pages/envios.html');
            return;
          }
        }

        // Configuración: visible para admin O usuarios con editar_config = 1.
        if (user.rol !== 'admin' && user.editar_config !== 1) {
          document.querySelectorAll(
            'a[href="configuracion.html"], a[href="pages/configuracion.html"], a[href="/pages/configuracion.html"]'
          ).forEach(function (el) {
            el.style.display = 'none';
          });
          const path = window.location.pathname;
          if (path.endsWith('configuracion.html')) {
            location.replace('/pages/envios.html');
            return;
          }
        }

        // Panel de salud: visible para admin O usuarios con ver_salud = 1.
        // Misma forma que Configuracion, incluido el redirect si alguien entra por URL.
        if (user.rol !== 'admin' && user.ver_salud !== 1) {
          document.querySelectorAll(
            'a[href="salud.html"], a[href="pages/salud.html"], a[href="/pages/salud.html"]'
          ).forEach(function (el) {
            el.style.display = 'none';
          });
          const path = window.location.pathname;
          if (path.endsWith('salud.html')) {
            location.replace('/pages/envios.html');
            return;
          }
        }

        // Permisos sueltos DENTRO de una pantalla (no pantallas enteras): cualquier
        // elemento con data-perm="<permiso>" se esconde si el usuario no lo tiene. El
        // admin siempre lo tiene. Lo usa el bloque de Cierre de periodo en Salidas: la
        // pantalla la ve todo el mundo, pero llevarse la planilla del mes entero no.
        // Es solo la capa visual — el que manda es el middleware del backend.
        document.querySelectorAll('[data-perm]').forEach(function (el) {
          var permiso = el.getAttribute('data-perm');
          if (user.rol !== 'admin' && user[permiso] !== 1) el.style.display = 'none';
        });

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
