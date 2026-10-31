s/^import \{ copyFile, mkdtemp,/import { appendFileSync } from "node:fs";\nimport { copyFile, mkdtemp,/;
s/while building the proxy once", async \(\) => \{/while building the proxy once", { repeats: 150 }, async () => {/;
s/^  expect\(results\[1\]\)\.toEqual\(results\[0\]\);$/  appendFileSync(process.env.AB_TRACE!, JSON.stringify({ outcomes: events.map(event => event.outcome).sort(), builds: proxyBuilds, same: JSON.stringify(results[0]) === JSON.stringify(results[1]) }) + "\\n");\n  expect(results[1]).toEqual(results[0]);/;
