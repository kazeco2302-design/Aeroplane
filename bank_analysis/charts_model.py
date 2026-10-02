import json
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
plt.rcParams.update({'font.family':'DejaVu Sans','font.size':8.5})
C={'HSBK':'#2a78d6','KSPI':'#eb6834','CCBN':'#1baf7a','ASBN':'#eda100','FRHC':'#e87ba4'}
X=['2021','2022','2023','2024','2025','1П26*']
ROE={'HSBK':[30.2,31.8,30.9,33.2,32.2,25.1],'KSPI':[97.0,88.7,88.7,80.1,53.5,39.5],
     'CCBN':[14.6,28.7,39.0,38.3,36.1,27.1],'ASBN':[23.7,31.6,30.1,32.1,33.6,17.2],
     'FRHC':[52.7,30.8,38.6,6.4,11.3,8.4]}
fig,ax=plt.subplots(figsize=(7.2,3.0),dpi=200)
ax.axhspan(20,22,color='#d9d8d2',alpha=0.6,lw=0)
ax.text(5.55,17.5,'COE',va='center',fontsize=7.5,color='#52514e')
for t,v in ROE.items():
    ax.plot(range(6),v,color=C[t],lw=1.8,marker='o',ms=3.5,ls='--' if t=='FRHC' else '-',label=t if t!='FRHC' else 'FRHC (USD, FY до 31.03)')
ax.set_xticks(range(6)); ax.set_xticklabels(X); ax.set_ylim(0,100); ax.set_xlim(-0.2,6.1)
ax.set_ylabel('ROE, %',color='#52514e'); ax.grid(axis='y',color='#e6e5e0',lw=0.6)
for sp in ['top','right']: ax.spines[sp].set_visible(False)
for sp in ['left','bottom']: ax.spines[sp].set_color('#b5b4ad')
ax.legend(frameon=False,ncol=5,fontsize=7.2,loc='upper right')
ax.set_title('ROE акционеров против стоимости капитала в тенге (COE 20–22%)',fontsize=9,loc='left')
fig.tight_layout(); fig.savefig('out/fig_roe.png')

out=json.load(open('data/model_out.json'))
fig,ax=plt.subplots(figsize=(7.2,2.6),dpi=200)
T=['CCBN','HSBK','KSPI','ASBN','FRHC']
for i,t in enumerate(T):
    s=out[t]['scen']; b,m,u=[s[k]['irr_kzt']*100 for k in ('bear','base','bull')]
    ax.plot([b,u],[i,i],color='#b5b4ad',lw=2.2,solid_capstyle='round',zorder=1)
    ax.scatter([b,u],[i,i],s=26,color='#ffffff',edgecolor=C[t],lw=1.6,zorder=2)
    ax.scatter([m],[i],s=60,color=C[t],zorder=3)
    e=out[t]['exp_irr_kzt']*100
    ax.text(max(u,b)+2,i,f'базовый {m:.0f}%  ·  ожид. {e:.0f}%',va='center',fontsize=7.5,color='#0b0b0b')
ax.axvline(21,color='#52514e',lw=1,ls=':'); ax.text(21.8,-0.55,'COE 21%',fontsize=7.2,color='#52514e')
ax.axvline(0,color='#b5b4ad',lw=0.8)
ax.set_yticks(range(len(T))); ax.set_yticklabels(T); ax.invert_yaxis(); ax.set_xlim(-50,75)
ax.set_xlabel('Годовая доходность за 5 лет в тенге после налогов (IRR), %: медведь ○ — база ● — бык ○',color='#52514e')
for sp in ['top','right','left']: ax.spines[sp].set_visible(False)
ax.spines['bottom'].set_color('#b5b4ad'); ax.tick_params(axis='y',length=0); ax.grid(axis='x',color='#e6e5e0',lw=0.6)
fig.tight_layout(); fig.savefig('out/fig_irr.png'); print('ok')
