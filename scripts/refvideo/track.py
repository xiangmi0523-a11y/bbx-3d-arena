"""
参考录像轨迹提取 v2：按镜头切分 → 每个俯视镜头用中值背景做前景分割 → 两台陀螺的像素坐标 → 单位圆坐标。
用法：python3 -I scripts/refvideo/track.py <帧目录> <输出 json> <调试图目录>

- 切镜头：相邻帧缩略图平均灰度差 > CUT 视为切换。
- 俯视判定：中值背景里蓝色战斗盘外沿拟合的椭圆中心在画面内、长轴小于内容区宽度（特写镜头的盘会超出画面）。
- 拟合椭圆只用不贴画面边界的轮廓点（盘底部被画面截掉的镜头也能拟合）。
- 前景：与中值背景的颜色差大、且不是“同色调变暗”（陀螺投在盘上的阴影）。
- 两台陀螺接触时前景会连成一块：面积超过单台 1.5 倍时用 k-means 拆成两个中心，并标记 merged。
"""
import json
import os
import sys

import cv2
import numpy as np

src, out, dbg = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(dbg, exist_ok=True)
files = sorted(f for f in os.listdir(src) if f.endswith('.jpg'))
FPS = 15.0
CUT = 18.0
SW = 480  # 处理宽度


def load(i):
    im = cv2.imread(os.path.join(src, files[i]))
    h, w = im.shape[:2]
    return cv2.resize(im, (SW, int(h * SW / w)), interpolation=cv2.INTER_AREA)


# 1) 切镜头
thumbs = []
for i in range(len(files)):
    g = cv2.cvtColor(cv2.imread(os.path.join(src, files[i])), cv2.COLOR_BGR2GRAY)
    thumbs.append(cv2.resize(g, (96, 44), interpolation=cv2.INTER_AREA).astype(np.float32))
cuts = [0]
for i in range(1, len(thumbs)):
    if np.abs(thumbs[i] - thumbs[i - 1]).mean() > CUT:
        cuts.append(i)
cuts.append(len(files))
shots = [(cuts[k], cuts[k + 1]) for k in range(len(cuts) - 1) if cuts[k + 1] - cuts[k] >= 8]

res = {'fps': FPS, 'shots': []}
for (a, b) in shots:
    frames = [load(i) for i in range(a, b)]
    H, W = frames[0].shape[:2]
    step = max(1, (b - a) // 60)
    bg = np.median(np.stack(frames[::step]), axis=0).astype(np.uint8)
    hsv = cv2.cvtColor(bg, cv2.COLOR_BGR2HSV)
    hh, ss, vv = hsv[..., 0].astype(int), hsv[..., 1].astype(int), hsv[..., 2].astype(int)
    colmax = vv.max(axis=0)
    cols = np.where(colmax > 40)[0]
    x0, x1 = (int(cols[0]), int(cols[-1])) if len(cols) else (0, W - 1)
    blue = ((hh >= 95) & (hh <= 135) & (ss > 70) & (vv > 35)).astype(np.uint8) * 255
    blue[:, :x0] = 0
    blue[:, x1 + 1:] = 0
    blue = cv2.morphologyEx(blue, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    cnts, _ = cv2.findContours(blue, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    shot = {'a': a, 'b': b, 'overhead': False}
    if cnts:
        c = max(cnts, key=cv2.contourArea)[:, 0, :]
        keep = (c[:, 0] > x0 + 3) & (c[:, 0] < x1 - 3) & (c[:, 1] > 3) & (c[:, 1] < H - 4)
        pts = c[keep]
        if len(pts) > 40:
            (ex, ey), (ea, eb), ang = cv2.fitEllipse(pts.reshape(-1, 1, 2).astype(np.float32))
            major = max(ea, eb)
            cw = x1 - x0
            ok = (x0 < ex < x1) and (0 < ey < H) and major < 1.0 * cw and min(ea, eb) > 0.3 * H and min(ea, eb) / major > 0.7
            shot['ell'] = [ex, ey, ea, eb, ang]
            shot['overhead'] = bool(ok)
    if not shot['overhead']:
        res['shots'].append(shot)
        continue
    ex, ey, ea, eb, ang = shot['ell']
    R = (ea + eb) / 4  # 平均半径（像素）
    th = np.deg2rad(ang)
    inside = np.zeros((H, W), np.uint8)
    cv2.ellipse(inside, ((ex, ey), (ea * 0.97, eb * 0.97), ang), 255, -1)
    inside[int(H * 0.80):, :] = 0  # 字幕与进度条
    inside[: int(H * 0.06), :] = 0
    bgh = cv2.cvtColor(bg, cv2.COLOR_BGR2HSV).astype(np.int16)
    exp_area = np.pi * (0.133 * R) ** 2
    recs = []
    for k, fr in enumerate(frames):
        d = cv2.absdiff(cv2.GaussianBlur(fr, (3, 3), 0), cv2.GaussianBlur(bg, (3, 3), 0)).max(axis=2)
        fh = cv2.cvtColor(fr, cv2.COLOR_BGR2HSV).astype(np.int16)
        dh = np.abs(fh[..., 0] - bgh[..., 0])
        dh = np.minimum(dh, 180 - dh)
        ratio = (fh[..., 2] + 1) / (bgh[..., 2] + 1)
        shadow = (dh < 8) & (ratio > 0.3) & (ratio < 0.92) & (np.abs(fh[..., 1] - bgh[..., 1]) < 50)
        fg = ((d > 38) & ~shadow).astype(np.uint8) * 255
        fg &= inside
        fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
        n, lab, st, cen = cv2.connectedComponentsWithStats(fg)
        blobs = []
        for j in range(1, n):
            ar = st[j, cv2.CC_STAT_AREA]
            if ar < 0.3 * exp_area or ar > 3.0 * exp_area:
                continue
            ys, xs = np.where(lab == j)
            col = fr[ys, xs].reshape(-1, 1, 3)
            labc = cv2.cvtColor(col, cv2.COLOR_BGR2LAB).reshape(-1, 3).mean(axis=0)
            if ar > 1.55 * exp_area:
                Z = np.stack([xs, ys], 1).astype(np.float32)
                crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 0.5)
                _, lbl, ctr = cv2.kmeans(Z, 2, None, crit, 3, cv2.KMEANS_PP_CENTERS)
                for q in range(2):
                    sel = lbl[:, 0] == q
                    cq = fr[ys[sel], xs[sel]].reshape(-1, 1, 3)
                    lq = cv2.cvtColor(cq, cv2.COLOR_BGR2LAB).reshape(-1, 3).mean(axis=0)
                    blobs.append({'x': float(ctr[q, 0]), 'y': float(ctr[q, 1]), 'area': int(sel.sum()), 'merged': True, 'lab': [float(v) for v in lq]})
            else:
                blobs.append({'x': float(cen[j, 0]), 'y': float(cen[j, 1]), 'area': int(ar), 'merged': False, 'lab': [float(v) for v in labc]})
        blobs.sort(key=lambda z: -z['area'])
        blobs = blobs[:3]
        for z in blobs:
            dx, dy = z['x'] - ex, z['y'] - ey
            z['u'] = float((dx * np.cos(th) + dy * np.sin(th)) / (ea / 2))
            z['w'] = float((-dx * np.sin(th) + dy * np.cos(th)) / (eb / 2))
        recs.append({'i': a + k, 'blobs': blobs})
        if k % 20 == 0:
            vis = fr.copy()
            cv2.ellipse(vis, ((ex, ey), (ea, eb), ang), (0, 255, 255), 1)
            for z in blobs:
                cv2.circle(vis, (int(z['x']), int(z['y'])), int(0.133 * R), (0, 0, 255) if not z['merged'] else (255, 0, 255), 1)
            cv2.putText(vis, str(a + k), (5, 15), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 0), 1)
            cv2.imwrite(os.path.join(dbg, f'e_{a + k:05d}.jpg'), vis)
    shot['R'] = R
    shot['frames'] = recs
    res['shots'].append(shot)

json.dump(res, open(out, 'w'))
oh = [s for s in res['shots'] if s['overhead']]
nf = sum(s['b'] - s['a'] for s in oh)
n2 = sum(1 for s in oh for r in s['frames'] if len(r['blobs']) >= 2)
print(f'镜头 {len(res["shots"])}，俯视镜头 {len(oh)}（{nf} 帧，两台都检到 {n2} 帧）；切点 {cuts[1:-1]}')
