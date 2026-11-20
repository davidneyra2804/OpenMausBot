// A routine that already delivered its report and is then cut by its own run limit, in the disposable fixture: the run
// ends failed, with the report it had delivered still on its row and the limit's own words as its error.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";

const NAME = "Invoice watch";
const REPORT = "Facturado: la factura VYR-0042 salio y el correo de eFact ya llego.";
const LIMIT_MINUTES = 5;

const fixture = await launchVerificationServer({
  ...process.env,
  // The engine delivers its reply and keeps the turn open, so the routine's own limit is what ends the run.
  FAKE_CLAUDE_MODE: "background-result",
  FAKE_CLAUDE_REPLIES: JSON.stringify([[REPORT]]),
}, undefined, undefined, undefined, undefined, undefined);

const say = (line: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...line }));
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, {
    method, headers: { "content-type": "application/json", origin: fixture.info.url },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json() as any;
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(value)}`);
  return value;
};
const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
async function until<T>(check: () => T | Promise<T>, timeoutMs: number): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Fixture timed out; see ${fixture.info.logPath}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

let botId = "";
let routineId = "";
let runId = "";
try {
  say({ step: "fixture", ...fixture.info });
  const { bot } = await control(["new-bot", "--name", "Pepper"]);
  botId = bot.id;
  say({ step: "bot", botId });
  const created = await api("POST", "/api/routines", {
    name: NAME, prompt: "Check the invoices and tell me what needs me.", botId, enabled: false,
    schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    timeoutMinutes: LIMIT_MINUTES,
  });
  routineId = created.routine.id as string;
  say({ step: "routine", routineId, timeoutMinutes: LIMIT_MINUTES });
  const started = await api("POST", `/api/routines/${routineId}/run`, undefined);
  runId = started.run.id as string;
  say({ step: "run started", runId });
  const delivered = await until(async () => {
    const rows = (await api("GET", "/api/routines")).runs as any[];
    const current = rows.find((candidate) => candidate.id === runId);
    return current?.output ? current : null;
  }, 120_000);
  say({ step: "report delivered", status: delivered.status, output: delivered.output });
  const run = await until(async () => {
    const rows = (await api("GET", "/api/routines")).runs as any[];
    const current = rows.find((candidate) => candidate.id === runId);
    return current && ["failed", "completed", "cancelled", "missed"].includes(current.status) ? current : null;
  }, 480_000);
  say({ step: "run finished", status: run.status, partial: run.partial, error: run.error, output: run.output });
  const expected = `Stopped after reaching the ${LIMIT_MINUTES}-minute run limit`;
  const checks = {
    status: run.status === "failed",
    partial: run.partial === true,
    output: run.output === REPORT,
    error: run.error === expected,
  };
  say({ step: "checks", checks, expectedError: expected });
  const evidence = { fixture: fixture.info, botId, routineId, runId, expectedError: expected, report: REPORT, run, checks };
  const evidencePath = `${fixture.info.logPath}.routine-limits.json`;
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  try {
    mkdirSync("/mnt/files/evidence", { recursive: true });
    writeFileSync("/mnt/files/evidence/routine-limits.json", JSON.stringify(evidence, null, 2));
  } catch {}
  say({ step: "evidence written", evidencePath, copy: "/mnt/files/evidence/routine-limits.json" });
  if (!Object.values(checks).every(Boolean)) {
    console.error(JSON.stringify({ ok: false, failed: Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name), evidencePath }));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ok: true, evidencePath }));
  }
} finally {
  await fixture.close();
}
