import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'vitest';
import { createArenaPhysics } from '../../src/game/arena/ArenaPhysics';
import { BattleSystem } from '../../src/game/battle/BattleSystem';
import type { BeyPhysics } from '../../src/game/beys/BeyPhysics';
import { assembleBey } from '../../src/game/beys/parts/assemble';
import { PLAYER_LOADOUT, RIVAL_LOADOUT } from '../../src/game/beys/parts/catalog';
import type { BeyLoadout } from '../../src/game/beys/parts/types';
import { rivalCommand } from '../../src/game/launcher/launch';
import { loadRapier, PhysicsWorld, PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';
import { seeded } from '../feelSim';

/**
 * 接触链路诊断（只读，不改物理）：逐步读取 Rapier 两台陀螺之间的接触流形，
 * 把连续接触（间隙 ≤ 2 步合并）切成“接触段”，统计每段时长、撞击结算次数、撞击事件、
 * 法向力和接触面滑动速度。用于回答：持续接触期间是否只有开头一次反馈。
 *   npx vitest run --config vitest.diag.config.ts tests/diag/contact.diag.ts
 */
const MATCHUPS: Record<string, { player: BeyLoadout; rival: BeyLoadout }> = {
  默认: { player: PLAYER_LOADOUT, rival: RIVAL_LOADOUT },
  平衡套装: { player: { blade: 'gale-crescent', ratchet: 'hex-lock', bit: 'dome-ball' }, rival: RIVAL_LOADOUT },
  攻击对防御: {
    player: { blade: 'blaze-fang', ratchet: 'tri-lock', bit: 'rush-rubber' },
    rival: { blade: 'tidal-bastion', ratchet: 'ring-guard', bit: 'dome-ball' },
  },
  同攻击: { player: PLAYER_LOADOUT, rival: { blade: 'blaze-fang', ratchet: 'tri-lock', bit: 'rush-rubber' } },
};

interface Seg {
  t0: number;
  steps: number;
  touchSteps: number;
  smash: number;
  events: string[];
  forceMax: number;
  forceSum: number;
  slideSum: number;
  approachMax: number;
}

function slideOf(a: BeyPhysics, b: BeyPhysics) {
  const pa = a.body.translation();
  const pb = b.body.translation();
  let nx = pb.x - pa.x;
  let nz = pb.z - pa.z;
  const len = Math.hypot(nx, nz) || 1;
  nx /= len;
  nz /= len;
  const va = a.body.linvel();
  const vb = b.body.linvel();
  const ra = Math.min(a.spec.outerRadius, len / 2);
  const rb = Math.min(b.spec.outerRadius, len / 2);
  const wa = a.spinDirection * a.spin;
  const wb = b.spinDirection * b.spin;
  const ux = va.x + wa * ra * nz - (vb.x - wb * rb * nz);
  const uz = va.z - wa * ra * nx - (vb.z + wb * rb * nx);
  const un = ux * nx + uz * nz;
  return { slide: Math.hypot(ux - un * nx, uz - un * nz), closing: -un };
}

test('contact episodes', async () => {
  const N = Number(process.env.DIAG_N ?? 6);
  const R = await loadRapier();
  const lines: string[] = ['# 接触段诊断', ''];
  const all: Record<string, unknown> = {};
  for (const [name, lo] of Object.entries(MATCHUPS)) {
    const segs: Seg[] = [];
    let totalTime = 0;
    let contactTime = 0;
    let contactNoFeedback = 0;
    let nearTime = 0;
    let visOverlap = 0;
    const holdCover: Record<string, number> = { '0.08': 0, '0.12': 0, '0.2': 0 };
    let nearNoFb = 0;
    const forces: number[] = [];
    const slides: number[] = [];
    for (let i = 0; i < N; i++) {
      const orig = Math.random;
      Math.random = seeded(1000 + i);
      const pw = new PhysicsWorld(R);
      createArenaPhysics(pw);
      const battle = new BattleSystem(pw, { player: assembleBey(lo.player), rival: assembleBey(lo.rival) });
      pw.beforeStep = (dt) => battle.preStep(dt);
      pw.afterStep = (dt) => battle.postStep(dt);
      const rnd = Math.random;
      battle.launch('player', { power: 0.6 + rnd() * 0.35, aim: (rnd() - 0.5) * 0.8, tilt: 0 });
      battle.launch('rival', rivalCommand(rnd));
      const A = battle.beys.player!;
      const B = battle.beys.rival!;
      let cur: Seg | null = null;
      let gap = 0;
      let lastFeedback = -1;
      let lastTouchT = -9;
      for (let s = 0; s < 60 / PHYSICS_DT && !battle.result; s++) {
        const h0 = battle.hits + battle.grinds;
        const e0 = battle.impacts.length;
        pw.step();
        totalTime += PHYSICS_DT;
        {
          const pa = A.body.translation();
          const pb = B.body.translation();
          const d = Math.hypot(pa.x - pb.x, pa.z - pb.z) - A.spec.outerRadius - B.spec.outerRadius;
          if (d < 0.08) nearTime += PHYSICS_DT;
          if (d < 0.035) visOverlap += PHYSICS_DT;
          if (d < 0.08 && battle.time - lastFeedback > 0.15) nearNoFb += PHYSICS_DT;
        }
        let imp = 0;
        let touch = false;
        for (const ca of A.colliders)
          for (const cb of B.colliders)
            pw.world.contactPair(ca, cb, (m) => {
              for (let k = 0, n = m.numContacts(); k < n; k++) {
                const ci = m.contactImpulse(k);
                imp += ci;
                if (ci > 0 || m.contactDist(k) <= 0.002) touch = true;
              }
            });
        const smash = battle.hits + battle.grinds - h0;
        const evs = battle.impacts.slice(e0).map((e) => e.tier);
        if (evs.length) lastFeedback = battle.time;
        if (touch) lastTouchT = battle.time;
        for (const h of Object.keys(holdCover)) if (battle.time - lastTouchT <= Number(h)) holdCover[h] += PHYSICS_DT;
        if (touch) {
          contactTime += PHYSICS_DT;
          if (battle.time - lastFeedback > 0.15) contactNoFeedback += PHYSICS_DT;
          const f = imp / PHYSICS_DT;
          const { slide, closing } = slideOf(A, B);
          forces.push(f);
          slides.push(slide);
          if (!cur) cur = { t0: battle.time, steps: 0, touchSteps: 0, smash: 0, events: [], forceMax: 0, forceSum: 0, slideSum: 0, approachMax: 0 };
          cur.touchSteps++;
          cur.forceMax = Math.max(cur.forceMax, f);
          cur.forceSum += f;
          cur.slideSum += slide;
          cur.approachMax = Math.max(cur.approachMax, closing);
          gap = 0;
        } else if (cur) gap++;
        if (cur) {
          cur.steps++;
          cur.smash += smash;
          cur.events.push(...evs);
          if (gap > 2) {
            segs.push(cur);
            cur = null;
          }
        }
      }
      if (cur) segs.push(cur);
      pw.dispose();
      Math.random = orig;
    }
    const dur = segs.map((s) => s.touchSteps * PHYSICS_DT).sort((a, b) => a - b);
    const q = (arr: number[], k: number) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * k))] : NaN);
    const long = segs.filter((s) => s.touchSteps * PHYSICS_DT >= 0.15);
    const longTime = long.reduce((s, x) => s + x.touchSteps * PHYSICS_DT, 0);
    const longEvents = long.reduce((s, x) => s + x.events.length, 0);
    const multiStrong = segs.filter((s) => s.events.filter((e) => e !== 'light').length > 1).length;
    // 交锋回合：间隔 < 0.35 s 的接触段合并（追击 → 擦碰 → 拉开 → 再贴上）
    const bouts: { t0: number; t1: number; segs: number; touch: number; events: string[] }[] = [];
    for (const sg of segs) {
      const end = sg.t0 + sg.steps * PHYSICS_DT;
      const lb = bouts[bouts.length - 1];
      if (lb && sg.t0 - lb.t1 < 0.35 && sg.t0 > lb.t0) {
        lb.t1 = end;
        lb.segs++;
        lb.touch += sg.touchSteps * PHYSICS_DT;
        lb.events.push(...sg.events);
      } else bouts.push({ t0: sg.t0, t1: end, segs: 1, touch: sg.touchSteps * PHYSICS_DT, events: [...sg.events] });
    }
    const multi = bouts.filter((b) => b.segs >= 3);
    const boutRow = {
      bouts: bouts.length,
      boutsWith3PlusSegs: multi.length,
      multiBoutMeanSpan: multi.reduce((s, b) => s + b.t1 - b.t0, 0) / Math.max(1, multi.length),
      multiBoutMeanSegs: multi.reduce((s, b) => s + b.segs, 0) / Math.max(1, multi.length),
      multiBoutEventsPerSeg: multi.reduce((s, b) => s + b.events.length, 0) / Math.max(1, multi.reduce((s, b) => s + b.segs, 0)),
      segsInMultiBoutShare: multi.reduce((s, b) => s + b.segs, 0) / Math.max(1, segs.length),
      topBouts: [...bouts].sort((a, b) => b.segs - a.segs).slice(0, 4).map((b) => ({ t0: +b.t0.toFixed(2), span: +(b.t1 - b.t0).toFixed(2), segs: b.segs, touch: +b.touch.toFixed(2), events: b.events.join(',') })),
    };
    const sf = [...forces].sort((a, b) => a - b);
    const ss = [...slides].sort((a, b) => a - b);
    const row = {
      ...boutRow,
      nearFrac: nearTime / totalTime,
      visOverlapFrac: visOverlap / totalTime,
      holdCoverFrac: Object.fromEntries(Object.entries(holdCover).map(([k, v]) => [k, +(v / totalTime).toFixed(4)])),
      nearNoFeedbackFrac: nearNoFb / Math.max(1e-9, nearTime),
      totalTime,
      segments: segs.length,
      contactFrac: contactTime / totalTime,
      contactNoFeedbackFrac: contactNoFeedback / Math.max(1e-9, contactTime),
      durP50: q(dur, 0.5),
      durP90: q(dur, 0.9),
      durMax: q(dur, 1),
      longSegments: long.length,
      longSegShareOfContact: longTime / Math.max(1e-9, contactTime),
      eventsPerLongSecond: longEvents / Math.max(1e-9, longTime),
      segmentsWithMultipleStrong: multiStrong,
      smashPerSegP50: q(segs.map((s) => s.smash).sort((a, b) => a - b), 0.5),
      smashPerSegMax: q(segs.map((s) => s.smash).sort((a, b) => a - b), 1),
      forceP10: q(sf, 0.1), forceP50: q(sf, 0.5), forceP90: q(sf, 0.9), forceP99: q(sf, 0.99),
      slideP10: q(ss, 0.1), slideP50: q(ss, 0.5), slideP90: q(ss, 0.9),
      longest: long.sort((a, b) => b.touchSteps - a.touchSteps).slice(0, 3).map((s) => ({ t0: +s.t0.toFixed(2), dur: +(s.touchSteps * PHYSICS_DT).toFixed(2), smash: s.smash, events: s.events.join(','), fMean: +(s.forceSum / s.touchSteps).toFixed(1), slideMean: +(s.slideSum / s.touchSteps).toFixed(1) })),
    };
    all[name] = row;
    lines.push(`## ${name}`, '```json', JSON.stringify(row, null, 1), '```', '');
  }
  mkdirSync('test-results/diag', { recursive: true });
  writeFileSync('test-results/diag/contact.md', lines.join('\n'));
  console.log(lines.join('\n'));
});
