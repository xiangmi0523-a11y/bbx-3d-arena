/**
 * 最小 DOM / Canvas 桩：让 ImpactFX（画布生成的发光贴图）能在 Node 里构造和更新。
 * 只用于测试与诊断，不参与渲染。
 */
export function installDomStub(): void {
  const g = globalThis as unknown as { document?: unknown };
  if (g.document) return;
  const ctx2d = {
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }),
    fillRect() {},
    drawImage() {},
    globalCompositeOperation: 'source-over',
    fillStyle: '',
  };
  g.document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }),
  };
}
