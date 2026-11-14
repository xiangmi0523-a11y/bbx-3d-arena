# 独立复核（不同随机数、不同实现）：配对连续 Q4 的覆盖率，ρ = 0 / 0.8
import numpy as np, sys
L=[(20,0),(20,0),(19,0),(14,0),(20,0),(0,0),(19,0),(0,11),(19,0),(18,0),(19,0),(10,0),(18,0),(0,10),(10,0),(0,1)]
rng=np.random.default_rng(1)
def run(rho,N=300,B=1000):
  cov=0
  for k in range(N):
    g=[];v0=[];v1=[];lay=[]
    for h,(a,d) in enumerate(L):
      for i in range(20):
        gg='A' if i<a else 'D' if i<a+d else None
        g.append(gg); lay.append(h)
        if gg:
          z0=rng.standard_normal(); zp=rng.standard_normal(); z1=rho*z0+np.sqrt(1-rho*rho)*zp
          m0=0.12 if gg=='A' else 0.08; m1=0.15 if gg=='A' else 0.08
          v0.append(np.exp(np.log(m0)+0.5*z0)); v1.append(np.exp(np.log(m1)+0.5*z1))
        else: v0.append(np.nan); v1.append(np.nan)
    g=np.array(g,dtype=object); v0=np.array(v0); v1=np.array(v1); lay=np.array(lay)
    isA=(g=='A'); isD=(g=='D')
    idx_by=[np.where(lay==h)[0] for h in range(16)]
    st=[]
    for b in range(B):
      idx=np.concatenate([ix[rng.integers(0,20,20)] for ix in idx_by])
      A=idx[isA[idx]]; D=idx[isD[idx]]
      st.append((np.median(v1[A])-np.median(v1[D]))-(np.median(v0[A])-np.median(v0[D])))
    st=np.sort(st); lo=st[int(np.floor(0.025*(B-1)+0.5))]; hi=st[int(np.floor(0.975*(B-1)+0.5))]
    cov+= lo<=0.03<=hi
  return cov/N
for rho in [0,0.8]: print(rho, run(rho)); sys.stdout.flush()
