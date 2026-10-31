import json,sys,collections
rows=[json.loads(l) for l in open(sys.argv[1])]
c=collections.Counter(','.join(r['outcomes']) for r in rows)
bad=sum(1 for r in rows if r['outcomes']!=['built','hit-or-shared'] or r['builds']!=1 or not r['same'])
print(f'RESUMO execucoes={len(rows)} falhas={bad} builds!=1={sum(r["builds"]!=1 for r in rows)} resultado_diferente={sum(not r["same"] for r in rows)} {dict(c)}')
