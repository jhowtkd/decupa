import json,sys
rows=[json.loads(l) for l in open(sys.argv[1])]
ok=[r for r in rows if sorted(r['outcomes'])==['built','hit-or-shared']]
hit=[r for r in rows if sorted(r['outcomes'])==['built','hit']]
other=[r for r in rows if r not in ok and r not in hit]
def order(r):
    e={x['event']+str(x.get('call','')):x['ms'] for x in r['trace']}
    hf=[x.get('hit') for x in r['trace'] if x['event']=='first-check-end' and x.get('call')==2][0]
    return e.get('proxy-published'),e.get('first-check-start2'),e.get('first-check-end2'),hf,e.get('release-build')
print('execucoes',len(rows),'hit-or-shared',len(ok),'hit',len(hit),'outros',len(other),'builds!=1',sum(r['builds']!=1 for r in rows),'resultado diferente',sum(not r['same'] for r in rows))
for nm,g in (('hit',hit),('hit-or-shared',ok)):
    if not g: continue
    o=[order(r) for r in g]
    print(nm,': check do seguidor valido',sum(1 for x in o if x[3]),'de',len(o),'| publicou antes do FIM do check',sum(1 for x in o if x[0]<x[2]),'| publicou antes do INICIO do check',sum(1 for x in o if x[0]<x[1]),'| liberou build antes do FIM do check',sum(1 for x in o if x[4]<x[2]))
    print(' exemplo',json.dumps(g[0]['trace']))
