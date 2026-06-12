document.getElementById('form-login').addEventListener('submit', async function (e) {
  e.preventDefault();
  const usuario = document.getElementById('usuario').value.trim();
  const password = document.getElementById('password').value;
  const errorEl = document.getElementById('login-error');
  errorEl.classList.add('hidden');

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario, password }),
    });

    if (res.status === 401) {
      errorEl.textContent = 'Usuario o contraseña incorrectos';
      errorEl.classList.remove('hidden');
      return;
    }

    if (!res.ok) {
      errorEl.textContent = 'Error al iniciar sesión. Intentá de nuevo.';
      errorEl.classList.remove('hidden');
      return;
    }

    const data = await res.json();
    location.replace(data.ver_dashboard === 1 ? '/index.html' : '/pages/envios.html');
  } catch {
    errorEl.textContent = 'No se pudo conectar con el servidor.';
    errorEl.classList.remove('hidden');
  }
});
