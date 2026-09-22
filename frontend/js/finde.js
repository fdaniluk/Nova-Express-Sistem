/* Cierre de semana — festejo al bajar el cierre de LA SEMANA desde Salidas.
   Versión 2 (pedido de Felipe, 22/09/2026): sin pasaje ni números. Un avión de papel
   entra volando, "explota" en el centro en una lluvia de confeti de muchos colores, y de
   ahí aparece grande una foto del equipo con un mensaje corto. Las salidas siguen atrás
   con un velo. Sin librerías. Se cierra con clic, Esc o sola a los 14 s.
   NovaFinde.celebrar({ filas, quien }).  Demo: Salidas con ?finde=demo. */
(function () {
  const AZUL = '#2A3661', NARANJA = '#EA6749', HIELO = '#EAF1F8';
  const COLORES = ['#EA6749', '#2A3661', '#F5C542', '#4CC9A6', '#5B8DEF', '#FF7EB6', '#9B6BFF', '#FF9F43', '#ffffff', '#EAF1F8', '#3ED598', '#FF5E5E'];
  const FRASES = [
    'Se terminó la semana. ¡A disfrutar!',
    '¡Cerró la semana! A descansar.',
    'Semana cumplida. ¡Buen finde!',
    'Se cerró la semana. ¡A disfrutar el fin de semana!',
    'Listo. ¡Buen fin de semana para todos!',
    'Otra semana en el aire. ¡A descansar!',
  ];
  const pick = (a) => a[Math.floor(Math.random() * a.length)];

  const CSS = `
  .fd-velo{position:fixed;inset:0;z-index:99990;background:rgba(42,54,97,.42);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);opacity:0;transition:opacity .5s ease;cursor:pointer}
  .fd-velo.on{opacity:1}
  .fd-canvas{position:fixed;inset:0;z-index:99991;pointer-events:none}
  .fd-avion{position:fixed;z-index:99992;width:110px;height:110px;left:0;top:0;pointer-events:none;filter:drop-shadow(0 12px 16px rgba(0,0,0,.3));will-change:transform,opacity}
  .fd-avion.puf{transition:transform .28s ease-in,opacity .28s ease-in;opacity:0}
  .fd-onda{position:fixed;z-index:99992;left:0;top:0;width:40px;height:40px;margin:-20px 0 0 -20px;border-radius:50%;border:6px solid #fff;pointer-events:none;opacity:0}
  .fd-onda.on{animation:fd-onda .9s cubic-bezier(.2,.8,.3,1) forwards}
  @keyframes fd-onda{0%{transform:scale(.2);opacity:.9}100%{transform:scale(9);opacity:0;border-width:1px}}
  .fd-foto{position:fixed;z-index:99993;left:50%;top:50%;width:min(720px,88vw);transform:translate(-50%,-50%) scale(.15);opacity:0;border-radius:22px;overflow:hidden;background:#0f1530;box-shadow:0 0 0 6px rgba(255,255,255,.92),0 50px 110px rgba(0,0,0,.5),0 6px 18px rgba(0,0,0,.25);cursor:pointer;font-family:'Segoe UI',system-ui,-apple-system,sans-serif}
  .fd-foto.on{animation:fd-foto .8s cubic-bezier(.2,1.3,.35,1) forwards}
  .fd-foto.off{transition:transform .4s ease-in,opacity .4s ease-in;transform:translate(-50%,-40%) scale(.85)!important;opacity:0!important}
  @keyframes fd-foto{0%{transform:translate(-50%,-50%) scale(.15);opacity:0}55%{opacity:1}100%{transform:translate(-50%,-50%) scale(1);opacity:1}}
  .fd-foto img{display:block;width:100%;max-height:66vh;object-fit:cover;background:${HIELO}}
  .fd-foto .fd-msg{position:absolute;left:0;right:0;bottom:0;padding:70px 34px 30px;background:linear-gradient(180deg,rgba(15,21,48,0) 0%,rgba(15,21,48,.55) 45%,rgba(15,21,48,.9) 100%);color:#fff;font-size:clamp(22px,3vw,36px);font-weight:800;letter-spacing:-.4px;line-height:1.15;text-shadow:0 2px 10px rgba(0,0,0,.35)}
  .fd-foto .fd-msg em{font-style:normal;color:#FFB86B}
  .fd-foto .fd-tag{position:absolute;left:22px;top:20px;display:inline-flex;align-items:center;gap:8px;padding:7px 12px 7px 9px;border-radius:999px;background:rgba(255,255,255,.92);color:${AZUL};font-size:11px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;box-shadow:0 4px 14px rgba(0,0,0,.2)}
  .fd-foto .fd-tag i{display:block;width:10px;height:10px;border-radius:50%;background:${NARANJA}}
  .fd-foto.sinfoto{background:${AZUL};padding:110px 40px 40px}
  .fd-foto.sinfoto .fd-msg{position:static;background:none;padding:0;font-size:clamp(26px,3.6vw,44px)}
  .fd-pie{position:fixed;z-index:99993;left:50%;bottom:22px;transform:translateX(-50%);color:#fff;font:600 12px/1 'Segoe UI',system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;opacity:0;transition:opacity .5s;pointer-events:none;text-shadow:0 1px 6px rgba(0,0,0,.5)}
  .fd-pie.on{opacity:.85}
  `;
  function css() {
    if (document.getElementById('fd-css')) return;
    const s = document.createElement('style'); s.id = 'fd-css'; s.textContent = CSS; document.head.appendChild(s);
  }
  const AVION = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <path d="M6 52 L92 18 L60 88 L48 60 Z" fill="#ffffff" stroke="${AZUL}" stroke-width="3.5" stroke-linejoin="round"/>
    <path d="M6 52 L48 60 L92 18 Z" fill="${NARANJA}" stroke="${AZUL}" stroke-width="3.5" stroke-linejoin="round"/>
    <path d="M48 60 L60 88 L56 66 Z" fill="${HIELO}" stroke="${AZUL}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M48 60 L92 18" stroke="${AZUL}" stroke-width="3" stroke-linecap="round"/></svg>`;

  // ── Confeti: explosión + lluvia continua ─────────────────────────────────────
  function motor(canvas) {
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => { canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    resize(); addEventListener('resize', resize);
    const piezas = []; let raf, lluvia = 0, vivo = true;
    const pieza = (x, y, vx, vy) => ({
      x, y, vx, vy, w: 6 + Math.random() * 8, h: 8 + Math.random() * 10, color: pick(COLORES),
      rot: Math.random() * Math.PI * 2, vr: (Math.random() - .5) * .35, fase: Math.random() * Math.PI * 2,
      tipo: Math.random() < .2 ? 'cinta' : Math.random() < .3 ? 'circ' : 'papel',
    });
    const paso = () => {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      if (lluvia > 0) for (let i = 0; i < lluvia; i++) piezas.push(pieza(Math.random() * innerWidth, -20, (Math.random() - .5) * 1.5, 2 + Math.random() * 3));
      for (let i = piezas.length - 1; i >= 0; i--) {
        const p = piezas[i];
        p.fase += .07; p.vx *= .98; p.vy = Math.min(p.vy * .98 + .25, 7); p.x += p.vx + Math.sin(p.fase) * .9; p.y += p.vy; p.rot += p.vr;
        if (p.y > innerHeight + 40 || p.x < -60 || p.x > innerWidth + 60) { piezas.splice(i, 1); continue; }
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.color; ctx.globalAlpha = .96;
        const sx = Math.cos(p.fase * 1.6);
        if (p.tipo === 'circ') { ctx.beginPath(); ctx.ellipse(0, 0, p.w * .55, p.w * .55 * Math.max(.15, Math.abs(sx)), 0, 0, Math.PI * 2); ctx.fill(); }
        else if (p.tipo === 'cinta') { ctx.fillRect(-p.w * .25 * sx, -p.h, p.w * .5 * sx, p.h * 2.2); }
        else ctx.fillRect(-p.w / 2 * sx, -p.h / 2, p.w * sx, p.h);
        ctx.restore();
      }
      if (vivo || piezas.length) raf = requestAnimationFrame(paso);
    };
    raf = requestAnimationFrame(paso);
    return {
      explotar: (x, y, n, fuerza) => { for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2, f = fuerza * (.35 + Math.random()); piezas.push(pieza(x, y, Math.cos(a) * f, Math.sin(a) * f - 4)); } },
      lluvia: (n) => { lluvia = n; },
      parar: () => { vivo = false; lluvia = 0; },
      destruir: () => { vivo = false; cancelAnimationFrame(raf); removeEventListener('resize', resize); },
    };
  }

  // Vuelo hasta el centro por una curva, con un pequeño zigzag, y frenada.
  function volar(el, dur, alLlegar) {
    const W = innerWidth, H = innerHeight, cx = W / 2, cy = H * .46;
    const P0 = { x: -140, y: H * .85 }, P1 = { x: W * .18, y: H * 1.02 }, P2 = { x: W * .38, y: H * .1 }, P3 = { x: cx, y: cy };
    const B = (t, a, b, c, d) => (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d;
    const ease = (t) => 1 - Math.pow(1 - t, 2.2);
    const t0 = performance.now();
    const paso = (now) => {
      const t = ease(Math.min(1, (now - t0) / dur));
      const x = B(t, P0.x, P1.x, P2.x, P3.x), y = B(t, P0.y, P1.y, P2.y, P3.y);
      const t2 = Math.min(1, t + .01);
      const ang = Math.atan2(B(t2, P0.y, P1.y, P2.y, P3.y) - y, B(t2, P0.x, P1.x, P2.x, P3.x) - x);
      const esc = .8 + t * .5;
      el.style.transform = `translate(${x - 55}px,${y - 55}px) rotate(${ang + .35}rad) scale(${esc})`;
      if (t < 1) requestAnimationFrame(paso); else alLlegar(cx, cy);
    };
    requestAnimationFrame(paso);
  }

  async function fotoAlAzar() {
    try {
      const r = await fetch('/api/salidas/finde-fotos', { credentials: 'same-origin' });
      const j = await r.json();
      return (j.fotos && j.fotos.length) ? pick(j.fotos) : null;
    } catch { return null; }
  }
  const frase = () => pick(FRASES).replace(/(¡[^!]+!)/, '<em>$1</em>');

  async function celebrar() {
    css();
    const foto = await fotoAlAzar();
    // La foto se precarga para que aparezca de golpe, no cargándose.
    if (foto) await new Promise((ok) => { const i = new Image(); i.onload = i.onerror = ok; i.src = foto; });
    const velo = document.createElement('div'); velo.className = 'fd-velo';
    const cv = document.createElement('canvas'); cv.className = 'fd-canvas';
    const avion = document.createElement('div'); avion.className = 'fd-avion'; avion.innerHTML = AVION;
    const onda = document.createElement('div'); onda.className = 'fd-onda';
    const card = document.createElement('div'); card.className = 'fd-foto' + (foto ? '' : ' sinfoto');
    card.innerHTML = `${foto ? `<img src="${foto}" alt="">` : ''}<span class="fd-tag"><i></i>Cierre de semana</span><div class="fd-msg">${frase()}</div>`;
    const pie = document.createElement('div'); pie.className = 'fd-pie'; pie.textContent = 'clic para cerrar';
    document.body.append(velo, cv, avion, onda, card, pie);
    const m = motor(cv);
    requestAnimationFrame(() => velo.classList.add('on'));

    let cerrado = false;
    const cerrar = () => {
      if (cerrado) return; cerrado = true;
      card.classList.add('off'); velo.classList.remove('on'); pie.classList.remove('on'); m.parar();
      removeEventListener('keydown', onKey);
      setTimeout(() => { m.destruir(); [velo, cv, avion, onda, card, pie].forEach((e) => e.remove()); }, 600);
    };
    const onKey = (e) => { if (e.key === 'Escape') cerrar(); };
    addEventListener('keydown', onKey);
    velo.addEventListener('click', cerrar); card.addEventListener('click', cerrar);

    setTimeout(() => volar(avion, 1700, (cx, cy) => {
      // ¡Puf! el avión desaparece, onda expansiva, explosión y lluvia de confeti.
      avion.classList.add('puf'); avion.style.transform += ' scale(1.6)';
      onda.style.left = cx + 'px'; onda.style.top = cy + 'px'; onda.classList.add('on');
      m.explotar(cx, cy, 260, 22);
      setTimeout(() => m.explotar(cx, cy, 140, 14), 120);
      m.lluvia(6);
      setTimeout(() => m.lluvia(3), 2500);
      setTimeout(() => m.lluvia(1), 6000);
      setTimeout(() => { card.classList.add('on'); pie.classList.add('on'); }, 420);
    }), 300);
    setTimeout(cerrar, 14000);
  }

  window.NovaFinde = { celebrar };
  // Para verla sin hacer un cierre real: abrir Salidas con ?finde=demo al final de la dirección.
  if (/[?&]finde=demo/.test(location.search)) addEventListener('load', () => setTimeout(celebrar, 600));
})();
