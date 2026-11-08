import * as THREE from 'three';
import { ARENA } from '../arena/arenaSpec';

/** 用 Canvas 程序化生成贴图（不依赖外部图片资源） */
function canvasTexture(
  size: number,
  draw: (ctx: CanvasRenderingContext2D, size: number) => void,
  /** 实际像素倍数：按 size 的逻辑坐标绘制，画布按 res 倍分辨率生成 */
  res = 1,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size * res;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(res, res);
  draw(ctx, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  // 场地是斜着看的，各向异性过滤决定远处纹理是否发糊（Three 会按 GPU 上限自动截断）
  tex.anisotropy = 16;
  return tex;
}

/** 场地地面贴图：深色底 + 六边形纹理 + 同心圆 + 放射线 + 外圈轨道色带 */
export function createFloorTexture(): THREE.CanvasTexture {
  return canvasTexture(1024, (ctx, S) => {
    const c = S / 2;
    const scale = c / (ARENA.radius + 0.25);
    const g = ctx.createRadialGradient(c, c, 0, c, c, c);
    g.addColorStop(0, '#1a2a4a');
    g.addColorStop(0.55, '#0f1a30');
    g.addColorStop(1, '#070c18');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);

    // 六边形网格
    ctx.strokeStyle = 'rgba(90,140,255,0.10)';
    ctx.lineWidth = 1.5;
    const hex = 26;
    const h = Math.sqrt(3) * hex;
    for (let y = -h; y < S + h; y += h) {
      for (let x = -hex * 3; x < S + hex * 3; x += hex * 3) {
        for (const [ox, oy] of [
          [0, 0],
          [hex * 1.5, h / 2],
        ]) {
          ctx.beginPath();
          for (let i = 0; i <= 6; i++) {
            const a = (i / 6) * Math.PI * 2;
            const px = x + ox + Math.cos(a) * hex;
            const py = y + oy + Math.sin(a) * hex;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
      }
    }

    // 放射线
    ctx.strokeStyle = 'rgba(120,180,255,0.18)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(a) * 0.7 * scale, c + Math.sin(a) * 0.7 * scale);
      ctx.lineTo(c + Math.cos(a) * ARENA.railInner * scale, c + Math.sin(a) * ARENA.railInner * scale);
      ctx.stroke();
    }

    // 同心圆
    for (const [r, alpha, w] of [
      [0.6, 0.9, 5],
      [1.6, 0.35, 3],
      [2.7, 0.35, 3],
      [ARENA.railInner, 0.9, 6],
    ] as const) {
      ctx.strokeStyle = `rgba(80,200,255,${alpha})`;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.arc(c, c, r * scale, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 中心徽记：原创的三角星形
    ctx.save();
    ctx.translate(c, c);
    ctx.fillStyle = 'rgba(255,90,60,0.85)';
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
      const r = (i % 2 === 0 ? 0.48 : 0.2) * scale;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,220,120,0.9)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();

    // 外圈极限轨道色带
    const rg = ctx.createRadialGradient(c, c, ARENA.railInner * scale, c, c, ARENA.radius * scale);
    rg.addColorStop(0, 'rgba(255,120,30,0.0)');
    rg.addColorStop(0.15, 'rgba(255,120,30,0.35)');
    rg.addColorStop(1, 'rgba(255,60,30,0.15)');
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(c, c, ARENA.radius * scale + 6, 0, Math.PI * 2);
    ctx.arc(c, c, ARENA.railInner * scale, 0, Math.PI * 2, true);
    ctx.fill();
  }, 2);
}

/** 旋转残影贴图：径向条纹 + 透明渐变 */
export function createSpinBlurTexture(color: number): THREE.CanvasTexture {
  const col = new THREE.Color(color);
  const rgb = `${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)}`;
  return canvasTexture(256, (ctx, S) => {
    const c = S / 2;
    const g = ctx.createRadialGradient(c, c, S * 0.1, c, c, c);
    g.addColorStop(0, `rgba(${rgb},0)`);
    g.addColorStop(0.55, `rgba(${rgb},0.35)`);
    g.addColorStop(0.92, `rgba(255,255,255,0.55)`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(c, c, c, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2;
      ctx.strokeStyle = `rgba(0,0,0,${i % 2 ? 0.25 : 0.05})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(c, c, c * (0.5 + (i % 5) * 0.09), a, a + 0.6);
      ctx.stroke();
    }
  });
}

/**
 * 「疾风新月」中心徽标（原创图形）：黑底 + 蓝色外环，中间是三道旋转前掠的风刃新月和一颗四角星。
 * 参考图的徽标位置是黑底圆形图案，这里只沿用“黑底圆徽 + 蓝白配色”的形式，图案不使用参考图里的龙头。
 */
export function createGaleEmblemTexture(): THREE.CanvasTexture {
  return canvasTexture(256, (ctx, S) => {
    const c = S / 2;
    // 黑底（中心略亮，有立体感）
    const bg = ctx.createRadialGradient(c, c * 0.85, 0, c, c, c);
    bg.addColorStop(0, '#16203a');
    bg.addColorStop(0.75, '#070a12');
    bg.addColorStop(1, '#020306');
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(c, c, c, 0, Math.PI * 2);
    ctx.fill();
    // 蓝色外环 + 内细白环
    ctx.lineWidth = S * 0.045;
    ctx.strokeStyle = '#1f6bff';
    ctx.beginPath();
    ctx.arc(c, c, c * 0.93, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = S * 0.008;
    ctx.strokeStyle = 'rgba(220,235,255,0.7)';
    ctx.beginPath();
    ctx.arc(c, c, c * 0.84, 0, Math.PI * 2);
    ctx.stroke();

    ctx.save();
    ctx.translate(c, c);
    const k = c * 0.72;
    // 三道风刃新月：每道是两条圆弧围成的弯月，绕中心 120° 旋转排布
    for (let i = 0; i < 3; i++) {
      ctx.save();
      ctx.rotate((i / 3) * Math.PI * 2 - 0.35);
      const grad = ctx.createLinearGradient(0, -k, 0, -k * 0.2);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.35, '#7fb4ff');
      grad.addColorStop(1, '#1240c8');
      ctx.fillStyle = grad;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = S * 0.012;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(-k * 0.12, -k * 0.22);
      ctx.quadraticCurveTo(-k * 0.05, -k * 0.95, k * 0.62, -k * 0.86);
      ctx.quadraticCurveTo(k * 0.18, -k * 0.62, k * 0.16, -k * 0.2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    // 中心四角星
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
      const r = (i % 2 === 0 ? 0.26 : 0.08) * k;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }, 2);
}
