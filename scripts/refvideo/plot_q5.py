"""M4-B 探针 Q5 图：同一组单台（B2 开关、480 Hz）在三种重力尺度下的俯视轨迹与移动速度。
用法：python3 -I plot_q5.py <probe3.json> <out.png>"""
import json
import math
import sys

import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.collections import LineCollection
from matplotlib.colors import LinearSegmentedColormap

font_manager.fontManager.addfont('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc')
plt.rcParams['font.family'] = ['Noto Sans CJK SC', 'sans-serif']
plt.rcParams['axes.unicode_minus'] = False

SURF, INK, INK2, MUTED, GRID, BAND = '#fcfcfb', '#0b0b0b', '#52514e', '#898781', '#e7e6e1', '#efeee9'
COL = {'lieren': '#2a78d6', 'senheng': '#eb6834'}
NAME = {'lieren': '烈刃（攻 · 橡胶平底）', 'senheng': '森衡（衡 · 平齿）', 'ziyao': '紫曜（耐 · 球头）'}
R_ARENA = 5.4
# 转速比例 → 颜色：高转速深、低转速浅（单色顺序色阶）
RAMP = LinearSegmentedColormap.from_list('spin', ['#cfe0f5', '#2a78d6', '#0b3a75'])

d = json.load(open(sys.argv[1]))
runs = d['M4B-PROBE-Q5']
CFG = [(20, 1.0, 'g = 20（现有），地面摩擦 × 1'), (80, 0.25, 'g = 80，地面摩擦 × 0.25'), (150, 0.133, 'g = 150，地面摩擦 × 0.133')]
KEYS = ['lieren', 'senheng', 'ziyao']


def find(key, g, seed_idx):
    xs = [x for x in runs if x['key'] == key and x['g'] == g]
    xs.sort(key=lambda x: x['seed'])
    return xs[seed_idx]


fig = plt.figure(figsize=(10.5, 14.2), facecolor=SURF)
fig.text(0.04, 0.975, 'B2 根因探针 Q5：同一物理模型在三种重力尺度下（μ·g 不变）', color=INK, fontsize=14)
fig.text(0.04, 0.958, '陀螺项开、自稳 PD 关、显式牵引关、平底圆角圆柱接地，480 Hz；单台、力度 0.8、种子 = 单台套件第 1 个【模拟实测，只诊断】', color=INK2, fontsize=8.5)
gs = fig.add_gridspec(4, 3, left=0.06, right=0.97, top=0.905, bottom=0.05, hspace=0.32, wspace=0.12, height_ratios=[1, 1, 1, 0.9])

for ci, (g, fs, title) in enumerate(CFG):
    for ri, key in enumerate(KEYS):
        ax = fig.add_subplot(gs[ri, ci])
        ax.set_facecolor(SURF)
        ax.set_aspect('equal')
        t = [i * 2 * math.pi / 200 for i in range(201)]
        # 录像里攻击型开局绕行的半径带 0.35–0.50 R【录像提取】
        ax.fill(
            [0.50 * R_ARENA * math.cos(a) for a in t] + [0.35 * R_ARENA * math.cos(a) for a in reversed(t)],
            [0.50 * R_ARENA * math.sin(a) for a in t] + [0.35 * R_ARENA * math.sin(a) for a in reversed(t)],
            color=BAND, lw=0, zorder=0,
        )
        ax.plot([R_ARENA * math.cos(a) for a in t], [R_ARENA * math.sin(a) for a in t], color=MUTED, lw=1)
        x = find(key, g, 0)
        pts = x['path']
        segs = [[(pts[i][0], pts[i][1]), (pts[i + 1][0], pts[i + 1][1])] for i in range(len(pts) - 1)]
        cols = [RAMP(max(0.0, min(1.0, p[3]))) for p in pts[:-1]]
        ax.add_collection(LineCollection(segs, colors=cols, linewidths=1.1, zorder=2))
        ax.plot(pts[-1][0], pts[-1][1], 'o', ms=5, color=INK, zorder=3)
        ax.set_xlim(-5.8, 5.8)
        ax.set_ylim(-5.8, 5.8)
        ax.set_xticks([])
        ax.set_yticks([])
        for s in ax.spines.values():
            s.set_visible(False)
        if ri == 0:
            ax.set_title(title, color=INK, fontsize=10, pad=6)
        if ci == 0:
            ax.text(-5.9, 0, NAME[key], rotation=90, va='center', ha='right', color=INK, fontsize=10)
        end = {'stop': '停转', 'topple': '倾倒', 'out': '出界', 'limit': '到时'}.get(x['end'], x['end'])
        dst = f"，失衡 {x['destab']} s" if x['destab'] else ''
        ax.text(0, -5.75, f"{x['endAt']:.0f} s {end}{dst}", ha='center', va='top', color=INK2, fontsize=8.5)

# 第 4 行：移动速度（R/s）随转速比例，两个种子
for ci, (g, fs, title) in enumerate(CFG):
    ax = fig.add_subplot(gs[3, ci])
    ax.set_facecolor(SURF)
    ax.axhspan(1.4, 2.2, color=BAND, zorder=0)
    ax.grid(axis='y', color=GRID, lw=0.8)
    for s in ('top', 'right'):
        ax.spines[s].set_visible(False)
    for s in ('left', 'bottom'):
        ax.spines[s].set_color(MUTED)
    ax.tick_params(colors=INK2, labelsize=8.5)
    ax.set_xlim(1.0, 0.0)
    ax.set_ylim(0, 3.2)
    for key in ('lieren', 'senheng'):
        for si, ls in ((0, '-'), (1, '--')):
            x = find(key, g, si)
            bins = list(reversed(x['bins']))
            xs = [(float(b['ratio'].split('–')[0]) + float(b['ratio'].split('–')[1])) / 2 for b in bins]
            ys = [b['speed'] / R_ARENA for b in bins]
            ax.plot(xs, ys, ls, color=COL[key], lw=2 if si == 0 else 1.4, marker='o', ms=3.5 if si == 0 else 0)
    ax.set_xlabel('转速比例（→ 时间方向）', color=INK2, fontsize=8.5)
    if ci == 0:
        ax.set_ylabel('平均移动速度（R/s）', color=INK2, fontsize=8.5)
    else:
        ax.set_yticklabels([])
    if ci == 2:
        ax.text(0.98, 1.8, '录像攻击型开局\n1.4–2.2 R/s', color=INK2, fontsize=8, va='center', ha='left')

# 图例（不靠颜色单独区分：实线 / 虚线 = 种子，标签写名字）
from matplotlib.lines import Line2D

handles = [
    Line2D([], [], color=COL['lieren'], lw=2, marker='o', ms=3.5, label='烈刃 种子 1'),
    Line2D([], [], color=COL['lieren'], lw=1.4, ls='--', label='烈刃 种子 2'),
    Line2D([], [], color=COL['senheng'], lw=2, marker='o', ms=3.5, label='森衡 种子 1'),
    Line2D([], [], color=COL['senheng'], lw=1.4, ls='--', label='森衡 种子 2'),
]
fig.legend(handles=handles, loc='lower center', ncol=4, frameon=False, fontsize=8.5, labelcolor=INK2, bbox_to_anchor=(0.5, 0.005))
fig.text(0.04, 0.943, '轨迹颜色：深 = 高转速 → 浅 = 低转速；灰带 = 录像攻击型绕行半径 0.35–0.50 R【录像提取】；● = 结束位置', color=INK2, fontsize=8.5)
fig.savefig(sys.argv[2], dpi=150, facecolor=SURF)
print('saved', sys.argv[2])
