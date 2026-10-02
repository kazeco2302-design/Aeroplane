"""Build data/almaty-data.js for the game from Overture Maps parquet files and Terrarium DEM tiles.

Usage:
  python3 tools/fetch_overture.py WORK/ov
  python3 tools/fetch_dem.py WORK/dem
  python3 tools/build_data.py WORK data/almaty-data.js

Coordinates: x = metres east, z = metres south of the origin (Republic Square); y = metres above sea level.
Units: DEM in decimetres (row-wise deltas); building anchors and heights in 0.5 m, rectangle sizes and
polygon points in 0.25 m (points delta-coded), rectangle angles in 4096 steps of pi; lines and areas in 0.5 m.
Arrays are little-endian, gzip-compressed and base64-encoded.
"""
import sys, os, io, math, gzip, base64, json, glob, hashlib
import numpy as np
import shapely
import pyarrow.parquet as pq
from PIL import Image

LAT0, LON0 = 43.2380, 76.9455
PHI = math.radians(LAT0)
KX = 111412.84 * math.cos(PHI) - 93.5 * math.cos(3 * PHI)
KZ = 111132.92 - 559.82 * math.cos(2 * PHI) + 1.175 * math.cos(4 * PHI)

DEM = dict(x0=-28000, z0=-26000, step=80, nx=701, nz=676)
CITY = (76.74, 43.115, 77.135, 43.41)          # buildings and lines
AREAS = (76.70, 43.02, 77.16, 43.44)            # land use and water

# Landmarks replaced by hand-built models: data buildings near them are dropped.
EXCLUDE = [  # lat, lon, radius m
    (43.2381, 76.9454, 22),    # Independence Monument
    (43.24470, 76.95780, 34),  # Hotel Kazakhstan
    (43.25865, 76.95325, 42),  # Ascension Cathedral
    (43.21795, 76.92745, 24),  # Esentai Tower
    (43.22985, 76.97720, 45),  # Kok-Tobe TV tower
    (43.23456, 76.91790, 150), # Central Stadium
    (43.15735, 77.05830, 120), # Medeu rink
]


def proj(lon, lat):
    return (np.asarray(lon) - LON0) * KX, -(np.asarray(lat) - LAT0) * KZ


def to_local(geoms):
    return shapely.transform(geoms, lambda c: np.column_stack(proj(c[:, 0], c[:, 1])))


def h32(s):
    return int(hashlib.md5(s.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF


class Blob:
    """Concatenates typed arrays, each 4-byte aligned, with a JSON-able index of sections."""
    def __init__(self):
        self.buf = io.BytesIO(); self.index = {}

    def add(self, name, arr):
        arr = np.ascontiguousarray(arr)
        pad = (-self.buf.tell()) % 4
        self.buf.write(b'\0' * pad)
        self.index[name] = [self.buf.tell(), arr.dtype.str.lstrip('<|'), int(arr.size)]
        self.buf.write(arr.tobytes())

    def encode(self):
        raw = self.buf.getvalue()
        return {'index': self.index, 'size': len(raw), 'gz': base64.b64encode(gzip.compress(raw, 9)).decode()}


# ---------------------------------------------------------------- DEM
def build_dem(work):
    tiles = {}
    for p in glob.glob(os.path.join(work, 'dem', '12_*.png')):
        _, x, y = os.path.basename(p)[:-4].split('_')
        a = np.asarray(Image.open(p).convert('RGB')).astype(np.float64)
        tiles[(int(x), int(y))] = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
    xs = sorted({k[0] for k in tiles}); ys = sorted({k[1] for k in tiles})
    mos = np.zeros((len(ys) * 256, len(xs) * 256))
    for (x, y), a in tiles.items():
        mos[(y - ys[0]) * 256:(y - ys[0] + 1) * 256, (x - xs[0]) * 256:(x - xs[0] + 1) * 256] = a
    n = 2 ** 12
    gx = DEM['x0'] + np.arange(DEM['nx']) * DEM['step']
    gz = DEM['z0'] + np.arange(DEM['nz']) * DEM['step']
    X, Z = np.meshgrid(gx, gz)
    lon = LON0 + X / KX
    lat = LAT0 - Z / KZ
    px = ((lon + 180) / 360 * n - xs[0]) * 256 - 0.5
    py = ((1 - np.arcsinh(np.tan(np.radians(lat))) / math.pi) / 2 * n - ys[0]) * 256 - 0.5
    i0 = np.clip(np.floor(px).astype(int), 0, mos.shape[1] - 2); j0 = np.clip(np.floor(py).astype(int), 0, mos.shape[0] - 2)
    fx = np.clip(px - i0, 0, 1); fy = np.clip(py - j0, 0, 1)
    h = (mos[j0, i0] * (1 - fx) * (1 - fy) + mos[j0, i0 + 1] * fx * (1 - fy) +
         mos[j0 + 1, i0] * (1 - fx) * fy + mos[j0 + 1, i0 + 1] * fx * fy)
    dm = np.clip(np.round(h * 10), 0, 65535).astype(np.uint16)
    delta = dm.copy()
    delta[:, 1:] = (dm[:, 1:].astype(np.int32) - dm[:, :-1].astype(np.int32)).astype(np.uint16)
    b = Blob(); b.add('h', delta)
    print(f'DEM {DEM["nx"]}x{DEM["nz"]}, {h.min():.0f}..{h.max():.0f} m')
    return dict(DEM, **b.encode()), h


# ---------------------------------------------------------------- buildings
LOW_CLASSES = {'garage', 'garages', 'shed', 'roof', 'carport', 'hut', 'kiosk', 'service', 'toilets', 'greenhouse', 'farm_auxiliary', 'transformer_tower', 'container'}
HOUSE_CLASSES = {'house', 'detached', 'semidetached_house', 'bungalow', 'cabin', 'farm', 'terrace', 'static_caravan'}
PUBLIC_CLASSES = {'school', 'kindergarten', 'hospital', 'university', 'college', 'public', 'civic', 'government', 'church', 'mosque', 'train_station', 'transportation', 'sports_hall', 'stadium', 'museum'}
COMMERCIAL_CLASSES = {'commercial', 'retail', 'office', 'hotel', 'supermarket'}
INDUSTRIAL_CLASSES = {'industrial', 'warehouse', 'manufacture', 'hangar', 'factory'}
KIND = {'other': 0, 'house': 1, 'apartments': 2, 'commercial': 3, 'industrial': 4, 'public': 5, 'low': 6}


def classify(cls, area, w, l, dc, key, height, floors):
    r = h32(key)
    if cls in LOW_CLASSES:
        kind = 'low'
    elif cls in HOUSE_CLASSES:
        kind = 'house'
    elif cls in ('apartments', 'residential', 'dormitory'):
        kind = 'apartments'
    elif cls in COMMERCIAL_CLASSES:
        kind = 'commercial'
    elif cls in INDUSTRIAL_CLASSES:
        kind = 'industrial'
    elif cls in PUBLIC_CLASSES:
        kind = 'public'
    else:
        if area < 160:
            kind = 'house'
        elif w < 22 and l / max(w, 1) > 2.4 and l > 36:
            kind = 'apartments'
        elif area > 2500:
            kind = 'commercial' if dc < 6000 else 'industrial'
        else:
            kind = 'apartments' if dc < 5500 else 'house' if area < 300 else 'other'
    if height and height > 1:
        return kind, height
    if floors and floors > 0:
        return kind, floors * 3.1 + 1.2
    central = dc < 4500
    if kind == 'low':
        h = 3.0
    elif kind == 'house':
        h = 4.2 + 3 * (r > 0.6) + (area > 200) * 2.5
    elif kind == 'apartments':
        if w < 22 and l > 36:
            fl = 5 if r < 0.45 else 9 if r < 0.88 else 12
        else:
            fl = (4 + int(r * 4)) if central else (2 + int(r * 4))
        h = fl * 3.0 + 1.5
    elif kind == 'commercial':
        h = (12 + r * 18) if central else (8 + r * 8)
    elif kind == 'industrial':
        h = 7 + r * 6
    elif kind == 'public':
        h = 10 + r * 6
    else:
        h = (9 + r * 9) if central else (5 + r * 5)
    return kind, h


def build_buildings():
    t = pq.read_table(os.path.join(WORK, 'ov', 'buildings.parquet'),
                      columns=['id', 'geometry', 'height', 'num_floors', 'class', 'is_underground', 'min_height', 'bbox'])
    geo = shapely.from_wkb(t.column('geometry').to_numpy(zero_copy_only=False))
    ids = t.column('id').to_pylist(); cls = t.column('class').to_pylist()
    hts = t.column('height').to_pylist(); fls = t.column('num_floors').to_pylist()
    und = t.column('is_underground').to_pylist(); minh = t.column('min_height').to_pylist()
    c = shapely.centroid(geo)
    lon, lat = shapely.get_x(c), shapely.get_y(c)
    keep = (lon > CITY[0]) & (lon < CITY[2]) & (lat > CITY[1]) & (lat < CITY[3])
    ex = [(*proj(lo, la), r) for la, lo, r in EXCLUDE]
    recs = []
    loc = to_local(geo[keep])
    idx = np.nonzero(keep)[0]
    for g, i in zip(loc, idx):
        if und[i] or (minh[i] or 0) > 2:
            continue
        polys = list(g.geoms) if g.geom_type == 'MultiPolygon' else [g]
        for k, p in enumerate(polys):
            a = p.area
            if a < 45:
                continue
            cx, cz = p.centroid.x, p.centroid.y
            if any((cx - ex_x) ** 2 + (cz - ex_z) ** 2 < r * r for ex_x, ex_z, r in ex):
                continue
            p = p.simplify(1.0, preserve_topology=True)
            if p.is_empty or p.geom_type != 'Polygon':
                continue
            mrr = p.minimum_rotated_rectangle
            xy = np.asarray(mrr.exterior.coords)
            v1, v2 = xy[1] - xy[0], xy[2] - xy[1]
            e1 = np.hypot(*v1); e2 = np.hypot(*v2)
            w, l = min(e1, e2), max(e1, e2)
            dc = math.hypot(cx - 300, cz + 300)
            kind, h = classify(cls[i], a, w, l, dc, ids[i] + str(k), hts[i], fls[i])
            tier = 0 if (a >= 150 or h >= 10 or kind in ('apartments', 'commercial', 'public', 'industrial')) else 1 if a >= 80 else 2
            if not p.interiors and len(p.exterior.coords) <= 7 and p.area / max(mrr.area, 1e-6) > 0.94:
                c = mrr.centroid
                ang = math.atan2(v1[1], v1[0]) % math.pi
                recs.append((tier, c.x, c.y, h, KIND[kind], None, (e1, e2, ang)))
                continue
            rings = [np.asarray(p.exterior.coords)[:-1]] + [np.asarray(r.coords)[:-1] for r in p.interiors if shapely.Polygon(r).area > 25]
            if len(rings[0]) < 3 or len(rings) > 255 or any(len(r) > 65535 for r in rings):
                continue
            recs.append((tier, cx, cz, h, KIND[kind], rings, None))
    # spatial order inside each tier (serpentine rows of 300 m cells) keeps anchor deltas small
    def key(r):
        cz_, cx_ = int((r[2] + 30000) // 300), int((r[1] + 30000) // 300)
        return (r[0], cz_, cx_ if cz_ % 2 == 0 else -cx_)
    recs.sort(key=key)
    n = len(recs)
    tiers = [sum(1 for r in recs if r[0] == t) for t in range(3)]
    anchor = np.zeros((n, 2), np.int64); height = np.zeros(n, np.uint16); kind = np.zeros(n, np.uint8); nring = np.zeros(n, np.uint8)
    rw, rl, ra = [], [], []
    rlen, pts = [], []
    for j, (_, cx, cz, h, kd, rings, rect) in enumerate(recs):
        ax, az = round(cx * 2) * 5, round(cz * 2) * 5          # anchors on a 0.5 m lattice
        anchor[j] = (ax // 5, az // 5); height[j] = min(65535, round(h * 2)); kind[j] = kd
        if rect:
            nring[j] = 0
            rw.append(round(rect[0] * 4)); rl.append(round(rect[1] * 4)); ra.append(round(rect[2] / math.pi * 4096) % 4096)
            continue
        nring[j] = len(rings)
        for r in rings:
            rlen.append(len(r))
            q = np.round(r * 4).astype(np.int64) - (round(ax * 0.4), round(az * 0.4))
            q[1:] = np.diff(q, axis=0)   # quarter metres; first point relative to the anchor, the rest to the previous point
            pts.append(np.clip(q, -32767, 32767).astype(np.int16))
    allp = np.concatenate(pts)
    da = np.diff(anchor, axis=0, prepend=[[0, 0]])
    b = Blob()
    b.add('ax', da[:, 0].astype(np.int32)); b.add('az', da[:, 1].astype(np.int32))
    b.add('height', height); b.add('kind', kind); b.add('nring', nring)
    b.add('rw', np.array(rw, np.uint16)); b.add('rl', np.array(rl, np.uint16)); b.add('ra', np.array(ra, np.uint16))
    b.add('rlen', np.array(rlen, np.uint16)); b.add('px', allp[:, 0].copy()); b.add('pz', allp[:, 1].copy())
    print(f'buildings {n} tiers {tiers}, rects {len(rw)}, rings {len(rlen)}, points {sum(rlen)}')
    return dict(count=n, tiers=tiers, **b.encode())


# ---------------------------------------------------------------- lines: roads, rail, water, airport, aerialways
ROAD = {'motorway': 1, 'trunk': 2, 'primary': 3, 'secondary': 4, 'tertiary': 5, 'residential': 6, 'unclassified': 6,
        'living_street': 6, 'unknown': 6, 'service': 7, 'track': 8, 'pedestrian': 9}
RAIL = {'standard_gauge': 10, 'narrow_gauge': 10, 'tram': 11}
WATER_LINE = {'river': 20, 'stream': 21, 'canal': 22, 'drain': 22, 'ditch': 22}
INFRA_LINE = {'runway': 30, 'taxiway': 31, 'gondola': 40, 'cable_car': 40, 'chair_lift': 41, 'mixed_lift': 41}


def tunnel_share(flags):
    if not flags:
        return 0.0
    s = 0.0
    for f in flags:
        if f and 'is_tunnel' in (f.get('values') or []):
            bt = f.get('between')
            s += 1.0 if not bt else bt[1] - bt[0]
    return s


def build_lines():
    lines = []
    seg = pq.read_table(os.path.join(WORK, 'ov', 'segments.parquet'), columns=['subtype', 'class', 'geometry', 'road_flags'])
    g = shapely.from_wkb(seg.column('geometry').to_numpy(zero_copy_only=False))
    sub = seg.column('subtype').to_pylist(); cl = seg.column('class').to_pylist(); fl = seg.column('road_flags').to_pylist()
    for i in range(len(g)):
        code = ROAD.get(cl[i]) if sub[i] == 'road' else RAIL.get(cl[i]) if sub[i] == 'rail' else None
        if code and tunnel_share(fl[i]) < 0.5:
            lines.append((code, g[i]))
    w = pq.read_table(os.path.join(WORK, 'ov', 'water.parquet'), columns=['subtype', 'class', 'geometry'])
    g = shapely.from_wkb(w.column('geometry').to_numpy(zero_copy_only=False))
    for gi, s in zip(g, w.column('subtype').to_pylist()):
        if gi.geom_type in ('LineString', 'MultiLineString') and s in WATER_LINE:
            lines.append((WATER_LINE[s], gi))
    inf = pq.read_table(os.path.join(WORK, 'ov', 'infrastructure.parquet'), columns=['class', 'geometry'])
    g = shapely.from_wkb(inf.column('geometry').to_numpy(zero_copy_only=False))
    for gi, c in zip(g, inf.column('class').to_pylist()):
        if c in INFRA_LINE and gi.geom_type in ('LineString', 'MultiLineString'):
            lines.append((INFRA_LINE[c], gi))
    codes, npts, anchors, pts = [], [], [], []
    for code, gg in lines:
        parts = list(gg.geoms) if gg.geom_type == 'MultiLineString' else [gg]
        for p in parts:
            xy = np.asarray(p.coords)
            mid = xy[len(xy) // 2]
            if not (AREAS[0] < mid[0] < AREAS[2] and AREAS[1] < mid[1] < AREAS[3]):
                continue
            if code < 20 and not (CITY[0] - 0.03 < mid[0] < CITY[2] + 0.03 and CITY[1] - 0.12 < mid[1] < CITY[3] + 0.02):
                continue
            q = shapely.LineString(np.column_stack(proj(xy[:, 0], xy[:, 1])))
            q = q.simplify(1.0 if code < 20 else 3.0)
            q = q.segmentize(250)
            c = np.round(np.asarray(q.coords) * 2).astype(np.int64)   # half metres
            if len(c) < 2 or len(c) > 65535:
                continue
            d = np.diff(c, axis=0)
            codes.append(code); npts.append(len(c)); anchors.append(c[0]); pts.append(d.astype(np.int16))
    b = Blob()
    b.add('code', np.array(codes, np.uint8)); b.add('npts', np.array(npts, np.uint16))
    an = np.array(anchors, np.int64); dl = np.concatenate(pts)
    b.add('ax', an[:, 0].astype(np.int32)); b.add('az', an[:, 1].astype(np.int32))
    b.add('dx', dl[:, 0].copy()); b.add('dz', dl[:, 1].copy())
    from collections import Counter
    print('lines', len(codes), 'points', sum(npts), dict(sorted(Counter(codes).items())))
    return dict(count=len(codes), **b.encode())


# ---------------------------------------------------------------- areas: land use and water polygons
LANDUSE = {
    ('park', 'park'): 1, ('horticulture', 'garden'): 1, ('recreation', 'recreation_ground'): 1, ('park', 'dog_park'): 1,
    ('managed', 'grass'): 2, ('agriculture', 'meadow'): 2, ('horticulture', 'flowerbed'): 2, ('managed', 'village_green'): 2,
    ('recreation', 'pitch'): 3, ('recreation', 'playground'): 3, ('recreation', 'track'): 3, ('recreation', 'stadium'): 3,
    ('cemetery', 'cemetery'): 4, ('cemetery', 'grave_yard'): 4,
    ('developed', 'industrial'): 5, ('construction', 'construction'): 5, ('residential', 'garages'): 5, ('developed', 'railway'): 5,
    ('residential', 'residential'): 6,
    ('education', 'school'): 7, ('education', 'kindergarten'): 7, ('education', 'university'): 7, ('education', 'college'): 7,
    ('medical', 'hospital'): 7, ('developed', 'retail'): 7, ('developed', 'commercial'): 7,
    ('agriculture', 'farmland'): 8, ('horticulture', 'orchard'): 8, ('horticulture', 'allotments'): 8, ('agriculture', 'farmyard'): 8,
    ('pedestrian', 'pedestrian'): 10,
    ('winter_sports', 'downhill'): 11,
}
WATER_AREA = {'lake': 30, 'pond': 30, 'reservoir': 30, 'water': 30, 'river': 32, 'canal': 32, 'human_made': 31}


def build_areas():
    items = []
    lu = pq.read_table(os.path.join(WORK, 'ov', 'land_use.parquet'), columns=['subtype', 'class', 'geometry'])
    g = shapely.from_wkb(lu.column('geometry').to_numpy(zero_copy_only=False))
    for gi, s, c in zip(g, lu.column('subtype').to_pylist(), lu.column('class').to_pylist()):
        code = LANDUSE.get((s, c))
        if code:
            items.append((code, gi))
    w = pq.read_table(os.path.join(WORK, 'ov', 'water.parquet'), columns=['subtype', 'class', 'geometry'])
    g = shapely.from_wkb(w.column('geometry').to_numpy(zero_copy_only=False))
    for gi, s in zip(g, w.column('subtype').to_pylist()):
        if gi.geom_type in ('Polygon', 'MultiPolygon') and s in WATER_AREA:
            items.append((WATER_AREA[s], gi))
    inf = pq.read_table(os.path.join(WORK, 'ov', 'infrastructure.parquet'), columns=['class', 'geometry'])
    g = shapely.from_wkb(inf.column('geometry').to_numpy(zero_copy_only=False))
    for gi, c in zip(g, inf.column('class').to_pylist()):
        if c == 'apron' and gi.geom_type in ('Polygon', 'MultiPolygon'):
            items.append((40, gi))
    codes, nring, rlen, anchors, pts = [], [], [], [], []
    for code, gg in items:
        for p in (list(gg.geoms) if gg.geom_type == 'MultiPolygon' else [gg]):
            c = p.representative_point()
            if not (AREAS[0] < c.x < AREAS[2] and AREAS[1] < c.y < AREAS[3]):
                continue
            q = to_local(np.array([p]))[0].simplify(2.0, preserve_topology=True)
            if q.is_empty or q.geom_type != 'Polygon' or q.area < 150:
                continue
            rings = [np.asarray(q.exterior.coords)[:-1]] + [np.asarray(r.coords)[:-1] for r in q.interiors if shapely.Polygon(r).area > 200]
            rings = [r for r in rings if 3 <= len(r) < 65535][:255]
            if not rings:
                continue
            a = np.round(np.asarray(q.centroid.coords[0]) * 2).astype(np.int64)   # half metres
            codes.append(code); nring.append(len(rings)); anchors.append(a)
            for r in rings:
                rlen.append(len(r))
                pts.append(np.round(r * 2).astype(np.int64) - a)
    allp = np.concatenate(pts)
    big = np.abs(allp).max() > 32767
    b = Blob()
    b.add('code', np.array(codes, np.uint8)); b.add('nring', np.array(nring, np.uint8)); b.add('rlen', np.array(rlen, np.uint16))
    b.add('anchor', np.array(anchors, np.int32).ravel())
    b.add('pts', (allp.astype(np.int32) if big else allp.astype(np.int16)).ravel())
    from collections import Counter
    print('areas', len(codes), 'points', len(allp), 'int32' if big else 'int16', dict(sorted(Counter(codes).items())))
    return dict(count=len(codes), **b.encode())


if __name__ == '__main__':
    WORK, OUT = sys.argv[1], sys.argv[2]
    dem, _ = build_dem(WORK)
    data = {
        'version': 1,
        'source': 'Overture Maps Foundation 2026-09-23.1 (OpenStreetMap contributors, Microsoft ML Buildings); AWS Terrain Tiles',
        'origin': {'lat': LAT0, 'lon': LON0, 'kx': KX, 'kz': KZ},
        'dem': dem,
        'buildings': build_buildings(),
        'lines': build_lines(),
        'areas': build_areas(),
    }
    os.makedirs(os.path.dirname(OUT) or '.', exist_ok=True)
    with open(OUT, 'w') as f:
        f.write('// Generated by tools/build_data.py. Map data: Overture Maps (ODbL, © OpenStreetMap contributors; Microsoft ML Buildings, CDLA-Permissive), elevation: AWS Terrain Tiles.\n')
        f.write('window.ALMATY_DATA = ')
        json.dump(data, f, separators=(',', ':'))
        f.write(';\n')
    print('wrote', OUT, os.path.getsize(OUT) // 1024, 'KB')
