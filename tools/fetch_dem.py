"""Download Terrarium elevation tiles (AWS Terrain Tiles, zoom 12) covering the game world."""
import sys, os, math, urllib.request, concurrent.futures as cf

Z = 12
LON = (76.58, 77.33)
LAT = (42.95, 43.50)

def tile(lon, lat):
    n = 2 ** Z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return x, y

def main(out):
    os.makedirs(out, exist_ok=True)
    x0, y1 = tile(LON[0], LAT[0]); x1, y0 = tile(LON[1], LAT[1])
    jobs = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
    def get(xy):
        x, y = xy
        p = os.path.join(out, f'{Z}_{x}_{y}.png')
        if not os.path.exists(p):
            urllib.request.urlretrieve(f'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{Z}/{x}/{y}.png', p)
        return p
    with cf.ThreadPoolExecutor(16) as ex:
        list(ex.map(get, jobs))
    print(f'{len(jobs)} tiles x {x0}..{x1} y {y0}..{y1}')

if __name__ == '__main__':
    main(sys.argv[1])
