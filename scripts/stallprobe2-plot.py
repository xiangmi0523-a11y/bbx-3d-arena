"""
低速停滞探针 V2：单场逐步图（读 series/<场景>.csv.gz）。
  python3 scripts/stallprobe2-plot.py <series.csv.gz> <out.png> [标题]
左：两台绝对 XZ 轨迹（颜色 = 时间，WATCH(0.4) 段加粗）；右上：刀刃间隙 / 三维距离 / 证据类别；右中：水平速度；
右下：牵引施加（1/0）与转速。
"""
import csv
import gzip
import math
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

plt.rcParams["font.sans-serif"] = ["Noto Sans CJK SC", "WenQuanYi Zen Hei", "DejaVu Sans"]
plt.rcParams["axes.unicode_minus"] = False

src, out = sys.argv[1], sys.argv[2]
title = sys.argv[3] if len(sys.argv) > 3 else src
with gzip.open(src, "rt") as f:
    rows = list(csv.DictReader(f))


def col(k):
    out = []
    for r in rows:
        v = r[k]
        try:
            out.append(float(v))
        except ValueError:
            out.append(math.nan)
    return out


t = col("t")
CLS = {"none": 0, "geom": 1, "predict": 2, "real": 3}
cls = [CLS.get(r["cls"], 0) for r in rows]
w = col("watch04")
fig = plt.figure(figsize=(15, 8))
gs = fig.add_gridspec(3, 2, width_ratios=[1, 1.6])
ax0 = fig.add_subplot(gs[:, 0])
for s, c in (("a", "Blues"), ("b", "Oranges")):
    ax0.scatter(col(f"{s}X"), col(f"{s}Z"), c=t, cmap=c, s=[3 if x else 0.3 for x in w], label=f"{'玩家' if s == 'a' else '对手'}")
ax0.add_patch(plt.Circle((0, 0), 0.6, fill=False, ls=":", lw=0.6))
ax0.add_patch(plt.Circle((0, 0), 3.6, fill=False, ls=":", lw=0.6))
ax0.add_patch(plt.Circle((0, 0), 5.4, fill=False, lw=0.8))
ax0.set_aspect("equal")
ax0.set_xlim(-5.6, 5.6)
ax0.set_ylim(-5.6, 5.6)
ax0.set_title("绝对 XZ 轨迹（粗点 = WATCH(0.4)）")
ax0.legend(fontsize=7, loc="upper right")
ax1 = fig.add_subplot(gs[0, 1])
ax1.plot(t, col("bladeGap"), lw=0.6, label="刀刃 XZ 间隙")
ax1.plot(t, [x if x < 1 else math.nan for x in col("dist3d")], lw=0.6, label="三维形状距离")
for k, c in ((1, "#bbb"), (2, "orange"), (3, "red")):
    xs = [t[i] for i in range(len(t)) if cls[i] == k]
    ax1.scatter(xs, [-0.12 + 0.03 * k] * len(xs), s=3, c=c, label=["", "geom", "predict", "real"][k])
ax1.axhline(0, c="k", lw=0.4)
ax1.set_ylim(-0.15, 0.4)
ax1.set_ylabel("m")
ax1.legend(fontsize=7, ncol=5, loc="upper right")
ax2 = fig.add_subplot(gs[1, 1], sharex=ax1)
ax2.plot(t, col("aSpeed"), lw=0.6, label="玩家速度")
ax2.plot(t, col("bSpeed"), lw=0.6, label="对手速度")
ax2.fill_between(t, 0, [3 if x else 0 for x in w], alpha=0.08, step="mid", label="WATCH(0.4)")
ax2.set_ylim(0, 3)
ax2.set_ylabel("m/s")
ax2.legend(fontsize=7, ncol=3, loc="upper right")
ax3 = fig.add_subplot(gs[2, 1], sharex=ax1)
ax3.plot(t, col("aSpin"), lw=0.6, label="玩家转速")
ax3.plot(t, col("bSpin"), lw=0.6, label="对手转速")
ax3b = ax3.twinx()
ax3b.plot(t, [x + 0.02 for x in col("aApplied")], lw=0.4, c="tab:blue", alpha=0.5)
ax3b.plot(t, [x - 0.02 for x in col("bApplied")], lw=0.4, c="tab:orange", alpha=0.5)
ax3b.set_ylim(-0.1, 1.1)
ax3b.set_ylabel("牵引施加")
ax3.set_ylabel("rad/s")
ax3.set_xlabel("时间 (s)")
ax3.legend(fontsize=7, loc="upper right")
fig.suptitle(title)
fig.tight_layout()
fig.savefig(out, dpi=100)
