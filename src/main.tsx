import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './ui/styles.css';
import { DIAG } from './game/diag/flag';
import { installAudioProbe } from './game/diag/audioProbe';

// Stage 0 诊断构建：在游戏创建 AudioContext 之前装好音频计数探针（非诊断构建删除）
if (DIAG) installAudioProbe();

// iOS Safari：阻止双指缩放和双击放大，避免战斗中误触
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
