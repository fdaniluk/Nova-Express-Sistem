(function () {
  // Cambio de módulo sin pantalla en blanco (03/11/2026). Antes, cada pantalla arrancaba
  // oculta hasta que el servidor contestaba /api/auth/me, y ese hueco era lo que se veía
  // feo al pasar de un módulo a otro. Ahora el usuario se recuerda en el navegador
  // (localStorage nova_me): si está, la pantalla se dibuja al instante con los permisos
  // de ese usuario y la verificación contra el servidor corre en segundo plano. Si la
  // sesión venció, el servidor contesta 401 y se va al login igual que antes; si el
  // usuario cambió de permisos, la pantalla se recarga sola con los nuevos. La primera
  // vez (sin nada recordado) se comporta como siempre: oculta hasta la respuesta.
  var KEY = 'nova_me';
  var cacheado = null;
  try { cacheado = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { cacheado = null; }
  if (!cacheado || typeof cacheado !== 'object' || !cacheado.rol) cacheado = null;

  // Esconde los ítems del menú que el usuario no puede ver y lo saca de la pantalla si
  // entró por URL. Devuelve true si redirigió. Se puede llamar más de una vez.
  // `soloMirar`: no redirige, solo dice si HABRÍA que redirigir (se usa con el usuario
  // recordado: una redirección por un dato viejo del navegador mandaba al admin a Envíos
  // cuando entraba a Usuarios después de que otro usuario usó la misma PC, 04/11/2026).
  function aplicar(user, soloMirar) {
    var path = window.location.pathname;
    var irA = function (destino) { if (!soloMirar) location.replace(destino); return true; };

    if (user.ver_dashboard !== 1) {
      document.querySelectorAll(
        'a[href="/index.html"], a[href="../index.html"], a[href="index.html"]'
      ).forEach(function (el) {
        el.style.display = 'none';
      });
      if (path === '/' || path === '/index.html') return irA('/pages/envios.html');
    }

    if (user.rol !== 'admin') {
      document.querySelectorAll(
        'a[href="usuarios.html"], a[href="pages/usuarios.html"], a[href="/pages/usuarios.html"], ' +
        'a[href="comisiones.html"], a[href="pages/comisiones.html"], a[href="/pages/comisiones.html"]'
      ).forEach(function (el) {
        el.style.display = 'none';
      });
      if (path.endsWith('usuarios.html') || path.endsWith('comisiones.html')) return irA('/pages/envios.html');
    }

    // Configuración: visible para admin O usuarios con editar_config = 1.
    if (user.rol !== 'admin' && user.editar_config !== 1) {
      document.querySelectorAll(
        'a[href="configuracion.html"], a[href="pages/configuracion.html"], a[href="/pages/configuracion.html"]'
      ).forEach(function (el) {
        el.style.display = 'none';
      });
      if (path.endsWith('configuracion.html')) return irA('/pages/envios.html');
    }

    // Panel de salud: visible para admin O usuarios con ver_salud = 1.
    // Misma forma que Configuracion, incluido el redirect si alguien entra por URL.
    if (user.rol !== 'admin' && user.ver_salud !== 1) {
      document.querySelectorAll(
        'a[href="salud.html"], a[href="pages/salud.html"], a[href="/pages/salud.html"]'
      ).forEach(function (el) {
        el.style.display = 'none';
      });
      if (path.endsWith('salud.html')) return irA('/pages/envios.html');
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
    return false;
  }

  if (cacheado && aplicar(cacheado, true)) {
    // El usuario recordado no podría estar en esta pantalla: puede ser un dato viejo (otro
    // usuario en la misma PC, permisos cambiados). No se redirige por eso: se espera al
    // servidor como la primera vez.
    cacheado = null;
  }
  if (cacheado) {
    window.currentUser = cacheado;
    aplicar(cacheado, false);
  } else {
    document.body.style.visibility = 'hidden';
  }

  fetch('/api/auth/me')
    .then(function (res) {
      if (res.status === 401) {
        try { localStorage.removeItem(KEY); } catch (e) { /* sin storage */ }
        location.replace('/pages/login.html');
        return;
      }
      return res.json().then(function (user) {
        var json = JSON.stringify(user);
        try { localStorage.setItem(KEY, json); } catch (e) { /* sin storage */ }
        // Se dibujó con un usuario recordado que ya no es el que dice el servidor
        // (cambio de permisos, u otro usuario en la misma PC): se vuelve a cargar
        // limpio con el usuario real.
        if (cacheado && JSON.stringify(cacheado) !== json) {
          location.reload();
          return;
        }
        window.currentUser = user;
        // Aviso para las pantallas que dibujan botones con data-perm después de cargar.
        try { window.dispatchEvent(new CustomEvent('nova:usuario', { detail: user })); } catch (e) { /* navegador viejo */ }

        if (aplicar(user)) return;

        const btnLogout = document.getElementById('btn-logout');
        if (btnLogout) {
          btnLogout.addEventListener('click', function () {
            try { localStorage.removeItem(KEY); } catch (e) { /* sin storage */ }
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
