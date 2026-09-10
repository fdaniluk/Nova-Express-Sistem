/* Dashboard (rediseño 10/09/2026 — DASHBOARD-REDISENO.md).
   Los filtros de la cabecera (período, courier, tipo, comparación) mandan sobre TODO: una
   llamada a GET /api/dashboard/analitica trae todo y acá se pinta. Los gráficos son de
   Chart.js (vendorizado en js/vendor/chart.umd.js, sin CDN). */
(function () {
  const alertBox = document.getElementById('alert-box');
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ── Franja de salud ───────────────────────────────────────────────────────
  // Pide el semáforo del panel de salud y, si hay algo en rojo, lo muestra arriba del
  // Dashboard. Si está todo en verde NO aparece; un chequeo que no pudo correr también la
  // enciende; si la consulta falla (403, red) se queda callada y no rompe el Dashboard.
  (async function franjaSalud() {
    const el = $('franja-salud');
    if (!el) return;
    try {
      const r = await NovaAPI.salud.resumen();
      const rojos = r.rojos || [];
      const errores = r.errores || [];
      if (!rojos.length && !errores.length) return;
      const partes = [];
      if (rojos.length) partes.push(rojos.map((x) => `${x.titulo}${x.cantidad ? ` (${x.cantidad})` : ''}`).join(' · '));
      if (errores.length) partes.push(`${errores.length} chequeo(s) no pudieron correr: ${errores.map((x) => x.titulo).join(', ')}`);
      const total = rojos.length + errores.length;
      el.innerHTML = `<strong>${total} ${total === 1 ? 'cosa necesita' : 'cosas necesitan'} atencion.</strong> Ver el panel de salud →`
        + `<div class="franja-detalle">${partes.join(' · ')}</div>`;
      el.hidden = false;
    } catch (err) {
      console.warn('[dashboard] No se pudo leer el panel de salud:', err.message);
    }
  })();

  // ── Estado de los filtros ──────────────────────────────────────────────────
  const filtros = { periodo: '12m', desde: null, hasta: null, courier: '', tipo: '', comparar: 'previo' };
  const vista = { mes: 'kg', mix: 'venta', top: 'venta', topN: 10, pais: 'envios' };
  let datos = null;
  const charts = {};

  const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  const mesCorto = (ym) => { const [y, m] = String(ym).split('-'); return `${MESES[Number(m) - 1]} ${String(y).slice(2)}`; };
  const fmtN = (n, d = 0) => Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtUSD = (n) => 'USD ' + fmtN(n, 2);
  // Para los KPIs: 132,4k en vez de 132.412,50 (el detalle está en los gráficos y el Excel).
  const fmtCorto = (n) => {
    const v = Number(n || 0);
    if (Math.abs(v) >= 1000000) return (v / 1000000).toFixed(2).replace('.', ',') + 'M';
    if (Math.abs(v) >= 10000) return (v / 1000).toFixed(1).replace('.', ',') + 'k';
    return fmtN(v, Math.abs(v) < 100 ? 2 : 0);
  };
  const fmtDia = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };

  const COL = { p: '#2A3661', pl: '#dbe4ef', ups: '#b45309', dhl: '#c8102e', ok: '#15803d', amb: '#e8a317', grid: '#eef1f5', est: '#c7d2fe', real: '#4f46e5', muted: '#94a3b8' };
  if (window.Chart) {
    Chart.defaults.font.family = "'Segoe UI', system-ui, -apple-system, sans-serif";
    Chart.defaults.font.size = 11;
    Chart.defaults.color = '#64748b';
  }

  function chart(id, config) {
    const el = $(id);
    if (!el || !window.Chart) return;
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(el, config);
  }
  const legend = { position: 'top', align: 'end', labels: { boxWidth: 10 } };

  // ── Carga ──────────────────────────────────────────────────────────────────
  function query() {
    const q = new URLSearchParams();
    q.set('periodo', filtros.periodo);
    if (filtros.periodo === 'rango') { q.set('desde', filtros.desde); q.set('hasta', filtros.hasta); }
    if (filtros.courier) q.set('courier', filtros.courier);
    if (filtros.tipo) q.set('tipo', filtros.tipo);
    q.set('comparar', filtros.comparar);
    return q.toString();
  }

  async function cargar() {
    const hint = $('dash-hint');
    hint.textContent = 'Cargando…';
    try {
      datos = await NovaAPI.dashboard.analitica(query());
    } catch (err) {
      NovaUtils.showAlert(alertBox, 'No se pudo cargar el dashboard: ' + err.message, 'error');
      hint.textContent = 'Sin datos';
      return;
    }
    const p = datos.periodo, c = datos.comparacion;
    hint.textContent = `${fmtDia(p.desde)} → ${fmtDia(p.hasta)} · comparado con ${fmtDia(c.desde)} → ${fmtDia(c.hasta)} · NO VOLÓ excluidos`;
    $('dash-excel').href = NovaAPI.dashboard.analiticaExcelUrl(query());
    pintarKpis();
    pintarMes();
    pintarMix();
    pintarTop();
    pintarPaises();
    pintarReal();
    pintarMargen();
    pintarPlata();
    pintarRitmo();
  }

  // ── KPIs ───────────────────────────────────────────────────────────────────
  function deltaHtml(pct, texto) {
    if (pct == null) return '<span>sin datos para comparar</span>';
    const flecha = pct > 0 ? '▲' : pct < 0 ? '▼' : '=';
    return `${flecha} ${fmtN(Math.abs(pct), 1)}% <span>${texto}</span>`;
  }
  function pintarKpis() {
    const k = datos.kpis, v = datos.variaciones;
    const comp = datos.comparacion.modo === 'anio' ? 'vs. año pasado' : 'vs. anterior';
    const set = (key, valor, delta, clase, serie, color) => {
      const el = document.querySelector(`.dash-kpi[data-kpi="${key}"]`);
      if (!el) return;
      el.querySelector('.v').innerHTML = valor;
      const d = el.querySelector('.d');
      d.innerHTML = delta;
      d.className = 'd' + (clase ? ' ' + clase : '');
      const cv = el.querySelector('canvas.sp');
      if (cv && serie) {
        if (!cv.id) cv.id = `sp-${key}`;
        chart(cv.id, {
          type: 'line',
          data: { labels: serie.map((_, i) => i), datasets: [{ data: serie, borderColor: color, borderWidth: 1.5, pointRadius: 0, tension: 0.35, fill: { target: 'origin', above: color + '22' } }] },
          options: { responsive: false, animation: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false } } },
        });
      }
    };
    const s = datos.series;
    const signo = (x) => (x == null ? '' : x > 0 ? 'up' : x < 0 ? 'dn' : '');
    set('envios', fmtN(k.envios), deltaHtml(v.envios, comp), signo(v.envios), s.envios, COL.p);
    set('kg_fact', `${fmtN(k.kg_fact, 0)} <small>kg</small>`, deltaHtml(v.kg_fact, comp), signo(v.kg_fact), s.kg, COL.p);
    set('venta', `USD ${fmtCorto(k.venta)}`, deltaHtml(v.venta, comp), signo(v.venta), s.venta, COL.p);
    // La compra que sube más que la venta es mala noticia: se pinta al revés.
    const compraMal = v.compra != null && v.venta != null && v.compra > v.venta;
    set('compra', `USD ${fmtCorto(k.compra)}`, deltaHtml(v.compra, compraMal ? 'subió más que la venta' : comp), compraMal ? 'dn' : (v.compra != null && v.compra < 0 ? 'up' : ''), s.compra, COL.ups);
    const margen = k.margen_pct != null ? ` <small>· ${fmtN(k.margen_pct, 0)}%</small>` : '';
    set('profit', `USD ${fmtCorto(k.profit)}${margen}`, deltaHtml(v.profit, v.margen_pts != null ? `margen ${v.margen_pts > 0 ? '+' : ''}${fmtN(v.margen_pts, 1)} pts` : comp), signo(v.profit), s.profit, COL.ok);
    document.querySelector('.dash-kpi[data-kpi="profit"] .v').classList.toggle('neg', k.profit < 0);
    const sl = k.sin_liquidar;
    set('sin_liquidar', `${fmtN(sl.n)} <small>envíos</small>`, `USD ${fmtCorto(sl.usd)} <span>· ${sl.mas_30} con +30 días</span>`, sl.mas_30 ? 'dn' : '', null);
  }

  // ── Por mes ────────────────────────────────────────────────────────────────
  const METRICA = {
    kg: { serie: 'kg', ant: 'kg_ant', unidad: 'kg', sub: 'kg facturables' },
    envios: { serie: 'envios', ant: 'envios_ant', unidad: '', sub: 'cantidad de envíos' },
    venta: { serie: 'venta', ant: 'venta_ant', unidad: 'USD', sub: 'venta en USD' },
    profit: { serie: 'profit', ant: 'profit_ant', unidad: 'USD', sub: 'profit en USD' },
  };
  function pintarMes() {
    const m = METRICA[vista.mes];
    const s = datos.series;
    const compLabel = datos.comparacion.modo === 'anio' ? 'Mismo mes del año pasado' : 'Período anterior';
    $('dash-mes-sub').textContent = `${m.sub} · barra clara = ${compLabel.toLowerCase()}`;
    chart('c-mes', {
      type: 'bar',
      data: {
        labels: s.meses.map(mesCorto),
        datasets: [
          { label: compLabel, data: s.meses.map((_, i) => (s[m.ant][i] === undefined ? null : s[m.ant][i])), backgroundColor: COL.pl, borderRadius: 4 },
          { label: 'Este período', data: s[m.serie], backgroundColor: vista.mes === 'profit' ? COL.ok : COL.p, borderRadius: 4 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${m.unidad === 'USD' ? fmtUSD(c.raw) : fmtN(c.raw, m.unidad ? 1 : 0) + (m.unidad ? ' ' + m.unidad : '')}` } } },
        scales: { x: { grid: { display: false } }, y: { grid: { color: COL.grid }, ticks: { callback: (v) => (m.unidad === 'USD' ? fmtCorto(v) : fmtN(v) + (m.unidad ? ' ' + m.unidad : '')) } } },
      },
    });
  }

  // ── Mix de couriers ────────────────────────────────────────────────────────
  function pintarMix() {
    const s = datos.series, mx = datos.mix;
    const campo = vista.mix;
    $('dash-mix-sub').textContent = { venta: 'por venta', envios: 'por envíos', kg: 'por kg' }[campo];
    const tot = s.meses.map((_, i) => (mx.UPS[campo][i] || 0) + (mx.DHL[campo][i] || 0));
    const pct = (c) => s.meses.map((_, i) => (tot[i] ? Math.round(((mx[c][campo][i] || 0) / tot[i]) * 1000) / 10 : 0));
    chart('c-mix', {
      type: 'bar',
      data: { labels: s.meses.map(mesCorto), datasets: [
        { label: 'UPS', data: pct('UPS'), backgroundColor: COL.ups, borderRadius: 3, crudo: mx.UPS[campo] },
        { label: 'DHL', data: pct('DHL'), backgroundColor: COL.dhl, borderRadius: 3, crudo: mx.DHL[campo] },
      ] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.raw}% (${campo === 'venta' ? fmtUSD(c.dataset.crudo[c.dataIndex]) : fmtN(c.dataset.crudo[c.dataIndex], campo === 'kg' ? 1 : 0)})` } } },
        scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, max: 100, grid: { color: COL.grid }, ticks: { callback: (v) => v + '%' } } },
      },
    });
  }

  // ── Top clientes ───────────────────────────────────────────────────────────
  function pintarTop() {
    const campo = vista.top;
    const part = { kg_fact: 'part_kg_pct', venta: 'part_venta_pct', profit: 'part_profit_pct', envios: 'part_envios_pct' }[campo];
    const varKey = { kg_fact: 'var_kg', venta: 'var_venta', profit: 'var_profit', envios: 'var_envios' }[campo];
    const lista = [...datos.top_clientes].sort((a, b) => b[campo] - a[campo]);
    const n = vista.topN || lista.length;
    const visibles = lista.slice(0, n);
    const tbody = $('dash-top').querySelector('tbody');
    if (!lista.length) {
      tbody.innerHTML = '<tr class="vacio"><td colspan="9">No hay envíos en el período.</td></tr>';
      $('dash-top-pie').textContent = '';
      return;
    }
    const maxPart = Math.max(...visibles.map((c) => c[part] || 0), 1);
    tbody.innerHTML = visibles.map((c, i) => {
      const v = c[varKey];
      const varHtml = v == null ? '<span class="dash-hint">—</span>' : `<span class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${v > 0 ? '▲' : v < 0 ? '▼' : '='} ${fmtN(Math.abs(v), 0)}%</span>`;
      return `<tr>
        <td><span class="rank${i < 3 ? ' g' : ''}">${i + 1}</span></td>
        <td><a href="pages/clientes-perfil.html?id=${c.id}">${esc(c.nombre)}</a></td>
        <td class="n">${fmtN(c.envios)}</td>
        <td class="n">${fmtN(c.kg_fact, 0)}</td>
        <td class="n"><b>${fmtN(c.venta, 0)}</b></td>
        <td class="n ${c.profit < 0 ? 'neg' : 'pos'}">${fmtN(c.profit, 0)}</td>
        <td class="n">${c.margen_pct == null ? '—' : fmtN(c.margen_pct, 0) + '%'}</td>
        <td><div class="bar" title="${fmtN(c[part], 1)}% del total"><i style="width:${Math.round(((c[part] || 0) / maxPart) * 100)}%"></i></div></td>
        <td class="n">${varHtml}</td>
      </tr>`;
    }).join('');
    const sumaPart = visibles.reduce((s, c) => s + (c[part] || 0), 0);
    const nombreMetrica = { kg_fact: 'los kilos', venta: 'la venta', profit: 'el profit', envios: 'los envíos' }[campo];
    $('dash-top-pie').textContent = `Los ${visibles.length} primeros son el ${fmtN(Math.min(100, sumaPart), 0)}% de ${nombreMetrica} · ${datos.clientes_activos} clientes con envíos en el período`;
  }

  // ── Destinos ───────────────────────────────────────────────────────────────
  function pintarPaises() {
    const campo = vista.pais;
    $('dash-pais-sub').textContent = { envios: 'por envíos', kg: 'por kg', venta: 'por venta' }[campo];
    const lista = [...datos.paises].sort((a, b) => b[campo] - a[campo]);
    const top = lista.slice(0, 8);
    const resto = lista.slice(8);
    const labels = top.map((p) => p.pais);
    const valores = top.map((p) => p[campo]);
    if (resto.length) { labels.push(`Otros (${resto.length})`); valores.push(Math.round(resto.reduce((s, p) => s + (p[campo] || 0), 0) * 100) / 100); }
    const azules = ['#2A3661', '#3D4C85', '#5262A0', '#6B7AB5', '#8592C6', '#9FAAD5', '#B8C1E1', '#CDD3EA', '#DFE3F1'];
    chart('c-pais', {
      type: 'bar',
      data: { labels, datasets: [{ data: valores, backgroundColor: labels.map((_, i) => azules[Math.min(i, azules.length - 1)]), borderRadius: 4 }] },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => (campo === 'venta' ? fmtUSD(c.raw) : fmtN(c.raw, campo === 'kg' ? 1 : 0) + (campo === 'kg' ? ' kg' : ' envíos')) } } },
        scales: { x: { grid: { color: COL.grid }, ticks: { callback: (v) => (campo === 'venta' ? fmtCorto(v) : fmtN(v)) } }, y: { grid: { display: false } } },
      },
    });
  }

  // ── Estimado vs real ───────────────────────────────────────────────────────
  function pintarReal() {
    const r = datos.real;
    const vacio = $('dash-real-vacio'), grid = $('dash-real'), aviso = $('dash-real-aviso');
    if (!r.length) { vacio.classList.remove('hidden'); grid.classList.add('hidden'); aviso.classList.add('hidden'); return; }
    vacio.classList.add('hidden'); grid.classList.remove('hidden');
    const labels = r.map((x) => mesCorto(x.mes));
    const titulo = (t) => ({ display: true, text: t, align: 'start', color: COL.p, font: { weight: '700' } });
    chart('c-compra', {
      type: 'bar',
      data: { labels, datasets: [
        { label: 'Compra estimada', data: r.map((x) => x.compra_est), backgroundColor: COL.est, borderRadius: 4 },
        { label: 'Costo facturado', data: r.map((x) => x.compra_real), backgroundColor: COL.real, borderRadius: 4 },
      ] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend, title: titulo('Compra: estimada vs. facturada (USD)'), tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtUSD(c.raw)}` } } }, scales: { x: { grid: { display: false } }, y: { grid: { color: COL.grid }, ticks: { callback: fmtCorto } } } },
    });
    chart('c-profit', {
      type: 'line',
      data: { labels, datasets: [
        { label: 'Profit estimado', data: r.map((x) => x.profit_est), borderColor: COL.muted, borderDash: [5, 4], pointRadius: 3, tension: 0.3 },
        { label: 'Profit real', data: r.map((x) => x.profit_real), borderColor: COL.ok, backgroundColor: COL.ok + '22', fill: true, pointRadius: 3, tension: 0.3 },
      ] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend, title: titulo('Profit: estimado vs. real (USD)'), tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtUSD(c.raw)}` } } }, scales: { x: { grid: { display: false } }, y: { grid: { color: COL.grid }, ticks: { callback: fmtCorto } } } },
    });
    chart('c-peso', {
      type: 'bar',
      data: { labels, datasets: [
        { label: 'Kg facturables (nuestros)', data: r.map((x) => x.kg_fact), backgroundColor: COL.pl, borderRadius: 4 },
        { label: 'Peso facturado por el courier', data: r.map((x) => x.kg_real), backgroundColor: COL.p, borderRadius: 4 },
      ] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend, title: titulo('Kilos: nuestros vs. facturados'), tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtN(c.raw, 1)} kg` } } }, scales: { x: { grid: { display: false } }, y: { grid: { color: COL.grid } } } },
    });
    // Pies: cobertura del último mes, acumulados del período.
    const ultimo = r[r.length - 1];
    const sum = (k) => r.reduce((s, x) => s + (x[k] || 0), 0);
    const pctDif = (a, b) => (b ? Math.round(((a - b) / Math.abs(b)) * 1000) / 10 : null);
    const cobColor = ultimo.cobertura_pct >= 90 ? COL.ok : ultimo.cobertura_pct >= 60 ? COL.amb : '#dc2626';
    $('cob-compra').innerHTML = `<span>Cobertura de ${mesCorto(ultimo.mes)}</span><div class="bar"><i style="width:${ultimo.cobertura_pct}%;background:${cobColor}"></i></div><b>${fmtN(ultimo.cobertura_pct, 0)}% cruzado</b>`;
    const dp = pctDif(sum('profit_real'), sum('profit_est'));
    $('cob-profit').innerHTML = `<span>Profit real acumulado</span><b style="color:${sum('profit_real') >= 0 ? COL.ok : '#dc2626'}">USD ${fmtCorto(sum('profit_real'))}</b><span>vs. estimado USD ${fmtCorto(sum('profit_est'))}${dp == null ? '' : ` (${dp > 0 ? '+' : ''}${fmtN(dp, 1)}%)`}</span>`;
    const dk = pctDif(sum('kg_real'), sum('kg_fact'));
    $('cob-peso').innerHTML = `<span>Kg facturados por el courier</span><b>${fmtN(sum('kg_real'), 0)}</b><span>vs. ${fmtN(sum('kg_fact'), 0)} nuestros${dk == null ? '' : ` (${dk > 0 ? '+' : ''}${fmtN(dk, 1)}%)`}</span>`;
    // Aviso: meses parciales (menos del 90 % de las guías con factura).
    const parciales = r.filter((x) => x.cobertura_pct < 90);
    if (parciales.length) {
      aviso.textContent = parciales.map((x) => `${mesCorto(x.mes)} tiene ${fmtN(100 - x.cobertura_pct, 0)}% de las guías sin factura cruzada`).join(' · ') + ': sus números reales son parciales.';
      aviso.classList.remove('hidden');
    } else aviso.classList.add('hidden');
  }

  // ── Margen por mes ─────────────────────────────────────────────────────────
  function pintarMargen() {
    const m = datos.margen;
    const obj = m.objetivo_pct;
    $('dash-margen-obj').textContent = obj ? `objetivo ${fmtN(obj, 0)}% (Configuración)` : 'sin objetivo cargado (se pone en Configuración)';
    const datasets = [{ label: 'Margen %', data: m.meses.map((x) => x.pct), borderColor: COL.p, pointRadius: 3, tension: 0.3, spanGaps: true }];
    if (obj) datasets.push({ label: `Objetivo ${fmtN(obj, 0)}%`, data: m.meses.map(() => obj), borderColor: COL.amb, borderDash: [4, 4], pointRadius: 0 });
    const vals = m.meses.map((x) => x.pct).filter((x) => x != null).concat(obj ? [obj] : []);
    const min = vals.length ? Math.max(0, Math.floor(Math.min(...vals) / 10) * 10 - 10) : 0;
    const max = vals.length ? Math.ceil(Math.max(...vals) / 10) * 10 + 10 : 100;
    chart('c-margen', {
      type: 'line',
      data: { labels: m.meses.map((x) => mesCorto(x.mes)), datasets },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.raw == null ? '—' : fmtN(c.raw, 1) + '%'}` } } }, scales: { x: { grid: { display: false } }, y: { min, max, grid: { color: COL.grid }, ticks: { callback: (v) => v + '%' } } } },
    });
  }

  // ── Plata en la calle ──────────────────────────────────────────────────────
  function pintarPlata() {
    const p = datos.plata;
    const fila = (txt, n, usd, href, mal) => `<tr><td><a href="${href}">${txt}</a></td><td class="n"><b>${fmtN(n)}</b></td><td class="n${mal && usd > 0 ? ' neg' : ''}">USD ${fmtCorto(usd)}</td></tr>`;
    $('dash-plata').querySelector('tbody').innerHTML =
      fila('Envíos sin liquidar', p.sin_liquidar.n, p.sin_liquidar.usd, 'pages/liquidaciones.html', false)
      + fila('Guías con desvío sin revisar', p.desvios_sin_revisar.n, p.desvios_sin_revisar.usd, 'pages/facturas.html', true)
      + fila('En disputa con UPS', p.disputa.n, p.disputa.usd, 'pages/facturas.html', true)
      + fila('Guías UPS sin factura (+45 días)', p.sin_factura.n, p.sin_factura.usd, 'pages/facturas.html', false);
  }

  // ── Ritmo ──────────────────────────────────────────────────────────────────
  function pintarRitmo() {
    const r = datos.ritmo;
    // "antes" solo si el período de comparación tuvo envíos; si no, no hay con qué comparar.
    const a = datos.kpis_ant && datos.kpis_ant.envios > 0 ? (r.ant || {}) : {};
    const fila = (txt, v, va, fmt) => `<tr><td>${txt}</td><td class="n"><b>${v == null ? '—' : fmt(v)}</b></td><td class="n ant">${va == null ? '' : 'antes ' + fmt(va)}</td></tr>`;
    $('dash-ritmo').querySelector('tbody').innerHTML =
      fila('Envíos por semana', r.envios_semana, a.envios_semana, (v) => fmtN(v, 1))
      + fila('Kg por envío', r.kg_envio, a.kg_envio, (v) => fmtN(v, 1))
      + fila('Venta por envío', r.venta_envio, a.venta_envio, (v) => 'USD ' + fmtN(v, 0))
      + fila('Días carga → liquidación', r.dias_liquidacion, a.dias_liquidacion, (v) => fmtN(v, 0))
      + fila('Clientes nuevos', r.clientes_nuevos, a.clientes_nuevos, (v) => fmtN(v, 0));
  }

  // ── Filtros y selectores ───────────────────────────────────────────────────
  function activar(sel, btn) {
    document.querySelectorAll(sel).forEach((b) => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
  }
  function bind() {
    document.querySelectorAll('.dash-per').forEach((b) => b.addEventListener('click', () => {
      filtros.periodo = b.dataset.periodo; activar('.dash-per', b); cargar();
    }));
    $('dash-rango-ok').addEventListener('click', () => {
      const d = $('dash-desde').value, h = $('dash-hasta').value;
      if (!d || !h) { NovaUtils.showAlert(alertBox, 'Elegí el mes desde y el mes hasta', 'error'); return; }
      if (d > h) { NovaUtils.showAlert(alertBox, 'El mes "desde" tiene que ser anterior al "hasta"', 'error'); return; }
      const [y, m] = h.split('-').map(Number);
      const ultimo = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      filtros.periodo = 'rango'; filtros.desde = `${d}-01`; filtros.hasta = ultimo;
      activar('.dash-per', null); cargar();
    });
    document.querySelectorAll('.dash-courier').forEach((b) => b.addEventListener('click', () => { filtros.courier = b.dataset.courier; activar('.dash-courier', b); cargar(); }));
    document.querySelectorAll('.dash-tipo').forEach((b) => b.addEventListener('click', () => { filtros.tipo = b.dataset.tipo; activar('.dash-tipo', b); cargar(); }));
    $('dash-comparar').addEventListener('change', (e) => { filtros.comparar = e.target.value; cargar(); });
    // Selectores de cada tarjeta: solo repintan (los datos ya están).
    const seg = (id, key, fn) => {
      const cont = $(id);
      if (!cont) return;
      cont.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-m]');
        if (!b) return;
        cont.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        vista[key] = b.dataset.m;
        if (datos) fn();
      });
    };
    seg('seg-mes', 'mes', pintarMes);
    seg('seg-mix', 'mix', pintarMix);
    seg('seg-top', 'top', pintarTop);
    seg('seg-pais', 'pais', pintarPaises);
    $('dash-top-n').addEventListener('change', (e) => { vista.topN = Number(e.target.value); if (datos) pintarTop(); });
  }

  bind();
  cargar();
}());
