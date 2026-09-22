# -*- coding: utf-8 -*-
"""Exporta el historial de cuenta corriente del GECOM a CSV para importarlo en el sistema.

Uso:  python gecom_exportar.py <carpeta_nova2026> [<carpeta_nova2025> ...] [--out carpeta_salida]

Lee ac1hMMYY.fac (cabeceras) + ac1dMMYY.fac (detalles) de cada carpeta y escribe en --out:
  comprobantes.csv   FA / NC / ND / RC / AC (una fila por comprobante, con TC e importes)
  imputaciones.csv   recibo -> comprobante que cancela (TIPOREG 006)
  valores.csv        medios de pago del recibo (TIPOREG 008)
  compensa.csv       cruces NC <-> FA (compensa.fac)
  cuenta.csv         pendientes según cuenta.fac (para verificar saldos después de importar)

Cómo están guardados los archivos (descifrado 21-22/09/2026):
  · ac1h: registros de 255 bytes precedidos por '@' + byte de estado. NO tienen paso fijo
    (hay páginas con relleno): se ubican por regex sobre la clave en texto
    sucursal(2) punto(5) tipo(2) subtipo(2) letra(1) numero(8) subnro(4) clipro(1) agenda(8) dia(2) primero(8).
  · ac1d: registros de 89 bytes + CRLF, paso fijo 91. UNICO = PRIMERO de la cabecera (agrupa
    los renglones de un comprobante); SIGUIENTE es solo el número de renglón.
  · TIPOREGISTRO de la cabecera: 2 = venta (FA/NC/ND), 4 = cobranza (RC), 0 = comprobante
    de arrastre (abierto de años anteriores, solo cabecera, aparece en el archivo de diciembre).
  · TIPOCPTE: 02 FA · 03 ND · 04 NC · 05 RC · 64 AC (a cuenta). Otros se exportan crudos.
    OJO: el 03 es NOTA DE DÉBITO y el 04 NOTA DE CRÉDITO (al revés de lo anotado el 21/09):
    los recibos imputan a 03 (RC 101128 → 03 #7 y #8) y compensa.fac cruza FA ↔ 04 (57 veces).
    En cuenta.fac el byte de estado 0x9d = débito (02, 03) y 0x60 = crédito (04, 05, 19).
  · CLIPRO '0' = cliente. '1' = proveedor (compras): se ignoran.
"""
import sys, os, re, glob, csv, struct
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault('GECOM_DIR', '')
import gecom_lector as g

TIPOS = {'02': 'FA', '03': 'ND', '04': 'NC', '05': 'RC', '64': 'AC'}
FORMAPAGO = {1: 'efectivo', 2: 'cheque', 3: 'cheque', 4: 'tarjeta', 5: 'otro', 6: 'transferencia', 7: 'otro'}
PAT_H = re.compile(rb'@(.)(\d{11}[A-Z ]\d{13}\d{18})', re.S)


def fecha(v):
    v = int(v or 0)
    return '%04d-%02d-%02d' % (v // 10000, (v // 100) % 100, v % 100) if v > 19000000 else ''


def leer_carpeta(d, T, out):
    H = T['AC1H####']; Dd = T['AC1D####']
    for hf in sorted(glob.glob(os.path.join(d, 'ac1h*.fac'))):
        mm = os.path.basename(hf)[4:8]          # MMYY
        anio = 2000 + int(mm[2:]); mes = int(mm[:2])
        df = os.path.join(d, 'ac1d' + mm + '.fac')
        det = defaultdict(list)
        if os.path.exists(df):
            bd = open(df, 'rb').read()
            for k in range(1, len(bd) // 91):
                r = bd[k * 91:k * 91 + 89]
                f = Dd.get('%03d' % r[0])
                if f:
                    dd = g.decode(f, r); det[dd['UNICO']].append(dd)
        bh = open(hf, 'rb').read()
        for m in PAT_H.finditer(bh):
            raw = bh[m.start(2):m.start(2) + 255]
            r = g.decode(H['000'], raw)
            if r['CLIPRO'] != '0':
                continue
            treg = r['TIPOREGISTRO']
            base = dict(
                archivo=os.path.basename(hf), punto=r['CODIGOPT'], tipo_cod=r['TIPOCPTE'],
                tipo=TIPOS.get(r['TIPOCPTE'], r['TIPOCPTE']), letra=r['LETRA'].strip(),
                numero=r['NUMERO'], agenda=r['CODIGOAGENDA'], anulado=r['ANULADO'],
                tiporeg=treg, fecha='%04d-%02d-%02d' % (anio, mes, max(1, int(r['DIA'] or 1))),
                cae=r['CAICAE'] or '', primero=int(r['PRIMERO'] or 0),
            )
            key = (base['punto'], base['tipo_cod'], base['letra'], base['numero'], base['agenda'])
            if treg == 2:
                v = g.decode(H['002'], raw)
                base.update(importe=v['IMPORTETOTAL'], tc=v['COTIZACION'], importe_divisa=v['IMPDIVISA'],
                            divisa=v['DIVISA'], vencimiento=fecha(v['FECHAVTO']), moneda_cc=v['CTACTEMONEDA'])
                out['comprobantes'][key] = base
            elif treg == 4:
                v = g.decode(H['004'], raw)
                base.update(importe=v['VALORES'], fecha_recepcion=fecha(v['FECHARECEPCION']), cobrador=v['COBRADOR'],
                            leyenda=v['LEYENDA'].strip())
                if base['fecha_recepcion']: base['fecha'] = base['fecha_recepcion']
                out['comprobantes'][key] = base
                for dd in det.get(base['primero'], []):
                    if dd['TIPOREG'] == 6:
                        out['imputaciones'].append(dict(
                            rc_punto=base['punto'], rc_numero=base['numero'], rc_agenda=base['agenda'],
                            punto='%05d' % int(dd['PUNTO'] or 0), tipo_cod='%02d' % dd['TIPOCPTE'],
                            tipo=TIPOS.get('%02d' % dd['TIPOCPTE'], '%02d' % dd['TIPOCPTE']),
                            letra=dd['ABC'].strip(), numero='%08d' % dd['NROCPTE'],
                            importe=dd['IMPORTEPAGO'], a_cuenta=dd['IMPORTEACUENTA'], moneda_pago=dd['MONEDAPAGO'],
                            fecha_cpte=fecha(dd['FECHACPTE'])))
                    elif dd['TIPOREG'] == 8:
                        out['valores'].append(dict(
                            rc_punto=base['punto'], rc_numero=base['numero'], rc_agenda=base['agenda'],
                            forma_cod=dd['FORMAPAGO'], medio=FORMAPAGO.get(dd['FORMAPAGO'], 'otro'),
                            importe=dd['IMPORTE'], banco=dd['NOMBANCO'].strip(), cheque_nro=dd['CHNUMERO'] or '',
                            vto=fecha(dd['FECHAVTO']), cuit_emisor=dd['CUITEMISOR'] or '', propio_terceros=dd['PROPIO3ROS'].strip()))
            elif treg == 0:
                # Arrastre: solo cabecera; importe y fechas salen de cuenta.fac al importar.
                base.update(importe=None, tc=None, vencimiento='')
                out['comprobantes'].setdefault(key, base)
            else:
                base.update(importe=None)
                out['otros'].append(base)
    # compensa.fac y cuenta.fac (solo del primer directorio que los tenga: son acumulados)
    cf = os.path.join(d, 'compensa.fac')
    if os.path.exists(cf) and not out['compensa']:
        F = T['COMPENSA']['000']; b = open(cf, 'rb').read()
        pat = re.compile(rb'@(.)(\d{14}\d\d{8})', re.S)
        for m in pat.finditer(b):
            r = g.decode(F, b[m.start(2):m.start(2) + 120])
            if r['CLIPRO'] != '0': continue
            out['compensa'].append(dict(agenda=r['CODIGOAGENDA'], fecha=fecha(r['FECHA']), importe=r['IMPORTE'],
                                        c1_punto=r['CPTE1CODIGOPUNTO'], c1_tipo=r['CPTE1TIPOCPTE'], c1_letra=r['CPTE1LETRA'].strip(), c1_numero=r['CPTE1NUMERO'],
                                        c2_punto=r['CPTE2CODIGOPUNTO'], c2_tipo=r['CPTE2TIPOCPTE'], c2_letra=r['CPTE2LETRA'].strip(), c2_numero=r['CPTE2NUMERO']))
    cu = os.path.join(d, 'cuenta.fac')
    if os.path.exists(cu) and not out['cuenta']:
        F = T['CUENTA']['001']; b = open(cu, 'rb').read()
        pat = re.compile(rb'@(.)(\d{11}[A-Z ]\d{13}\d{8})', re.S)
        for m in pat.finditer(b):
            st = m.group(1)[0]
            r = g.decode(F, b[m.start(2):m.start(2) + 160])
            if r['CLIPRO'] != '0': continue
            out['cuenta'].append(dict(estado=hex(st), punto=r['CODIGOPUNTO'], tipo_cod=r['CODIGOCPTE'], tipo=TIPOS.get(r['CODIGOCPTE'], r['CODIGOCPTE']),
                                      letra=r['LETRACPTE'].strip(), numero=r['NUMEROCPTE'], agenda=r['CODIGOAGENDA'], fecha=fecha(r['FECHA']),
                                      vencimiento=fecha(r['VENCIMIENTO']), importe=r['IMPORTE'], cancelado=r['IMPCANCELADO'],
                                      moneda_cod=r['CODIGOMONEDA'], importe_moneda=r['MONEDAIMPORTE'], cancelado_moneda=r['MONEDACANCELADO']))


def escribir(path, filas, campos=None):
    if not filas:
        open(path, 'w').close(); return
    campos = campos or list(filas[0].keys())
    with open(path, 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=campos, delimiter=';', extrasaction='ignore')
        w.writeheader()
        for r in filas: w.writerow(r)


def main():
    args = [a for a in sys.argv[1:]]
    outdir = HERE + '/out'
    if '--out' in args:
        i = args.index('--out'); outdir = args[i + 1]; del args[i:i + 2]
    if not args:
        print(__doc__); sys.exit(1)
    os.makedirs(outdir, exist_ok=True)
    g.D = args[0].rstrip('/\\') + os.sep
    T = g.load_dict()
    out = dict(comprobantes={}, imputaciones=[], valores=[], compensa=[], cuenta=[], otros=[])
    for d in args:
        leer_carpeta(d, T, out)
    comps = sorted(out['comprobantes'].values(), key=lambda r: (r['fecha'], r['punto'], r['numero']))
    campos = ['archivo', 'punto', 'tipo_cod', 'tipo', 'letra', 'numero', 'agenda', 'tiporeg', 'anulado', 'fecha', 'vencimiento',
              'importe', 'tc', 'importe_divisa', 'divisa', 'moneda_cc', 'cae', 'fecha_recepcion', 'cobrador', 'leyenda']
    for r in comps:
        for c in campos: r.setdefault(c, '')
    escribir(os.path.join(outdir, 'comprobantes.csv'), comps, campos)
    escribir(os.path.join(outdir, 'imputaciones.csv'), out['imputaciones'])
    escribir(os.path.join(outdir, 'valores.csv'), out['valores'])
    escribir(os.path.join(outdir, 'compensa.csv'), out['compensa'])
    escribir(os.path.join(outdir, 'cuenta.csv'), out['cuenta'])
    escribir(os.path.join(outdir, 'otros.csv'), out['otros'], campos)
    from collections import Counter
    print('comprobantes', len(comps), dict(Counter((r['punto'], r['tipo']) for r in comps)))
    print('imputaciones', len(out['imputaciones']), 'valores', len(out['valores']), 'compensa', len(out['compensa']), 'cuenta', len(out['cuenta']), 'otros', len(out['otros']))


if __name__ == '__main__':
    main()
