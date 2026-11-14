"""C2-P 判定的独立 Python 复算（不复用 TS 代码）。输入：CI 诊断日志（C2P-ROW / C2P-ARM / C2P-AN- 行）。
点估计必须与 CI 逐项相同；区间用 numpy 的随机数（与 CI 的 mulberry32 不同），只要求结论一致。
用法：python3 reanalyze.py diag.log S1 [arm]
"""
import json, sys, re
import numpy as np

log, SET = sys.argv[1], sys.argv[2]
rows, arms_sum, an = {}, {}, {}
for line in open(log, encoding='utf8'):
    m = re.search(r'(C2P-[A-Z0-9-]+) (\{.*\})\s*$', line)
    if not m:
        continue
    tag, js = m.group(1), m.group(2)
    try:
        o = json.loads(js)
    except Exception:
        continue
    if tag == 'C2P-ROW' and o['set'] == SET:
        rows.setdefault(o['arm'], {})[(o['h'], o['i'])] = o
    elif tag == 'C2P-ARM' and o['set'] == SET:
        arms_sum[o['arm']] = o
    elif tag.startswith('C2P-AN-'):
        an.setdefault(tag, []).append(o)

KEYS = ['lieren', 'pandun', 'senheng', 'ziyao']
G = {'lieren': 'A', 'senheng': 'A', 'pandun': 'D', 'ziyao': 'D'}
seeds = 20 if SET == 'S1' else 40


def med(a):
    a = sorted(a)
    n = len(a)
    if not n:
        return float('nan')
    return a[n // 2] if n % 2 else (a[n // 2 - 1] + a[n // 2]) / 2


def spinfin(r):
    return r['kind'] == 'win' and r['finish'] == 'spin' and r['fp'] is not None


def metrics(R):
    L = list(R.values())
    n = len(L)
    sp = [r for r in L if spinfin(r)]
    de = [r for r in sp if r['fp']['destab']]
    rh = [r['fp']['rho'] for r in de if r['fp']['rho'] is not None]
    kn = [(r['p'] if k[0] == 0 else r['r'], k[1], k[2], k[3]) for r in L for k in r['kn']]
    rec = lambda lo, hi: [x[2] for x in kn if lo <= x[1] < hi and x[3] == 0]
    sp1 = lambda key: [r['sp1'][0] if r['p'] == key else r['sp1'][1] for r in L if r['p'] != r['r'] and r['sp1'] and key in (r['p'], r['r'])]
    out = dict(
        n=n, spin=len(sp),
        E1a=len(de) / len(sp), E1b=med([r['fp']['D'] for r in de]),
        E1c=sum(x > 0.3 for x in rh) / len(rh), E1d=sum(r['fp']['winnerEx'] < r['fp']['loserEx'] for r in sp) / len(sp),
        E4=med(rec(0.3, 0.6)) / med(rec(0.6, 2)), E5=sum(r['frozen'] < 3 for r in L) / n,
        own=sum(r['own'] for r in L) / n, durMed=med([r['dur'] for r in L]),
        atLimit=sum(r['dur'] >= 60 - 1e-6 for r in L) / n,
        burstShare=sum(r['kind'] == 'win' and r['finish'] == 'burst' for r in L) / n,
        opening=med(sp1('lieren')) / med(sp1('pandun')),
    )
    out['p8'] = {}
    for k in KEYS:
        Lk = [r for r in sp if r['fp']['lk'] == k]
        out['p8'][k] = (len(Lk), sum(r['fp']['destab'] for r in Lk) / len(Lk) if Lk else float('nan'))
    return out


def boot(layers, stat, B=2000, seed=7):
    rng = np.random.default_rng(seed)
    vals, deg = [], 0
    for _ in range(B):
        pick = [L[j] for L in layers for j in rng.integers(0, len(L), len(L))]
        v = stat(pick)
        if v is None:
            deg += 1
        else:
            vals.append(v)
    vals.sort()
    q = lambda p: vals[min(len(vals) - 1, max(0, int(np.floor(p * (len(vals) - 1) + 0.5))))]
    return q(0.025), q(0.975), deg


def p4(X, P):
    def lab(r):
        return (G[r['fp']['lk']], r['fp']['onset']) if spinfin(r) else None
    layers = [[(lab(X[(h, i)]), lab(P[(h, i)])) for i in range(seeds)] for h in range(16)]
    def delta(rows, w):
        a = [x[w][1] for x in rows if x[w] and x[w][0] == 'A']
        d = [x[w][1] for x in rows if x[w] and x[w][0] == 'D']
        return (med(a) - med(d)) if a and d else None, len(a), len(d)
    flat = [x for L in layers for x in L]
    dx, na, nd = delta(flat, 0)
    d0, pa, pd = delta(flat, 1)
    def st(rows):
        a, b = delta(rows, 0)[0], delta(rows, 1)[0]
        return None if a is None or b is None else a - b
    lo, hi, deg = boot(layers, st)
    return dict(delta=dx, deltaP0=d0, n=(na, nd, pa, pd), dd=(dx - d0) if dx is not None and d0 is not None else None, ddCI=(lo, hi), degenerate=deg)


def p7c(X, P):
    out = {}
    for k in KEYS:
        layers = []
        for h in range(16):
            p, r = KEYS[h // 4], KEYS[h % 4]
            if p == r or k not in (p, r):
                continue
            side = 0 if p == k else 1
            w = lambda row: 1 if row['kind'] == 'win' and row['win'] == side else 0
            layers.append([(w(P[(h, i)]), w(X[(h, i)])) for i in range(seeds)])
        flat = [x for L in layers for x in L]
        w1 = sum(x[1] for x in flat) / len(flat)
        w0 = sum(x[0] for x in flat) / len(flat)
        lo, hi, _ = boot(layers, lambda rs: sum(x[1] - x[0] for x in rs) / len(rs))
        out[k] = dict(n=len(flat), win=w1, winP0=w0, dwin=w1 - w0, ci=(lo, hi))
    return out


res = {a: metrics(rows[a]) for a in sorted(rows)}
for a, m in res.items():
    print('ARM', a, json.dumps({k: v for k, v in m.items()}, ensure_ascii=False))
for a in sorted(rows):
    if a == 'P0':
        continue
    print('P4', a, json.dumps(p4(rows[a], rows['P0'])))
    print('P7c', a, json.dumps(p7c(rows[a], rows['P0'])))
# 与 CI 判定逐项对照（点估计）
for c in an.get('C2P-AN-ARM', []):
    a = c['arm']
    m = c['metrics']
    diffs = [k for k in ['E1a', 'E1b', 'E1c', 'E1d', 'E4', 'E5', 'own', 'durMed', 'atLimit', 'burstShare', 'opening'] if not (abs(m[k] - res[a][k]) <= 1e-12 or (m[k] != m[k] and res[a][k] != res[a][k]))]
    print('CHECK', a, 'point estimates identical' if not diffs else f'DIFF {diffs}')
for c in an.get('C2P-AN-COND', []):
    a = c['arm']
    P4 = c['P4']
    mine = p4(rows[a], rows['P0'])
    same = abs((P4['delta']['point'] or 0) - (mine['delta'] or 0)) <= 1e-12 and tuple(P4['n'].values()) == mine['n']
    print('CHECK P4', a, 'same' if same else 'DIFF', P4['status'], P4['deltaMinusP0'], 'py CI', mine['ddCI'])
