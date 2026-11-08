"""
低速停滞探针：逐步时间序列图。
  python3 scripts/stallprobe-plot.py <series.csv> <out.png> [标题] [对照 series.csv] [对照标签]
上：刀刃 XZ 间隙 / 三维形状距离 / 证据等级；中：两台水平速度；下：两台转速与 WATCH(0.4) 区间。
"""
import csv
import math
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

plt.rcParams["font.sans-serif"] = ["Noto Sans CJK SC", "WenQuanYi Zen Hei", "DejaVu Sans"]
plt.rcParams["axes.unicode_minus"] = False


def load(p):
    with open(p) as f:
        rows = list(csv.DictReader(f))
    col = lambda k: [float(r[k]) if r[k] not in ("Infinity", "NaN", "") else math.nan for r in rows]
    return col


def panel(axs, col, label, ls="-"):
    t = col("t")
    d3 = [x if x < 1 else math.nan for x in col("dist3d")]
    axs[0].plot(t, col("bladeGap"), ls, lw=0.7, label=f"{label} 刀刃XZ间隙")
    axs[0].plot(t, d3, ls, lw=0.7, label=f"{label} 三维形状距离")
    ev = col("evidence")
    axs[0].scatter([t[i] for i in range(len(t)) if ev[i] == 2], [0] * sum(1 for e in ev if e == 2), s=4, c="red", label=f"{label} 确认接触", zorder=3)
    axs[1].plot(t, col("aSpeed"), ls, lw=0.6, label=f"{label} 玩家速度")
    axs[1].plot(t, col("bSpeed"), ls, lw=0.6, label=f"{label} 对手速度")
    axs[2].plot(t, col("aSpin"), ls, lw=0.7, label=f"{label} 玩家转速")
    axs[2].plot(t, col("bSpin"), ls, lw=0.7, label=f"{label} 对手转速")
    w = col("watch04")
    axs[2].fill_between(t, 0, [140 if x else 0 for x in w], alpha=0.08, step="mid", label=f"{label} WATCH(0.4)")


src, out = sys.argv[1], sys.argv[2]
title = sys.argv[3] if len(sys.argv) > 3 else src
fig, axs = plt.subplots(3, 1, figsize=(14, 8), sharex=True)
panel(axs, load(src), "B")
if len(sys.argv) > 5:
    panel(axs, load(sys.argv[4]), sys.argv[5], "--")
axs[0].set_ylim(-0.15, 0.4)
axs[0].axhline(0, c="k", lw=0.5)
axs[0].set_ylabel("间隙 / 距离 (m)")
axs[1].set_ylim(0, 3)
axs[1].set_ylabel("水平速度 (m/s)")
axs[2].set_ylabel("转速 (rad/s)")
axs[2].set_xlabel("时间 (s)")
for a in axs:
    a.legend(fontsize=7, loc="upper right", ncol=3)
fig.suptitle(title)
fig.tight_layout()
fig.savefig(out, dpi=110)
