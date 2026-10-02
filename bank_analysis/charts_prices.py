import json,datetime as dt
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
plt.rcParams.update({'font.family':'DejaVu Sans','font.size':8.5})
C={'HSBK':'#2a78d6','KSPI':'#eb6834','CCBN':'#1baf7a','ASBN':'#eda100','FRHC':'#e87ba4'}
def load(t):
    d=json.load(open(f'data/prices/{t}.json')); return {dt.datetime.utcfromtimestamp(x).date():c for x,c in zip(d['t'],d['c'])}
fx=load('USDKZT'); fxd=sorted(fx)
def fx_at(d):
    k=[x for x in fxd if x<=d]; return fx[k[-1]]
start=dt.date(2021,11,23)
fig,ax=plt.subplots(figsize=(7.2,3.3),dpi=200)
ends=[]
for t in C:
    s=load(t); ds=sorted(x for x in s if x>=start)
    vals=[s[d]*(fx_at(d) if t=='FRHC' else 1) for d in ds]
    base=vals[0]; y=[v/base*100 for v in vals]
    ax.plot(ds,y,color=C[t],lw=1.6,label=t+(' (в тенге)' if t=='FRHC' else ''))
    ends.append([y[-1],t,ds[-1]])
ends.sort()
last=1e-9
for v,t,d in ends:
    yy=max(v,last*1.14); last=yy
    ax.annotate(f'{t} {v:.0f}',(d,v),xytext=(d+dt.timedelta(days=25),yy),fontsize=7.5,color='#0b0b0b',va='center')
ax.set_yscale('log'); ax.set_yticks([50,100,200,400,800,1600]); ax.get_yaxis().set_major_formatter(matplotlib.ticker.ScalarFormatter())
ax.grid(axis='y',color='#e6e5e0',lw=0.6); 
for sp in ['top','right']: ax.spines[sp].set_visible(False)
for sp in ['left','bottom']: ax.spines[sp].set_color('#b5b4ad')
ax.set_xlim(start,dt.date(2027,3,1))
ax.set_ylabel('Индекс цены, 23.11.2021 = 100 (лог. шкала)',color='#52514e')
ax.legend(loc='upper left',frameon=False,ncol=5,fontsize=7.5)
ax.set_title('Цена акций на KASE, без дивидендов (FRHC пересчитан в тенге по USDKZT_TOM)',fontsize=9,loc='left',color='#0b0b0b')
fig.tight_layout(); fig.savefig('out/fig_prices.png'); print('ok')
