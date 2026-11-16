import autocannon from "autocannon"; import { execSync } from "node:child_process";
const [conc, dur, ...paths] = process.argv.slice(2); const BASE = "http://localhost:3400";
const sample = () => { try { const out = execSync("ps -eo pid,rss,pcpu,args | grep -E 'next-server|next start' | grep -v grep | head -1").toString().trim().split(/\s+/); return { rssMB: Math.round(out[1] / 1024), cpu: parseFloat(out[2]) }; } catch { return { rssMB: 0, cpu: 0 }; } };
const dbConns = () => { try { return Number(execSync(`su postgres -c "psql -h /tmp -p 5544 -d gp_e2e -At -c \\"select count(*) from pg_stat_activity where datname='gp_e2e'\\""`).toString().trim()); } catch { return -1; } };
console.log(`LOAD profile: ${conc} concurrent connections, ${dur}s per endpoint, HTTP GET, keep-alive, same host as server`);
console.log("endpoint".padEnd(26) + "req/s".padStart(8) + "avg ms".padStart(8) + "p50".padStart(7) + "p97.5".padStart(7) + "p99".padStart(7) + "max".padStart(7) + "  total  non2xx  errors  srvRSS  srvCPU%  dbConns");
for (const p of paths) {
  let peak = { rssMB: 0, cpu: 0 }, maxDb = 0; const t = setInterval(() => { const s = sample(); peak.rssMB = Math.max(peak.rssMB, s.rssMB); peak.cpu = Math.max(peak.cpu, s.cpu); maxDb = Math.max(maxDb, dbConns()); }, 1500);
  const r = await autocannon({ url: BASE + p, connections: Number(conc), duration: Number(dur), timeout: 30 }); clearInterval(t);
  const L = r.latency; console.log(p.padEnd(26) + String(Math.round(r.requests.average)).padStart(8) + String(L.average.toFixed(0)).padStart(8) + String(L.p50).padStart(7) + String(L.p97_5).padStart(7) + String(L.p99).padStart(7) + String(L.max).padStart(7) + String(r.requests.total).padStart(7) + String(r.non2xx).padStart(7) + String(r.errors + r.timeouts).padStart(8) + (peak.rssMB + "MB").padStart(8) + String(peak.cpu).padStart(9) + String(maxDb).padStart(9));
}
process.exit(0);
