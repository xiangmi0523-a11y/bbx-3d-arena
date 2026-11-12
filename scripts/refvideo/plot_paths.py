"""四段参考录像的俯视轨迹：行 = 录像，列 = 开局 / 中段 / 结尾。方向与录像画面一致（上 = 画面上方）。"""
import json
import os

import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.patches import Rectangle
import numpy as np

BASE = os.environ.get('REFVIDEO_DIR', 'ref')  # 每段录像一个子目录：<BASE>/v1/track2.json …
for f in ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc']:
    font_manager.fontManager.addfont(f)
plt.rcParams['font.family'] = ['Noto Sans CJK SC', 'sans-serif']
plt.rcParams['axes.unicode_minus'] = False

SURF, INK, INK2, MUTED, RING = '#fcfcfb', '#0b0b0b', '#52514e', '#898781', '#c3c2b7'
C = ['#2a78d6', '#eb6834']

m = json.load(open(f'{BASE}/metrics.json'))
rows = [
    ('v1', '暗影双枪 vs 裂震钢钻', '结局：四连击 → 左侧缺口击飞出场', [0, None, 1], ['A', 'B（两台颜色接近，身份未区分）']),
    ('v2', '烈风光翼S vs 烈风天翼S', '结局：撞墙反弹 → 下压 → 触地', [0, 1, 2], ['光翼S（输）', '天翼S（赢）']),
    ('v3', '玄武烈刃 vs 八岐腾蛇', '结局：铲击 → 大倾角绕行 → 触地倒下', [0, 1, 2], ['玄武烈刃（攻 · 赢）', '八岐腾蛇（耐 · 输）']),
    ('v4', '黄金火焰S vs 烈风圣翼S', '结局：中央贴身磨到最后，圣翼S 先倒', [0, 1, 2], ['黄金火焰S（攻 · 赢）', '烈风圣翼S（守 · 输）']),
]
cols = ['开局', '中段', '结尾']

fig, axes = plt.subplots(4, 3, figsize=(10.5, 16.0), facecolor=SURF)
fig.subplots_adjust(left=0.03, right=0.97, top=0.885, bottom=0.02, hspace=0.62, wspace=0.08)
fig.text(0.5, 0.975, '参考录像：两台陀螺的俯视轨迹', ha='center', color=INK, fontsize=16)
fig.text(0.5, 0.955, '单位为盘外沿半径 R；空心圈 = 段起点，实心点 = 段终点；虚线圈 r = 0.5R。方向与画面一致。', ha='center', color=INK2, fontsize=9.5)
fig.text(0.5, 0.940, '只统计俯视镜头（特写 / 慢放镜头未计入），坐标为画面透视下的近似值。', ha='center', color=INK2, fontsize=9.5)
fig.canvas.draw()
rend = fig.canvas.get_renderer()

for ri, (v, title, ending, segmap, names) in enumerate(rows):
    segs = m[v]['segs']
    for ci in range(3):
        ax = axes[ri, ci]
        ax.set_facecolor(SURF)
        ax.set_aspect('equal')
        ax.set_xlim(-1.1, 1.1)
        ax.set_ylim(-1.1, 1.1)
        ax.axis('off')
        th = np.linspace(0, 2 * np.pi, 200)
        ax.plot(np.cos(th), np.sin(th), color=RING, lw=1.2)
        ax.plot(0.5 * np.cos(th), 0.5 * np.sin(th), color=RING, lw=0.8, ls=(0, (3, 3)))
        si = segmap[ci]
        if si is None:
            ax.text(0, 0, '这一段只有特写镜头\n（无俯视画面）', ha='center', va='center', color=MUTED, fontsize=9)
            ax.set_title(cols[ci], color=INK2, fontsize=10, pad=2)
            continue
        s = segs[si]
        t = np.array(s['t'])
        for k in (0, 1):
            P = np.array(s['P'][k], dtype=float)
            x, y = -P[:, 1], -P[:, 0]  # (u, w) 是沿椭圆主轴（≈竖直）的坐标 → 转回画面方向
            ax.plot(x, y, color=C[k], lw=1.3, alpha=0.95, solid_capstyle='round')
            ok = np.where(~np.isnan(x))[0]
            if len(ok):
                ax.plot(x[ok[0]], y[ok[0]], 'o', ms=8, mfc=SURF, mec=C[k], mew=2)
                ax.plot(x[ok[-1]], y[ok[-1]], 'o', ms=8, mfc=C[k], mec=SURF, mew=2)
        if v == 'v1' and ci == 2:
            ax.annotate('23.1 s 从这里\n飞出场外', xy=(-0.93, 0.08), xytext=(-1.08, 0.72), color=INK2, fontsize=8.5,
                        arrowprops=dict(arrowstyle='->', color=MUTED, lw=1))
        n_c = len(s['contacts'])
        dur = t[-1] - t[0]
        ax.set_title(f"{cols[ci]}  {t[0]:.0f}–{t[-1]:.0f} s", color=INK2, fontsize=10, pad=2)
        ax.text(-1.08, -1.09, f'接触 {n_c} 次 / {dur:.0f} s', color=INK2, fontsize=8.5, ha='left', va='bottom')
    top = axes[ri, 0].get_position().y1
    y1 = top + 0.036
    y2 = top + 0.019
    fig.text(0.03, y1, f'{v}  {title}', color=INK, fontsize=12, ha='left', va='bottom')
    fig.text(0.97, y1, ending, color=INK2, fontsize=9.5, ha='right', va='bottom')
    lx = 0.03
    for k in (0, 1):
        fig.patches.append(Rectangle((lx, y2 + 0.0015), 0.011, 0.0065, transform=fig.transFigure, color=C[k]))
        tx = fig.text(lx + 0.015, y2, names[k], color=INK2, fontsize=9, ha='left', va='bottom')
        bb = tx.get_window_extent(renderer=rend).transformed(fig.transFigure.inverted())
        lx = bb.x1 + 0.03

fig.savefig(f'{BASE}/paths.png', dpi=150, facecolor=SURF)
print('ok')
