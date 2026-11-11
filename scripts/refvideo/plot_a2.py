"""M4-A2 对照图：现有模型（M4-A）与两组 A 路线网格在单台里的移动速度、离中心半径、相对地面倾角随转速比例的变化。
用法：python3 -I plot_a2.py <m4a all.json> <a2.json> <out.png>"""
import json
import sys

import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager

font_manager.fontManager.addfont('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc')
plt.rcParams['font.family'] = ['Noto Sans CJK SC', 'sans-serif']
plt.rcParams['axes.unicode_minus'] = False

SURF, INK, INK2, MUTED, GRID, BAND = '#fcfcfb', '#0b0b0b', '#52514e', '#898781', '#e7e6e1', '#efeee9'
R_ARENA = 5.4
base = json.load(open(sys.argv[1]))['M4A-SOLO'][0]['byName']
a2 = {x['cfg']: x['byName'] for x in json.load(open(sys.argv[2]))['M4A2-SOLO']}
SERIES = [
    ('现有模型（M4-A，合成力）', base, '#52514e', '-'),
    ('A 路线 g80 · 转速×1.4 · 倒角0.05', a2['g80-s1.4-b0.05'], '#2a78d6', '-'),
    ('A 路线 g60 · 转速×1 · 倒角0.03', a2['g60-s1-b0.03'], '#eb6834', '--'),
]
KEYS = [('lieren', '烈刃（攻 · 橡胶平底）'), ('senheng', '森衡（衡 · 平齿）'), ('ziyao', '紫曜（耐 · 球头）'), ('pandun', '磐盾（防 · 针尖）')]
ROWS = [('speed', '移动速度（R/s）', lambda v: v / R_ARENA, (0, 2.0)), ('r', '离中心半径（R）', lambda v: v / R_ARENA, (0, 0.9)), ('tiltN', '相对地面倾角（rad）', lambda v: v, (0, 0.8))]


def xy(bins, f, tr):
    pts = []
    for b in bins:
        lo, hi = b['ratio'].split('–')
        pts.append(((float(lo) + float(hi)) / 2, tr(b[f])))
    pts.sort()
    return [p[0] for p in pts], [p[1] for p in pts]


fig, axes = plt.subplots(3, 4, figsize=(13, 9.2), facecolor=SURF)
fig.subplots_adjust(left=0.07, right=0.98, top=0.88, bottom=0.1, hspace=0.32, wspace=0.12)
fig.text(0.07, 0.955, 'M4-A2：现有模型 vs 物理尺度路线（单台，转速从高到低）', color=INK, fontsize=14)
fig.text(0.07, 0.928, '每条线 = 该构筑 6 台单台按转速比例分档的平均；横轴从左（刚发射）到右（快停）【模拟实测，只诊断，默认游戏未改】', color=INK2, fontsize=9)
for ri, (f, lab, tr, yl) in enumerate(ROWS):
    for ci, (k, name) in enumerate(KEYS):
        ax = axes[ri][ci]
        ax.set_facecolor(SURF)
        ax.grid(axis='y', color=GRID, lw=0.8)
        for s in ('top', 'right'):
            ax.spines[s].set_visible(False)
        for s in ('left', 'bottom'):
            ax.spines[s].set_color(MUTED)
        ax.tick_params(colors=INK2, labelsize=8)
        if f == 'r':
            ax.axhspan(0.35, 0.5, color=BAND, zorder=0)
        for lbl, src, col, ls in SERIES:
            x, y = xy(src[k]['bins'], f, tr)
            ax.plot(x, y, ls, color=col, lw=2, marker='o', ms=3)
        ax.set_xlim(1.0, 0.0)
        ax.set_ylim(*yl)
        if ri == 0:
            ax.set_title(name, color=INK, fontsize=10.5)
        if ci == 0:
            ax.set_ylabel(lab, color=INK2, fontsize=9)
        else:
            ax.set_yticklabels([])
        if ri == 2:
            ax.set_xlabel('转速比例', color=INK2, fontsize=8.5)
from matplotlib.lines import Line2D

fig.legend(handles=[Line2D([], [], color=c, ls=ls, lw=2, marker='o', ms=3, label=l) for l, _, c, ls in SERIES], loc='lower center', ncol=3, frameon=False, fontsize=9, labelcolor=INK2)
fig.text(0.98, 0.928, '半径图灰带 = 录像攻击型绕行 0.35–0.50 R', color=INK2, fontsize=9, ha='right')
fig.savefig(sys.argv[3], dpi=150, facecolor=SURF)
print('saved')
