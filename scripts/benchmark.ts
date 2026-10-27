/**
 * Engine throughput benchmark on synthetic per-read data (no database).
 *   npm run benchmark -- --rows 1000000
 * Streams a generated CSV through the parser, mapper, aggregator and
 * classifier, reporting time and peak memory. Results depend on hardware.
 */
import os from "node:os";
import { parseArgs } from "node:util";
import { buildExports, resolveProfile, runCsv, type ZoneRef } from "@/engine";
import { generateScans } from "./lib/synthetic";

const { values } = parseArgs({ options: { rows: { type: "string", default: "1000000" } } });
const target = Number(values.rows);
const zones: ZoneRef[] = [
  { id: "sf", code: "SALES_FLOOR", name: "Sales Floor", type: "SALES_FLOOR", aliases: ["SF"], sortOrder: 0 },
  { id: "br", code: "BACK_ROOM", name: "Back Room", type: "BACK_ROOM", aliases: ["BR"], sortOrder: 1 },
];

// ~8.4 per-read rows per item in this generator.
const items = Math.ceil(target / 8.4);
const { rows } = generateScans({ seed: 99, itemCount: items });

async function* csvChunks() {
  yield "EPC,Zone,Session ID,Timestamp,Peak RSSI\n";
  let buf = "";
  for (const r of rows) {
    buf += `${r.epc},${r.zone === "SALES_FLOOR" ? "SF" : "BR"},${r.session},${r.timestamp},${r.rssi}\n`;
    if (buf.length > 1 << 20) {
      yield buf;
      buf = "";
    }
  }
  if (buf) yield buf;
}

let peak = 0;
const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 50);
const t0 = performance.now();
const out = await runCsv({ profile: resolveProfile({}), zones, relationships: [], anchors: [] }, [
  {
    file: {
      uploadId: "bench",
      mapping: { epc: "EPC", zone: "Zone", session: "Session ID", timestamp: "Timestamp", rssi: "Peak RSSI" },
      fixedZoneId: null,
      sessionLabel: "B",
      zoneValueMap: {},
      dateFormat: "AUTO",
      timeZone: "UTC",
    },
    delimiter: ",",
    source: csvChunks(),
  },
]);
const t1 = performance.now();
const files = buildExports({
  jobId: "bench",
  storeId: "bench",
  profileVersion: "bench",
  zones,
  aggregation: out.aggregation,
  results: out.results,
  metrics: out.metrics,
  rowStats: out.rowStats,
  processingStatus: "COMPLETED",
  createdAt: 0,
  completedAt: 0,
});
const t2 = performance.now();
clearInterval(sampler);
peak = Math.max(peak, process.memoryUsage().rss);

console.log(
  JSON.stringify(
    {
      environment: {
        node: process.version,
        platform: `${os.platform()} ${os.arch()}`,
        cpu: os.cpus()[0]?.model,
        cores: os.cpus().length,
        memoryGb: Math.round(os.totalmem() / 2 ** 30),
      },
      rows: out.rowStats.inputRowCount,
      uniqueEpcs: out.metrics.uniqueEpcCount,
      parseAggregateClassifySeconds: +((t1 - t0) / 1000).toFixed(2),
      exportSeconds: +((t2 - t1) / 1000).toFixed(2),
      rowsPerSecond: Math.round(out.rowStats.inputRowCount / ((t1 - t0) / 1000)),
      peakRssMb: Math.round(peak / 2 ** 20),
      outputBytes: files.reduce((n, f) => n + f.content.length, 0),
      note: "Includes generating the synthetic input in memory; excludes database persistence.",
    },
    null,
    2,
  ),
);
