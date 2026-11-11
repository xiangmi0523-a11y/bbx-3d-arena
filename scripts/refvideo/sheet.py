import cv2, os, sys, numpy as np
src, out, a, b, s = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
per = int(sys.argv[6]) if len(sys.argv) > 6 else 5
tw = int(sys.argv[7]) if len(sys.argv) > 7 else 400
fs = sorted(os.listdir(src))
imgs = []
for i in range(a, min(b, len(fs)), s):
    im = cv2.imread(os.path.join(src, fs[i]))
    col = im.max(axis=2).max(axis=0); c = np.where(col > 40)[0]
    im = im[:, c[0]:c[-1] + 1]
    im = cv2.resize(im, (tw, int(im.shape[0] * tw / im.shape[1])))
    cv2.putText(im, f'{i} ({i/15:.2f}s)', (5, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 0), 2)
    imgs.append(im)
hh = max(x.shape[0] for x in imgs)
imgs = [cv2.copyMakeBorder(x, 0, hh - x.shape[0], 0, 0, cv2.BORDER_CONSTANT) for x in imgs]
while len(imgs) % per: imgs.append(np.zeros_like(imgs[0]))
sheet = np.vstack([np.hstack(imgs[i:i + per]) for i in range(0, len(imgs), per)])
cv2.imwrite(out, sheet, [cv2.IMWRITE_JPEG_QUALITY, 85])
print(out, sheet.shape)
