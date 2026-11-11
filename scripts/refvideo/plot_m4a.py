"""M4-A 基准图：自由运动段的移动速度（相对满转速档）与相对地面倾角，随转速比例变化（签名矩阵 320 回合）。"""
import json
import sys

import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager

font_manager.fontManager.addfont('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc')
plt.rcParams['font.family'] = ['Noto Sans CJK SC', 'sans-serif']
plt.rcParams['axes.unicode_minus'] = False

SURF, INK, INK2, MUTED, GRID = '#fcfcfb', '#0b0b0b', '#52514e', '#898781', '#e7e6e1'
COL = {'lieren': '#2a78d6', 'senheng': '#eb6834', 'ziyao': '#1baf7a', 'pandun': '#eda100'}
NAME = {'lieren': '烈刃（攻）', 'senheng': '森衡（衡）', 'ziyao': '紫曜（耐）', 'pandun': '磐盾（防）'}

d = json.load(open(sys.argv[1]))
curves = d['M4A-MATRIX-CURVES'][0]
theory = {r['name']: r['critRatioAt08'] for r in d['M4A-THEORY'][0]['rows']}

fig, axes = plt.subplots(2, 1, figsize=(7.2, 9.0), facecolor=SURF)
fig.subplots_adjust(left=0.12, right=0.80, top=0.90, bottom=0.07, hspace=0.38)
fig.text(0.04, 0.965, 'M4-A 基准：当前版本随转速下降的运动与姿态', color=INK, fontsize=14)
fig.text(0.04, 0.938, '签名矩阵 320 回合的自由运动段（不在接触中、距上次接触 ≥ 0.3 s）【模拟实测】', color=INK2, fontsize=9)

lo, hi = min(theory[k] for k in COL), max(theory[k] for k in COL)
for ax in axes:
    ax.set_facecolor(SURF)
    ax.axvspan(lo, hi, color='#f0efec', zorder=0)
    ax.grid(axis='y', color=GRID, lw=0.8)
    for s in ('top', 'right'):
        ax.spines[s].set_visible(False)
    for s in ('left', 'bottom'):
        ax.spines[s].set_color(MUTED)
    ax.tick_params(colors=INK2, labelsize=9)
    ax.set_xlim(1.0, 0.0)
    ax.set_xlabel('转速比例（转速 / 发射转速）→ 时间方向', color=INK2, fontsize=9)

def series(key, field, norm=False):
    rows = list(reversed(curves[key]['bins']))  # 低 → 高
    xs, ys = [], []
    for r in rows:
        a, b = [float(v) for v in r['ratio'].split('–')]
        xs.append((a + b) / 2)
        ys.append(r[field])
    if norm:
        top = ys[-1]
        ys = [y / top for y in ys]
    return xs, ys

def labels(ax, ends, span):
    # 线尾标签：按 y 排序后保证最小间距，移动过的用细引线连回线尾
    ends = sorted(ends, key=lambda e: e[1])
    gap = span * 0.075
    ys = []
    for i, (_, y, _) in enumerate(ends):
        ys.append(max(y, ys[-1] + gap) if ys else y)
    for (k, y0, x0), y in zip(ends, ys):
        ax.text(-0.035, y, NAME[k], color=INK2, fontsize=9, va='center', ha='left', clip_on=False)
        if abs(y - y0) > 1e-9:
            ax.plot([x0, -0.03], [y0, y], color=MUTED, lw=0.6, clip_on=False)

ax = axes[0]
ax.set_title('移动速度（相对 0.9–1.0 档）', color=INK, fontsize=11, loc='left')
ends = []
for k in COL:
    xs, ys = series(k, 'speed', norm=True)
    ax.plot(xs, ys, color=COL[k], lw=2, marker='o', ms=4, mec=SURF, mew=1.5, zorder=3)
    ends.append((k, ys[0], xs[0]))
ax.set_ylim(0, 1.1)
labels(ax, ends, 1.1)
ax.text(hi + 0.005, 1.04, '理论临界转速区间\n（刚体公式推算）', color=MUTED, fontsize=8, ha='right', va='top')

ax = axes[1]
ax.set_title('转轴相对地面法线的倾角（rad）', color=INK, fontsize=11, loc='left')
ends = []
for k in COL:
    xs, ys = series(k, 'tiltN')
    ax.plot(xs, ys, color=COL[k], lw=2, marker='o', ms=4, mec=SURF, mew=1.5, zorder=3)
    ends.append((k, ys[0], xs[0]))
ax.set_ylim(0, 0.65)
labels(ax, ends, 0.65)

fig.savefig(sys.argv[2], dpi=150, facecolor=SURF)
print('ok')
