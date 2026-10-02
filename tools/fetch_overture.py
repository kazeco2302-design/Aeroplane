"""Download Overture Maps features for the Almaty area into local parquet files.

Usage: python3 tools/fetch_overture.py OUT_DIR
Reads only the row groups whose bbox statistics intersect the area.
"""
import sys, os, concurrent.futures as cf
import pyarrow.fs as pafs, pyarrow.parquet as pq, pyarrow as pa, pyarrow.compute as pc

RELEASE = 'overturemaps-us-west-2/release/2026-09-23.1/'
BOX = (76.70, 43.02, 77.16, 43.44)   # lon_min, lat_min, lon_max, lat_max
TYPES = {
    'buildings': 'theme=buildings/type=building',
    'segments': 'theme=transportation/type=segment',
    'land_use': 'theme=base/type=land_use',
    'water': 'theme=base/type=water',
    'infrastructure': 'theme=base/type=infrastructure',
    'land_cover': 'theme=base/type=land_cover',
}
fs = pafs.S3FileSystem(anonymous=True, region='us-west-2')

def rg_hits(path):
    md = pq.ParquetFile(path, filesystem=fs).metadata
    names = [md.schema.column(i).path for i in range(md.num_columns)]
    idx = {n: names.index(n) for n in ('bbox.xmin', 'bbox.xmax', 'bbox.ymin', 'bbox.ymax')}
    hits = []
    for r in range(md.num_row_groups):
        rg = md.row_group(r)
        st = {k: rg.column(i).statistics for k, i in idx.items()}
        if any(s is None or not s.has_min_max for s in st.values()):
            hits.append(r); continue
        if st['bbox.xmin'].min <= BOX[2] and st['bbox.xmax'].max >= BOX[0] and st['bbox.ymin'].min <= BOX[3] and st['bbox.ymax'].max >= BOX[1]:
            hits.append(r)
    return path, hits

def fetch(name, prefix, out):
    files = [f.path for f in fs.get_file_info(pafs.FileSelector(RELEASE + prefix)) if f.path.endswith('.parquet') or 'part-' in f.path]
    with cf.ThreadPoolExecutor(32) as ex:
        found = [(p, h) for p, h in ex.map(rg_hits, files) if h]
    tables = []
    def read(item):
        p, h = item
        t = pq.ParquetFile(p, filesystem=fs).read_row_groups(h)
        b = t.column('bbox')
        m = pc.and_(pc.and_(pc.less_equal(pc.struct_field(b, 'xmin'), BOX[2]), pc.greater_equal(pc.struct_field(b, 'xmax'), BOX[0])),
                    pc.and_(pc.less_equal(pc.struct_field(b, 'ymin'), BOX[3]), pc.greater_equal(pc.struct_field(b, 'ymax'), BOX[1])))
        return t.filter(m)
    with cf.ThreadPoolExecutor(8) as ex:
        tables = list(ex.map(read, found))
    tables = [t for t in tables if t.num_rows]
    t = pa.concat_tables(tables, promote_options='permissive') if tables else None
    n = 0 if t is None else t.num_rows
    if t is not None:
        pq.write_table(t, os.path.join(out, name + '.parquet'))
    print(f'{name}: {len(found)} files, {sum(len(h) for _, h in found)} row groups, {n} features', flush=True)

if __name__ == '__main__':
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    only = sys.argv[2:] or list(TYPES)
    for k in only:
        fetch(k, TYPES[k], out)
