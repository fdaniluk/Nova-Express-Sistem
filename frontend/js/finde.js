/* "Despegó la semana" — festejo al bajar el cierre de LA SEMANA desde Salidas.
   Pedido de Felipe (22/09/2026): que conviva con la pantalla (las salidas siguen atrás,
   con un velo), que sea lindo y con la marca. Sin librerías.
   Secuencia (≈ 15 s, se cierra con clic, Esc o sola):
     1. Velo azul hielo sobre la pantalla.
     2. Un avión de papel en colores Nova cruza de abajo-izquierda a arriba-derecha dejando
        una estela punteada y soltando confeti (azul, naranja, hielo, gris globo, blanco).
     3. Sube una tarjeta tipo "boarding pass": talón azul con el anillo del logo, número de
        envíos de la semana, rango de fechas, quién cerró, y una frase al azar.
        Si hay fotos en /assets/finde, una queda pegada con cinta, como polaroid.
     4. Dos ráfagas de confeti desde los costados cuando aparece la tarjeta.
   NovaFinde.celebrar({ filas, quien }).  Demo: Salidas con ?finde=demo. */
(function () {
  const AZUL = '#2A3661', NARANJA = '#EA6749', HIELO = '#EAF1F8', GRIS = '#BFC1C4';
  const PALETA = [AZUL, NARANJA, HIELO, GRIS, '#ffffff', '#3D4C85', '#F5A08A'];
  const FRASES = [
    'Otra semana en el aire. A descansar.',
    'Todo lo que tenía que salir, salió.',
    'Cerró la semana. El lunes seguimos volando.',
    'Envíos entregados, semana cumplida.',
    'Lo que se despachó esta semana ya está cruzando el mundo.',
    'Buen finde. Se lo ganaron.',
    'Semana cerrada, planilla guardada, a casa.',
  ];
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const pick = (a) => a[Math.floor(Math.random() * a.length)];

  const CSS = `
  .fd-velo{position:fixed;inset:0;z-index:99990;background:rgba(234,241,248,.62);backdrop-filter:blur(2.5px);-webkit-backdrop-filter:blur(2.5px);opacity:0;transition:opacity .5s ease;cursor:pointer}
  .fd-velo.on{opacity:1}
  .fd-canvas{position:fixed;inset:0;z-index:99991;pointer-events:none}
  .fd-avion{position:fixed;z-index:99992;width:96px;height:96px;left:0;top:0;pointer-events:none;filter:drop-shadow(0 10px 14px rgba(42,54,97,.28));will-change:transform}
  .fd-pass{position:fixed;z-index:99993;left:50%;bottom:6vh;transform:translate(-50%,120%);width:min(760px,92vw);display:flex;background:#fff;border-radius:18px;box-shadow:0 24px 70px rgba(42,54,97,.28),0 2px 6px rgba(42,54,97,.12);font-family:'Segoe UI',system-ui,-apple-system,sans-serif;color:#1F2937;transition:transform .7s cubic-bezier(.2,1.25,.35,1);cursor:pointer;overflow:visible}
  .fd-pass.on{transform:translate(-50%,0)}
  .fd-pass.off{transform:translate(-50%,130%);transition:transform .45s ease-in}
  .fd-talon{flex:0 0 118px;background:${AZUL};border-radius:18px 0 0 18px;position:relative;display:flex;flex-direction:column;align-items:center;justify-content:space-between;padding:22px 0 18px;color:#fff}
  .fd-talon::after{content:'';position:absolute;right:-1px;top:0;bottom:0;width:0;border-right:2px dashed rgba(255,255,255,.55)}
  .fd-talon .fd-muesca{position:absolute;right:-13px;width:26px;height:26px;border-radius:50%;background:${HIELO}}
  .fd-talon .fd-muesca.a{top:-13px}.fd-talon .fd-muesca.b{bottom:-13px}
  .fd-vert{writing-mode:vertical-rl;transform:rotate(180deg);font-size:11px;letter-spacing:.32em;font-weight:700;opacity:.9}
  .fd-cuerpo{flex:1;padding:26px 30px 24px 30px;position:relative}
  .fd-sup{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
  .fd-eyebrow{font-size:11px;letter-spacing:.22em;font-weight:700;color:${NARANJA};text-transform:uppercase}
  .fd-semana{font-size:15px;color:#64748b;margin-top:3px}
  .fd-num{display:flex;align-items:baseline;gap:10px;margin:14px 0 4px}
  .fd-num b{font-size:64px;line-height:1;font-weight:800;color:${AZUL};letter-spacing:-2px;font-variant-numeric:tabular-nums}
  .fd-num span{font-size:18px;font-weight:600;color:${AZUL}}
  .fd-frase{font-size:18px;font-weight:500;color:#1F2937;margin:10px 0 0;line-height:1.35;max-width:430px}
  .fd-inf{display:flex;justify-content:space-between;align-items:center;margin-top:22px;padding-top:14px;border-top:1px solid #e5e9f0;font-size:12.5px;color:#64748b}
  .fd-inf b{color:${AZUL};font-weight:700}
  .fd-barcode{display:flex;gap:2px;height:22px;align-items:flex-end}
  .fd-barcode i{display:block;background:${AZUL};width:2px;opacity:.85}
  .fd-foto{position:absolute;right:-26px;top:-78px;width:190px;padding:8px 8px 26px;background:#fff;box-shadow:0 14px 34px rgba(42,54,97,.3);transform:rotate(5deg) scale(.6);opacity:0;transition:transform .7s cubic-bezier(.2,1.3,.4,1) .35s,opacity .4s ease .35s}
  .fd-pass.on .fd-foto{transform:rotate(5deg) scale(1);opacity:1}
  .fd-foto img{display:block;width:100%;height:150px;object-fit:cover;background:${HIELO}}
  .fd-foto::before{content:'';position:absolute;left:50%;top:-12px;width:84px;height:24px;margin-left:-42px;background:rgba(234,103,73,.55);transform:rotate(-3deg);border-radius:2px}
  .fd-cerrar{position:fixed;z-index:99994;right:22px;top:18px;width:38px;height:38px;border-radius:50%;border:0;background:#fff;color:${AZUL};font-size:20px;line-height:38px;text-align:center;cursor:pointer;box-shadow:0 4px 14px rgba(42,54,97,.25);opacity:0;transition:opacity .4s}
  .fd-cerrar.on{opacity:1}
  @media (max-width:640px){.fd-talon{display:none}.fd-cuerpo{padding:22px 20px}.fd-num b{font-size:52px}.fd-foto{position:static;transform:none!important;width:100%;margin:12px 0 0;padding-bottom:8px}.fd-foto::before{display:none}}
  `;
  function css() {
    if (document.getElementById('fd-css')) return;
    const s = document.createElement('style'); s.id = 'fd-css'; s.textContent = CSS; document.head.appendChild(s);
  }

  // Avión de papel en colores Nova (cuerpo blanco, ala naranja, contorno azul).
  const AVION = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <path d="M6 52 L92 18 L60 88 L48 60 Z" fill="#ffffff" stroke="${AZUL}" stroke-width="3.5" stroke-linejoin="round"/>
    <path d="M6 52 L48 60 L92 18 Z" fill="${NARANJA}" stroke="${AZUL}" stroke-width="3.5" stroke-linejoin="round"/>
    <path d="M48 60 L60 88 L56 66 Z" fill="${HIELO}" stroke="${AZUL}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M48 60 L92 18" stroke="${AZUL}" stroke-width="3" stroke-linecap="round"/></svg>`;
  // Anillo partido del logo (naranja arriba, azul claro abajo) para el talón.
  const ANILLO = `<svg viewBox="0 0 64 64" width="50" height="50" xmlns="http://www.w3.org/2000/svg">
    <path d="M9 30 A23 23 0 0 1 55 30" fill="none" stroke="${NARANJA}" stroke-width="8" stroke-linecap="round"/>
    <path d="M55 38 A23 23 0 0 1 9 38" fill="none" stroke="${HIELO}" stroke-width="8" stroke-linecap="round"/>
    <circle cx="32" cy="34" r="8" fill="${GRIS}"/></svg>`;

  function semanaTexto(d) {
    const dow = (d.getDay() + 6) % 7; // lunes = 0
    const lun = new Date(d); lun.setDate(d.getDate() - dow);
    const vie = new Date(lun); vie.setDate(lun.getDate() + 4);
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dia = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - dia);
    const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    const iso = Math.ceil(((t - y0) / 864e5 + 1) / 7);
    const m = lun.getMonth() === vie.getMonth()
      ? `${lun.getDate()} al ${vie.getDate()} de ${MESES[vie.getMonth()]}`
      : `${lun.getDate()} de ${MESES[lun.getMonth()]} al ${vie.getDate()} de ${MESES[vie.getMonth()]}`;
    return { iso, rango: m };
  }

  // ── Canvas: estela del avión + confeti con gravedad ───────────────────────────
  function motor(canvas) {
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => { canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    resize(); addEventListener('resize', resize);
    const piezas = [], estela = [];
    let raf, vivo = true;
    const pieza = (x, y, vx, vy) => ({
      x, y, vx, vy, w: 5 + Math.random() * 7, h: 7 + Math.random() * 9, color: pick(PALETA),
      rot: Math.random() * Math.PI * 2, vr: (Math.random() - .5) * .3, fase: Math.random() * Math.PI * 2,
      tipo: Math.random() < .15 ? 'anillo' : 'papel', vida: 1,
    });
    const rafaga = (x, y, n, ang, apertura, fuerza) => {
      for (let i = 0; i < n; i++) {
        const a = ang + (Math.random() - .5) * apertura, f = fuerza * (.5 + Math.random());
        piezas.push(pieza(x, y, Math.cos(a) * f, Math.sin(a) * f));
      }
    };
    const paso = () => {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      // estela punteada del avión
      ctx.save(); ctx.strokeStyle = AZUL; ctx.lineWidth = 2.5; ctx.setLineDash([2, 9]); ctx.lineCap = 'round';
      for (let i = 1; i < estela.length; i++) {
        const a = estela[i - 1], b = estela[i]; ctx.globalAlpha = Math.max(0, b.vida) * .8;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); b.vida -= .006;
      }
      ctx.restore();
      while (estela.length && estela[0].vida <= 0) estela.shift();
      for (let i = piezas.length - 1; i >= 0; i--) {
        const p = piezas[i];
        p.fase += .08; p.vx *= .985; p.vy = p.vy * .985 + .22; p.x += p.vx + Math.sin(p.fase) * .6; p.y += p.vy; p.rot += p.vr;
        if (p.y > innerHeight + 40) { piezas.splice(i, 1); continue; }
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.globalAlpha = .95;
        const sx = Math.cos(p.fase * 1.7); // "giro" 3D
        if (p.tipo === 'anillo') { ctx.strokeStyle = p.color; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.ellipse(0, 0, p.w * .8, p.w * .8 * Math.abs(sx) + .5, 0, 0, Math.PI * 2); ctx.stroke(); }
        else { ctx.fillStyle = p.color; ctx.fillRect(-p.w / 2 * sx, -p.h / 2, p.w * sx, p.h); }
        ctx.restore();
      }
      if (vivo || piezas.length || estela.length) raf = requestAnimationFrame(paso);
    };
    raf = requestAnimationFrame(paso);
    return {
      rafaga, estela: (x, y) => estela.push({ x, y, vida: 1 }),
      gota: (x, y) => piezas.push(pieza(x, y, (Math.random() - .5) * 2, 1 + Math.random() * 2)),
      parar: () => { vivo = false; }, destruir: () => { vivo = false; cancelAnimationFrame(raf); removeEventListener('resize', resize); },
    };
  }

  // Vuelo del avión por una curva de Bézier, soltando estela y confeti.
  function volar(el, m, dur, alTerminar) {
    const W = innerWidth, H = innerHeight;
    const P0 = { x: -120, y: H * .78 }, P1 = { x: W * .25, y: H * .95 }, P2 = { x: W * .55, y: H * .05 }, P3 = { x: W + 140, y: H * .12 };
    const B = (t, a, b, c, d) => (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d;
    const t0 = performance.now(); let ultimo = 0;
    const ease = (t) => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const paso = (now) => {
      const t = ease(Math.min(1, (now - t0) / dur));
      const x = B(t, P0.x, P1.x, P2.x, P3.x), y = B(t, P0.y, P1.y, P2.y, P3.y);
      const x2 = B(Math.min(1, t + .01), P0.x, P1.x, P2.x, P3.x), y2 = B(Math.min(1, t + .01), P0.y, P1.y, P2.y, P3.y);
      const ang = Math.atan2(y2 - y, x2 - x);
      el.style.transform = `translate(${x - 48}px,${y - 48}px) rotate(${ang + 0.35}rad)`;
      if (now - ultimo > 28) { m.estela(x - Math.cos(ang) * 40, y - Math.sin(ang) * 40); ultimo = now; }
      if (t > .2 && t < .9 && Math.random() < .75) m.gota(x - Math.cos(ang) * 30, y - Math.sin(ang) * 30 + 10);
      if (t < 1) requestAnimationFrame(paso); else { el.remove(); alTerminar && alTerminar(); }
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
  const barcode = () => Array.from({ length: 34 }, () => `<i style="height:${8 + Math.random() * 14}px;width:${Math.random() < .3 ? 3 : 2}px"></i>`).join('');

  async function celebrar({ filas = 0, quien = '' } = {}) {
    css();
    const foto = await fotoAlAzar();
    const ahora = new Date();
    const { iso, rango } = semanaTexto(ahora);
    const hora = `${String(ahora.getHours()).padStart(2, '0')}:${String(ahora.getMinutes()).padStart(2, '0')}`;

    const velo = document.createElement('div'); velo.className = 'fd-velo';
    const cv = document.createElement('canvas'); cv.className = 'fd-canvas';
    const avion = document.createElement('div'); avion.className = 'fd-avion'; avion.innerHTML = AVION;
    const btn = document.createElement('button'); btn.className = 'fd-cerrar'; btn.type = 'button'; btn.textContent = '×'; btn.title = 'Cerrar';
    const pass = document.createElement('div'); pass.className = 'fd-pass';
    pass.innerHTML = `
      <div class="fd-talon"><span class="fd-muesca a"></span><span class="fd-muesca b"></span>
        ${ANILLO}<div class="fd-vert">CIERRE DE SEMANA</div><div style="font-size:11px;opacity:.75">SEM ${String(iso).padStart(2, '0')}</div></div>
      <div class="fd-cuerpo">
        <div class="fd-sup"><div><div class="fd-eyebrow">Despegó la semana</div><div class="fd-semana">${rango}</div></div></div>
        <div class="fd-num"><b>${filas}</b><span>envío${filas === 1 ? '' : 's'} salieron esta semana</span></div>
        <p class="fd-frase">${pick(FRASES)}</p>
        <div class="fd-inf"><div>${quien ? `Cierre hecho por <b>${quien}</b> · ` : ''}${hora} hs</div><div class="fd-barcode">${barcode()}</div></div>
        ${foto ? `<div class="fd-foto"><img src="${foto}" alt=""></div>` : ''}
      </div>`;
    document.body.append(velo, cv, avion, pass, btn);
    const m = motor(cv);
    requestAnimationFrame(() => velo.classList.add('on'));

    let cerrado = false;
    const cerrar = () => {
      if (cerrado) return; cerrado = true;
      pass.classList.remove('on'); pass.classList.add('off'); velo.classList.remove('on'); btn.classList.remove('on'); m.parar();
      removeEventListener('keydown', onKey);
      setTimeout(() => { m.destruir(); [velo, cv, avion, pass, btn].forEach((e) => e.remove()); }, 700);
    };
    const onKey = (e) => { if (e.key === 'Escape') cerrar(); };
    addEventListener('keydown', onKey);
    velo.addEventListener('click', cerrar); pass.addEventListener('click', cerrar); btn.addEventListener('click', cerrar);

    setTimeout(() => volar(avion, m, 2100, () => {
      pass.classList.add('on'); btn.classList.add('on');
      setTimeout(() => {
        m.rafaga(0, innerHeight * .75, 90, -Math.PI / 3.2, .9, 16);
        m.rafaga(innerWidth, innerHeight * .75, 90, -Math.PI + Math.PI / 3.2, .9, 16);
      }, 250);
      setTimeout(() => m.rafaga(innerWidth / 2, innerHeight * .2, 60, Math.PI / 2, Math.PI, 5), 900);
    }), 350);
    setTimeout(cerrar, 16000);
  }

  window.NovaFinde = { celebrar };
  // Para verla sin hacer un cierre real: abrir Salidas con ?finde=demo al final de la dirección.
  if (/[?&]finde=demo/.test(location.search)) addEventListener('load', () => setTimeout(() => celebrar({ filas: 57, quien: 'Leandro' }), 600));
})();
