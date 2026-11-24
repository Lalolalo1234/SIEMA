#!/usr/bin/env python3
"""Descarga las series abiertas del SIACAM (Secretaría de Minería) desde datos.gob.ar.

Lo ejecuta la acción de GitHub «SIACAM semanal» (.github/workflows/siacam-semanal.yml).
- Busca en el catálogo CKAN de datos.gob.ar todos los datasets cuyo título contenga «SIACAM».
- Descarga cada recurso CSV a data/siacam/raw/<dataset>/<recurso>.csv.
- Escribe data/siacam/manifest.json (qué se bajó, de dónde, fecha de actualización oficial, filas, huella).
- Arma data/siacam/sustentabilidad.json (agua, energía y emisiones por proyecto, reportes GRI),
  que la sección «Transparencia, pagos y conflictividad» muestra sola cuando existe.
No modifica index.html: las tareas semanales leen estos archivos y deciden qué cifras actualizar.
"""
import csv
import hashlib
import io
import json
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from datetime import datetime, timezone

API = 'https://datos.gob.ar/api/3/action/package_search'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'siacam')
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
UA = {'User-Agent': 'Mozilla/5.0 (compatible; SIEMA-siacam-sync/1.1; +https://lalolalo1234.github.io/SIEMA/)', 'Accept': 'text/csv,*/*'}


def get(url, tries=1, timeout=15):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return r.read()
        except Exception:  # noqa: BLE001
            if i == tries - 1:
                raise
            time.sleep(3)


def slug(s):
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')[:80]


def packages():
    out, start = [], 0
    while True:
        q = urllib.parse.urlencode({'q': 'SIACAM', 'rows': 100, 'start': start})
        res = json.loads(get(f'{API}?{q}'))['result']
        out += [p for p in res['results'] if 'siacam' in (p.get('title', '') + p.get('name', '')).lower()]
        start += 100
        if start >= res['count']:
            return out


def num(x):
    if x is None:
        return None
    x = str(x).strip().replace(' ', '')
    if not x:
        return None
    if re.match(r'^-?[\d.]+,\d+$', x):
        x = x.replace('.', '').replace(',', '.')
    else:
        x = x.replace(',', '')
    try:
        return float(x)
    except ValueError:
        return None


def build_sust(files):
    """Une los CSV de agua, energía y GEI por proyecto (columna Proyecto_Minero)."""
    rows, years = {}, {}
    kinds = [('agua', 'agua'), ('energ', 'energia'), ('gases', 'gei'), ('gei', 'gei'), ('emision', 'gei')]
    for f in files:
        name = slug(f['resource'])
        kind = next((v for k, v in kinds if k in name), None)
        if not kind:
            continue
        text = open(f['path'], encoding='utf-8-sig', errors='replace').read()
        for r in csv.DictReader(io.StringIO(text)):
            p = (r.get('Proyecto_Minero') or r.get('proyecto_minero') or '').strip()
            if not p:
                continue
            val = None
            for c, v in r.items():
                cl = (c or '').lower()
                if cl.startswith('proyecto') or 'anio' in cl or 'año' in cl:
                    continue
                n = num(v)
                if n is not None:
                    val = n
                    break
            rows.setdefault(p, {'p': p})[kind] = val
            y = next((r[c] for c in r if c and ('anio' in c.lower() or 'año' in c.lower())), None)
            if y:
                years[p] = str(y).strip()
    for p, y in years.items():
        rows[p]['anio'] = y
    return sorted(rows.values(), key=lambda r: r['p'])


def main():
    os.makedirs(os.path.join(OUT, 'raw'), exist_ok=True)
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    manifest = {'generated': now, 'source': 'datos.gob.ar (Secretaría de Minería, SIACAM)', 'datasets': []}
    files = []
    fails = 0
    for p in packages():
        freq = next((e.get('value') for e in p.get('extras', []) if 'accrual' in e.get('key', '').lower()), None)
        ds = {'title': p['title'], 'id': p['name'], 'modified': p.get('metadata_modified'), 'frequency': freq, 'resources': []}
        d = os.path.join(OUT, 'raw', slug(p['name']))
        for r in p.get('resources', []):
            fmt = (r.get('format') or '').lower()
            url = r.get('url') or ''
            if fmt != 'csv' and not url.lower().endswith('.csv'):
                continue
            os.makedirs(d, exist_ok=True)
            path = os.path.join(d, slug(r.get('name') or r['id']) + '.csv')
            body, err = None, None
            for u in dict.fromkeys([url, url.replace('http://', 'https://')]):
                try:
                    body = get(u)
                    break
                except Exception as e:  # noqa: BLE001
                    err = f'{type(e).__name__}: {e}'
            if body is None:
                fails += 1
                print(f'  sin descargar: {url} -> {err}'[:300], flush=True)
                if fails >= 5 and not files:
                    sys.exit('ATENCIÓN: los primeros 5 CSV del SIACAM no responden desde este servidor; se corta la corrida.')
                ds['resources'].append({'name': r.get('name'), 'url': url, 'error': (err or '')[:200]})
                continue
            open(path, 'wb').write(body)
            item = {
                'name': r.get('name'), 'url': url,
                'file': os.path.relpath(path, ROOT).replace(os.sep, '/'),
                'rows': max(0, body.count(b'\n') - 1),
                'sha256': hashlib.sha256(body).hexdigest()[:16],
                'modified': r.get('last_modified') or r.get('created'),
            }
            ds['resources'].append(item)
            files.append({'resource': r.get('name') or '', 'path': path, 'dataset': p['name']})
        manifest['datasets'].append(ds)
    with open(os.path.join(OUT, 'manifest.json'), 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=1)
    sust = build_sust([f for f in files if 'sustentabilidad' in f['dataset']])
    if sust:
        src = 'Fuente: SIACAM, indicadores de sustentabilidad según el último reporte GRI de cada proyecto (datos.gob.ar). Descargado el ' + now[:10] + '.'
        with open(os.path.join(OUT, 'sustentabilidad.json'), 'w', encoding='utf-8') as fh:
            json.dump({'rows': sust, 'src': src}, fh, ensure_ascii=False, indent=1)
    ok = sum(1 for d in manifest['datasets'] for r in d['resources'] if 'error' not in r)
    print(f"{len(manifest['datasets'])} datasets, {ok} CSV descargados, {len(sust)} proyectos con indicadores GRI")
    if ok == 0:
        sys.exit('ATENCIÓN: no se pudo descargar ningún CSV del SIACAM')


if __name__ == '__main__':
    main()
