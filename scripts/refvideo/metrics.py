"""
四段参考录像的轨迹指标（俯视镜头内）。
- 两条轨迹：逐帧最近邻 + 颜色代价关联（analyze.py 的做法），再按颜色给身份（红/绿、紫/银……）。
- 指标：半径分布、速度（盘半径/秒）随时间、绕心角速度方向、接触事件（中心距 < 2×陀螺半径×1.05）、1 秒窗口内的“速度—半径”关系。
输出：<REFVIDEO_DIR>/metrics.json（画图用）+ 打印。
"""
import json
import os

import numpy as np

FPS = 15.0
TOP_R = 0.133
THR = 2 * TOP_R * 1.05
MAXJ = 0.45
BASE = os.environ.get('REFVIDEO_DIR', 'ref')  # 每段录像一个子目录：<BASE>/v1/track2.json …

# 每段录像：使用的俯视区间（帧，含头不含尾）、两台的身份判别（按 Lab 色度）、名称、阶段说明
VIDEOS = {
    'v1': {'title': '暗影双枪 vs 裂震钢钻', 'segs': [(40, 113, '开局'), (238, 346, '中后段→击飞')],
           'ident': None, 'names': ['A', 'B']},
    'v2': {'title': '烈风光翼S vs 烈风天翼S', 'segs': [(20, 140, '开局缠斗'), (140, 260, '中段'), (260, 381, '结尾')],
           'ident': ('b', 'low'), 'names': ['光翼S（紫）', '天翼S（银）']},
    'v3': {'title': '玄武烈刃 vs 八岐腾蛇', 'segs': [(5, 253, '开局连击'), (430, 606, '中段'), (803, 957, '结尾')],
           'ident': ('a', 'high'), 'names': ['玄武烈刃（红·攻）', '八岐腾蛇（绿·耐）']},
    'v4': {'title': '黄金火焰S vs 烈风圣翼S', 'segs': [(50, 124, '开局'), (162, 298, '中段'), (431, 652, '结尾')],
           'ident': ('a', 'high'), 'names': ['黄金火焰S（红·攻）', '烈风圣翼S（黄绿·守）']},
}


def link(frames):
    """两条轨迹（每帧 [u,w] 或 None）+ 每条的平均色度"""
    n = len(frames)
    tr = [[None] * n, [None] * n]
    cols = [[], []]
    start = next((k for k, f in enumerate(frames) if len(f['blobs']) >= 2), None)
    if start is None:
        return tr, cols
    b0 = frames[start]['blobs'][:2]
    last = [np.array([b['u'], b['w']]) for b in b0]
    col = [np.array(b['lab'][1:3]) for b in b0]
    lastf = [start, start]
    for t in (0, 1):
        tr[t][start] = last[t].tolist()
        cols[t].append(col[t].tolist())
    for k in range(start + 1, n):
        cand = frames[k]['blobs'][:3]
        opts = []
        for i in range(-1, len(cand)):
            for j in range(-1, len(cand)):
                if i >= 0 and i == j:
                    continue
                cost, ok = 0.0, True
                for t, q in ((0, i), (1, j)):
                    if q < 0:
                        cost += 0.6
                        continue
                    p = np.array([cand[q]['u'], cand[q]['w']])
                    dj = np.linalg.norm(p - last[t])
                    if dj > MAXJ * min(k - lastf[t], 4):
                        ok = False
                        break
                    cost += dj + 0.01 * np.linalg.norm(np.array(cand[q]['lab'][1:3]) - col[t])
                if ok:
                    opts.append((cost, i, j))
        if not opts:
            continue
        _, i, j = min(opts)
        for t, q in ((0, i), (1, j)):
            if q < 0:
                continue
            p = np.array([cand[q]['u'], cand[q]['w']])
            tr[t][k] = p.tolist()
            last[t], lastf[t] = p, k
            c = np.array(cand[q]['lab'][1:3])
            col[t] = 0.9 * col[t] + 0.1 * c
            if not cand[q]['merged']:
                cols[t].append(c.tolist())
    return tr, cols


def arr(tr):
    P = np.full((len(tr), 2), np.nan)
    for k, x in enumerate(tr):
        if x is not None:
            P[k] = x
    # 中值平滑 3 帧
    Q = P.copy()
    for c in range(2):
        for i in range(len(P)):
            w = P[max(0, i - 1): i + 2, c]
            w = w[~np.isnan(w)]
            Q[i, c] = np.median(w) if len(w) else np.nan
    return Q


out = {}
win_pts = []  # (速度, 半径) 1 秒窗口
for v, cfg in VIDEOS.items():
    d = json.load(open(f'{BASE}/{v}/track2.json'))
    out[v] = {'title': cfg['title'], 'names': cfg['names'], 'segs': []}
    print(f'\n===== {v} {cfg["title"]}')
    for (a, b, label) in cfg['segs']:
        frames = [f for s in d['shots'] if s['overhead'] and 'frames' in s for f in s['frames'] if a <= f['i'] < b]
        frames.sort(key=lambda f: f['i'])
        tr, cols = link(frames)
        P = [arr(tr[0]), arr(tr[1])]
        mc = [np.median(np.array(c), axis=0) if len(c) else np.array([np.nan, np.nan]) for c in cols]
        order = [0, 1]
        if cfg['ident']:
            ch, hi = cfg['ident']
            ci = 0 if ch == 'a' else 1
            first = int(np.argmax([m[ci] for m in mc])) if hi == 'high' else int(np.argmin([m[ci] for m in mc]))
            order = [first, 1 - first]
        P = [P[order[0]], P[order[1]]]
        mc = [mc[order[0]], mc[order[1]]]
        t = np.array([f['i'] for f in frames]) / FPS
        seg = {'label': label, 't': t.tolist(), 'P': [p.tolist() for p in P]}
        print(f'-- {label}：{t[0]:.1f}–{t[-1]:.1f} s（{len(t)} 帧）色度 {np.round(mc[0])} / {np.round(mc[1])}')
        for k in (0, 1):
            Pk = P[k]
            r = np.hypot(Pk[:, 0], Pk[:, 1])
            ok = ~np.isnan(r)
            vel = np.full(len(Pk), np.nan)
            vel[1:] = np.hypot(*(Pk[1:] - Pk[:-1]).T) * FPS
            th = np.arctan2(-Pk[:, 1], Pk[:, 0])
            om = np.full(len(Pk), np.nan)
            dth = (th[1:] - th[:-1] + np.pi) % (2 * np.pi) - np.pi
            om[1:] = dth * FPS
            om[np.r_[False, ~(ok[1:] & ok[:-1])]] = np.nan
            omv = om[~np.isnan(om) & (r > 0.25)]
            n = len(Pk)
            th3 = [slice(0, n // 3), slice(n // 3, 2 * n // 3), slice(2 * n // 3, n)]
            v3 = [np.nanmedian(vel[s]) for s in th3]
            r3 = [np.nanmedian(r[s]) for s in th3]
            print(f'   {cfg["names"][k]}: 有效 {ok.mean():.0%}  半径中位 {np.nanmedian(r):.2f}（三分 {r3[0]:.2f}/{r3[1]:.2f}/{r3[2]:.2f}）'
                  f'  r≥0.5 占 {np.mean(r[ok] >= 0.5):.0%}  速度中位 {np.nanmedian(vel):.2f} R/s（三分 {v3[0]:.2f}/{v3[1]:.2f}/{v3[2]:.2f}，P90 {np.nanpercentile(vel, 90):.2f}）'
                  f'  绕心 {np.nanmedian(omv) if len(omv) else np.nan:+.2f} rad/s（逆时针 {np.mean(omv > 0) if len(omv) else np.nan:.0%}）')
            # 1 秒窗口：平均速度 vs 平均半径
            for s0 in range(0, n - 15, 8):
                vv, rr = vel[s0:s0 + 15], r[s0:s0 + 15]
                if np.sum(~np.isnan(vv)) >= 10:
                    win_pts.append((float(np.nanmean(vv)), float(np.nanmean(rr)), v, label))
        D = np.hypot(*(P[0] - P[1]).T)
        cont = ~np.isnan(D) & (D < THR)
        ev = []
        k = 0
        while k < len(D):
            if cont[k]:
                j = k
                while j + 1 < len(D) and cont[j + 1]:
                    j += 1
                ev.append((round(t[k], 2), round(t[j], 2)))
                k = j + 1
            else:
                k += 1
        dur = t[-1] - t[0]
        gaps = np.diff([e[0] for e in ev]) if len(ev) > 1 else np.array([])
        print(f'   间距中位 {np.nanmedian(D):.2f}；接触 {len(ev)} 次（{len(ev) / dur:.2f}/s），相邻接触间隔中位 {np.median(gaps) if len(gaps) else np.nan:.2f} s；起止 {ev}')
        seg['contacts'] = ev
        out[v]['segs'].append(seg)

W = np.array([(a, b) for a, b, _, _ in win_pts])
if len(W):
    cc = np.corrcoef(W[:, 0], W[:, 1])[0, 1]
    print(f'\n1 秒窗口 {len(W)} 个：速度与半径的相关系数 {cc:.2f}')
    for lo, hi in ((0, 0.4), (0.4, 0.8), (0.8, 1.2), (1.2, 1.8), (1.8, 9)):
        sel = (W[:, 0] >= lo) & (W[:, 0] < hi)
        if sel.sum():
            print(f'   速度 {lo}–{hi} R/s：n={sel.sum()}，平均半径中位 {np.median(W[sel, 1]):.2f}')
out['windows'] = win_pts
json.dump(out, open(f'{BASE}/metrics.json', 'w'))
