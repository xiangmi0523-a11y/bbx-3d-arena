import json,statistics as st
import sys
SP=None
ref={r['name']:r['baselineHash'] for r in json.load(open(sys.argv[1] if len(sys.argv)>1 else 'research/adaptive-roll/stageA-hashes.json'))['rows']}
A={r['name']:r for r in json.load(open('research/adaptive-roll/scale1.json'))['runs']}
B={r['name']:r for r in json.load(open('research/adaptive-roll/scale0.5.json'))['runs']}
print('scale1 vs StageA',sum(ref[n]==r['hash'] for n,r in A.items()),'/',len(A))
non=[n for n in B if not B[n]['nn']]; tgt=[n for n in B if B[n]['nn']]
print('V1 non-target vs StageA',sum(ref[n]==B[n]['hash'] for n in non),'/',len(non),' target differ',sum(ref[n]!=B[n]['hash'] for n in tgt),'/',len(tgt))
for nm,D in (('stageA',A),('V1',B)):
  rs=list(D.values())
  print(nm,'rollChecked',sum(r['rollChecked'] for r in rs),'mismatch',sum(r['rollMismatch'] for r in rs),'scaledNotConf',sum(r['scaledWhileNotConfirmed'] for r in rs),'scaledLowSpin',sum(r['scaledWhileLowSpin'] for r in rs),'scaledSteps',sum(r['scaledSteps'] for r in rs),'gateEntriesNonNN',sum(r['gate']['entries'] for r in rs if not r['nn']))
def q(a,p):
  a=sorted(a);i=(len(a)-1)*p;lo=int(i);return a[lo]+(a[min(len(a)-1,lo+1)]-a[lo])*(i-lo)
for nm,D in (('stageA',A),('V1',B)):
  T=[D[n] for n in tgt]
  per=[x for r in T for x in r['motion']['per']]
  net=[x['net'] for x in per]
  esc=sum(1 for r in T if r['segments'][0]['exit'] not in ('spinRatio','matchEnd','timeout') )
  exits={}
  for r in T: exits[r['segments'][0]['exit']]=exits.get(r['segments'][0]['exit'],0)+1
  rec=[r['motion']['recontact'] for r in T]
  segd=[(r['segments'][0]['end']-r['segments'][0]['start'])/120 for r in T]
  print(f"{nm}: net10 P50 {q(net,.5):.3f} P90 {q(net,.9):.3f}; straight P50 {q([x['straight'] for x in per],.5):.3f}; path P50 {q([x['path'] for x in per],.5):.3f}; low10 {st.mean(x['lowShare'] for x in per):.3f}; lowAfter {st.mean(r['motion']['lowShareAfter'] for r in T):.3f}; escape {esc}/24 exits {exits}; recontact {sum(x>=0 for x in rec)}/24 within10s {sum(0<=x<=10 for x in rec)} P50 {q([x for x in rec if x>=0],.5) if any(x>=0 for x in rec) else None}")
  print(f"   segDur P50 {q(segd,.5):.1f}; spinSlope {st.mean(x['spinSlope'] for x in per):.3f}; spinLoss10 {st.mean(x['spinLoss'] for x in per):.3f}; maxSpeed10 P50 {q([x['maxSpeed'] for x in per],.5):.3f} max {max(x['maxSpeed'] for x in per):.3f}; maxTilt {max(r['motion']['maxTiltAfter'] for r in T):.3f}; wallAccel {sum(r['motion']['wallAccelSteps'] for r in T)}; maxWallSpeed {max(r['motion']['maxWallSpeedAfter'] for r in T):.2f}; jump {max(r['motion']['maxSpeedJumpNoContact'] for r in T):.3f}; results {dict((k,sum(1 for r in T if r['result']==k)) for k in set(r['result'] for r in T))}; dur P50 {q([r['duration'] for r in T],.5):.1f}; entries {sum(r['gate']['entries'] for r in T)}; hits {sum(r['hits'] for r in T)}")
print('s0 same',all(A[n]['motion']['s0']==B[n]['motion']['s0'] for n in tgt))
for n in tgt: print(' ',n,A[n]['segments'][0]['exit'],'->',[ (round((s['end']-s['start'])/120,1),s['exit']) for s in B[n]['segments']], 'rec',A[n]['motion']['recontact'],B[n]['motion']['recontact'], 'net',[round(x['net'],2) for x in B[n]['motion']['per']])
