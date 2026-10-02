"""Оценка по методике Гордона для банков и 5-летние сценарии доходности.

Справедливый P/B = (ROE - g) / (COE - g).
Сценарий: балансовая стоимость растёт на ROE*(1-payout), дивиденды = ROE*BV*payout,
цена выхода через 5 лет = справедливый P/B (по ROE и COE сценария) * BV_5.
Налоги: ставки на дивиденды и прирост из inputs.json (по нормам НК РК 2026).
"""
import json

H = 5


def fair_pb(roe, coe, g):
    return max((roe - g) / (coe - g), 0.0)


def irr(cfs):
    lo, hi = -0.99, 3.0
    f = lambda r: sum(c / (1 + r) ** i for i, c in enumerate(cfs))
    for _ in range(200):
        mid = (lo + hi) / 2
        if f(mid) > 0:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def scenario(p0, bv0, s, coe, g, t_div, t_cg, fx_dep=0.0):
    """s: dict(roe=[...5 лет], payout, exit_roe, exit_coe(опц.)). fx_dep — годовое
    ослабление тенге к валюте бумаги (для FRHC), доходность пересчитывается в тенге."""
    bv = bv0
    cfs = [-p0]
    divs = []
    for y in range(H):
        roe = s['roe'][y]
        d = roe * bv * s['payout']
        bv = bv * (1 + roe * (1 - s['payout']))
        divs.append(d)
        cfs.append(d * (1 - t_div))
    pb_exit = fair_pb(s['exit_roe'], s.get('exit_coe', coe), g)
    p5 = pb_exit * bv
    cg_tax = max(p5 - p0, 0) * t_cg
    cfs[-1] += p5 - cg_tax
    r = irr(cfs)
    r_kzt = (1 + r) * (1 + fx_dep) - 1
    return dict(bv5=bv, pb_exit=pb_exit, p5=p5, divs=divs, irr=r, irr_kzt=r_kzt,
                total_mult=(sum(cfs[1:]) / p0))


def run(path='data/model_inputs.json'):
    inp = json.load(open(path))
    out = {}
    for t, x in inp['stocks'].items():
        g = x.get('g', inp['g'])
        res = {'pb_now': x['p0'] / x['bv0'],
               'pe_now': x['p0'] / x['eps_ltm'] if x.get('eps_ltm') else None}
        res['fair_pb'] = {str(c): fair_pb(x['roe_sust'], c, g) for c in inp['coe_grid']}
        res['fair_price'] = {c: v * x['bv0'] for c, v in res['fair_pb'].items()}
        res['upside_base'] = res['fair_price'][str(x['coe'])] / x['p0'] - 1
        res['scen'] = {k: scenario(x['p0'], x['bv0'], s, x['coe'], g, x['t_div'], x['t_cg'],
                                   s.get('fx_dep', 0.0))
                       for k, s in x['scenarios'].items()}
        if 'probs' in x:
            res['exp_irr_kzt'] = sum(x['probs'][k] * res['scen'][k]['irr_kzt'] for k in x['probs'])
        out[t] = res
    return inp, out


if __name__ == '__main__':
    inp, out = run()
    json.dump(out, open('data/model_out.json', 'w'), indent=1, ensure_ascii=False)
    for t, r in out.items():
        print(t, f"P/B {r['pb_now']:.2f}", {k: round(v, 2) for k, v in r['fair_pb'].items()},
              f"upside {r['upside_base']:+.0%}",
              {k: f"{v['irr_kzt']:.1%}" for k, v in r['scen'].items()},
              f"E[IRR] {r.get('exp_irr_kzt', 0):.1%}")
