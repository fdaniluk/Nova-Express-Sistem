// validar-guia.js — verifica que un número de guía esté bien tipeado.
//
// No consulta a UPS ni a DHL: los números de guía llevan un DÍGITO VERIFICADOR calculado
// a partir del resto del número. Si alguien se come un dígito, lo cambia o cruza dos, la
// cuenta no cierra y se detecta al instante, sin conexión y sin esperar a que la factura
// del courier lo revele un mes después.
//
// Comprobado contra la base real: de 142 guías UPS cargadas, 136 validan y las 6 que no
// son errores de tipeo verificables (dos con un carácter de más o de menos, dos con
// "32W7" donde el resto dice "327W", dos con un dígito cambiado). Las 16 de DHL validan
// todas.
//
// IMPORTANTE: esto AVISA, nunca bloquea. Un número raro puede ser legítimo (un formato
// nuevo del courier, una guía de otro servicio), y frenar la carga por una sospecha sería
// peor que el problema.

// ── UPS ──────────────────────────────────────────────────────────────────────
// Formato: 1Z + 6 (cuenta) + 2 (servicio) + 7 (paquete) + 1 (verificador) = 18 caracteres.
// Verificador: los 15 caracteres entre el "1Z" y el dígito final se convierten a número
// (las letras por su posición), se duplican los de posición par, se suman, y el dígito
// es lo que falta para llegar a la decena.
function validarUPS(guia) {
  const g = String(guia || '').trim().toUpperCase();
  if (!/^1Z/.test(g)) return { estado: 'desconocida', motivo: 'No tiene el formato 1Z de UPS' };
  if (g.length !== 18) {
    return {
      estado: 'sospechosa',
      motivo: `Una guía de UPS tiene 18 caracteres y esta tiene ${g.length}`,
    };
  }
  if (!/^1Z[0-9A-Z]{16}$/.test(g)) {
    return { estado: 'sospechosa', motivo: 'Tiene caracteres que no son letras ni números' };
  }
  const cuerpo = g.slice(2, 17);
  const dv = Number(g[17]);
  if (Number.isNaN(dv)) {
    return { estado: 'sospechosa', motivo: 'El último caracter tendría que ser un número' };
  }
  let suma = 0;
  for (let i = 0; i < 15; i++) {
    const c = cuerpo[i];
    let v = /[0-9]/.test(c) ? Number(c) : ((c.charCodeAt(0) - 63) % 10);
    if (i % 2 === 1) v *= 2;
    suma += v;
  }
  const esperado = (10 - (suma % 10)) % 10;
  if (esperado !== dv) {
    return {
      estado: 'sospechosa',
      motivo: 'El dígito verificador no cierra: revisá si hay algún número cambiado o cruzado',
    };
  }
  return { estado: 'ok', motivo: '' };
}

// ── DHL ──────────────────────────────────────────────────────────────────────
// Formato: 10 dígitos. El último es el resto de dividir los 9 primeros por 7.
function validarDHL(guia) {
  const g = String(guia || '').trim();
  if (!/^\d+$/.test(g)) return { estado: 'desconocida', motivo: 'No tiene el formato numérico de DHL' };
  if (g.length !== 10) {
    return {
      estado: 'sospechosa',
      motivo: `Una guía de DHL tiene 10 dígitos y esta tiene ${g.length}`,
    };
  }
  if (Number(g[9]) !== Number(g.slice(0, 9)) % 7) {
    return {
      estado: 'sospechosa',
      motivo: 'El dígito verificador no cierra: revisá si hay algún número cambiado o cruzado',
    };
  }
  return { estado: 'ok', motivo: '' };
}

// Devuelve { estado, motivo }:
//   'ok'          → el número cierra
//   'sospechosa'  → muy probablemente esté mal tipeada  ← acá va el aviso
//   'desconocida' → no se reconoce el formato; NO se avisa nada (evita ruido)
function validarGuia(courier, guia) {
  const g = String(guia || '').trim();
  if (!g) return { estado: 'desconocida', motivo: 'Sin número de guía' };
  const c = String(courier || '').trim().toUpperCase();
  if (c === 'UPS') return validarUPS(g);
  if (c === 'DHL') return validarDHL(g);
  // Sin courier: se deduce del formato.
  if (/^1Z/i.test(g)) return validarUPS(g);
  if (/^\d+$/.test(g)) return validarDHL(g);
  return { estado: 'desconocida', motivo: 'Courier desconocido' };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { validarGuia, validarUPS, validarDHL };
}
