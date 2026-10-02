import json
d = json.load(open('nbrk_monthly.json'))
M = ['01.02.2026', '01.03.2026', '01.04.2026', '01.05.2026', '01.06.2026', '01.07.2026', '01.08.2026', '01.09.2026']
MN = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг']
FY = '01.01.2026 с ЗО'; Y25 = '01.09.2025'
bn = lambda v: float(v) / 1e6  # тыс. тг -> млрд тг

# месячная прибыль
monthly = {}
for k in ['HSBK', 'KSPI', 'CCBN', 'ASBN', 'HCB', 'FRHC']:
    ytd = [bn(d[k][m]['ni_ytd']) for m in M]
    monthly[k] = [ytd[0]] + [ytd[i] - ytd[i - 1] for i in range(1, 8)]
    ltm = ytd[-1] + bn(d[k][FY]['ni_ytd']) - bn(d[k][Y25]['ni_ytd'])
    print(f"{k:5s} мес. ЧП, млрд:", ' '.join(f"{v:6.1f}" for v in monthly[k]),
          f"| 8м26 {ytd[-1]:.1f} vs 8м25 {bn(d[k][Y25]['ni_ytd']):.1f} ({ytd[-1]/bn(d[k][Y25]['ni_ytd'])-1:+.0%}) | 2025 {bn(d[k][FY]['ni_ytd']):.1f} | LTM {ltm:.1f}")

# мультипликаторы
fx = 451.5
px = {'HSBK': 372.9, 'KSPI': 42940, 'CCBN': 4848.99, 'ASBN': 10.44, 'FRHC': 168.2 * fx}
sh = {'HSBK': 10909.361466e6, 'KSPI': 190.027266e6, 'CCBN': 174.558994e6, 'ASBN': 95.814283454e9, 'FRHC': 63.803116e6}
mcap = {k: px[k] * sh[k] / 1e9 for k in px}
mcap['CCBN'] += 175559 * 5901 / 1e9  # + префы
div_ltm = {'HSBK': 30.10 + 28.09, 'KSPI': 850 + 850 + 1000, 'CCBN': 0, 'ASBN': 0, 'FRHC': 0}
at1, at1_coupon = 209.6, 400e6 * 0.0975 * fx / 1e9
res = {}
for k in ['HSBK', 'CCBN', 'ASBN', 'KSPI', 'FRHC']:
    e = bn(d[k]['01.09.2026']['equity']); e0 = bn(d[k]['01.09.2025']['equity'])
    ytd = bn(d[k]['01.09.2026']['ni_ytd']); ltm = ytd + bn(d[k][FY]['ni_ytd']) - bn(d[k][Y25]['ni_ytd'])
    if k == 'ASBN':  # Forte + дочерний HCB (меньшинство выкуплено), минус AT1 и его купон
        h = d['HCB']; ytd += bn(h['01.09.2026']['ni_ytd'])
        ltm += bn(h['01.09.2026']['ni_ytd']) + bn(h[FY]['ni_ytd']) - bn(h[Y25]['ni_ytd'])
        ltm -= at1_coupon; ytd -= at1_coupon * 8 / 12; e -= at1; e0 -= at1
    r = dict(mcap=mcap[k], equity=e, ni_ltm=ltm, pb=mcap[k] / e, pe_ltm=mcap[k] / ltm,
             pe_26=mcap[k] / (ytd * 12 / 8), roe_ltm=ltm / ((e + e0) / 2), dy=div_ltm[k] / (px[k] if k != 'FRHC' else 1))
    res[k] = r
    print(f"{k}: капитализация {r['mcap']:,.0f} млрд | капитал банка {e:,.0f} | ЧП LTM {ltm:,.0f} | P/B {r['pb']:.2f} | P/E LTM {r['pe_ltm']:.1f} | P/E 2026 (8м×1,5) {r['pe_26']:.1f} | ROE LTM {r['roe_ltm']:.1%} | див. дох. {r['dy']:.1%}")
json.dump({'monthly_ni': monthly, 'multiples': res}, open('multiples_out.json', 'w'), ensure_ascii=False, indent=1)
