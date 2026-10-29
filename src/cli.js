import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { startCollector } from "./collector.js";
import { collectMetrics, cpuPercentBetween, cpuTimes } from "./metrics.js";
import { databasePath, dataDirectory, runFilePath } from "./paths.js";
import { openStore, sampleFromRow } from "./store.js";

const entryPath = fileURLToPath(new URL("../bin/hwatch.js", import.meta.url));
const packageInfo = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const useColor = Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
const color = (code, value) =>
  useColor ? `\u001b[${code}m${value}\u001b[0m` : value;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unavailable";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString();
}

function formatDuration(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatPercent(value) {
  return value === null || value === undefined ? "n/a" : `${value.toFixed(1)}%`;
}

function parseDuration(value) {
  const match = /^(\d+)(s|m|h|d)$/.exec(value);
  if (!match)
    throw new Error(
      `Invalid duration "${value}". Use a value like 30m, 2h, or 1d.`,
    );
  const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[match[2]];
  return Number(match[1]) * multiplier;
}

function readRunRecord() {
  try {
    return JSON.parse(fs.readFileSync(runFilePath, "utf8"));
  } catch {
    return null;
  }
}

function writeRunRecord(record) {
  const temporaryPath = `${runFilePath}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(temporaryPath, runFilePath);
}

function processCommand(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    timeout: 2000,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function collectorState(record = readRunRecord()) {
  if (!record) return { state: "stopped", record: null };
  if (!record.pid) {
    if (Date.now() - record.startedAt < 10_000)
      return { state: "starting", record };
    return { state: "stale", record };
  }

  try {
    process.kill(record.pid, 0);
  } catch {
    return { state: "stale", record };
  }

  const command = processCommand(record.pid);
  if (
    !command.includes("_collector") &&
    !command.includes("hwatch-collector")
  ) {
    return { state: "stale", record };
  }
  return { state: "running", record };
}

function removeRunRecord(token) {
  const current = readRunRecord();
  if (!current || (token && current.token !== token)) return;
  try {
    fs.unlinkSync(runFilePath);
  } catch {
    // Ignore a concurrent stop or cleanup.
  }
}

function parseInterval(args, flag, fallback) {
  const index = args.indexOf(flag);
  if (index === -1) return fallback;
  const seconds = Number(args[index + 1]);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600) {
    throw new Error(`${flag} must be between 1 and 3600 seconds.`);
  }
  return seconds;
}

function showHelp() {
  console.log(`HWatch — a small hardware and system monitor

Usage:
  hwatch start [--interval seconds]  Start background sampling (default: 5s)
  hwatch stop                        Stop background sampling
  hwatch status [--watch]            Show current system status
  hwatch history [--since duration]  Show saved samples (default: 1h)
  hwatch version                     Show the installed version
  hwatch help                        Show this help

Examples:
  hwatch start --interval 10
  hwatch status --watch
  hwatch history --since 6h

Samples are stored in ${databasePath}
`);
}

async function startCommand(args) {
  const intervalSeconds = parseInterval(args, "--interval", 5);
  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const store = openStore();
  store.close();

  const current = collectorState();
  if (current.state === "running" || current.state === "starting") {
    console.log(
      `HWatch is already ${current.state}${current.record.pid ? ` (PID ${current.record.pid})` : ""}.`,
    );
    return;
  }
  if (current.state === "stale") removeRunRecord();

  const token = randomUUID();
  const record = { pid: null, token, startedAt: Date.now(), intervalSeconds };
  try {
    fs.writeFileSync(runFilePath, JSON.stringify(record), {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (error.code === "EEXIST") {
      const raced = collectorState();
      if (raced.state === "running" || raced.state === "starting") {
        console.log(`HWatch is already ${raced.state}.`);
        return;
      }
      removeRunRecord();
      fs.writeFileSync(runFilePath, JSON.stringify(record), {
        mode: 0o600,
        flag: "wx",
      });
    } else {
      throw error;
    }
  }

  let child;
  try {
    child = spawn(
      process.execPath,
      [entryPath, "_collector", token, String(intervalSeconds * 1000)],
      {
        detached: true,
        stdio: "ignore",
        env: process.env,
      },
    );
    if (!child.pid)
      throw new Error("Node did not return a collector process ID.");
    record.pid = child.pid;
    writeRunRecord(record);
    child.unref();
  } catch (error) {
    removeRunRecord(token);
    throw error;
  }

  console.log(
    `HWatch started (PID ${child.pid}); sampling every ${intervalSeconds}s.`,
  );
  console.log(`Data is stored in ${databasePath}`);
}

function stopCommand() {
  const current = collectorState();
  if (current.state === "stopped") {
    console.log("HWatch is not running.");
    return;
  }
  if (current.state === "starting") {
    removeRunRecord(current.record.token);
    console.log("HWatch startup was cancelled.");
    return;
  }
  if (current.state === "stale") {
    removeRunRecord(current.record.token);
    console.log("Removed a stale HWatch collector record.");
    return;
  }

  try {
    process.kill(current.record.pid, "SIGTERM");
    console.log(`Stopping HWatch (PID ${current.record.pid})`);
  } catch (error) {
    if (error.code === "ESRCH") {
      removeRunRecord(current.record.token);
      console.log("HWatch is not running.");
      return;
    }
    throw error;
  }
}

async function liveMetrics() {
  const initialTimes = cpuTimes();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const latestTimes = cpuTimes();
  return collectMetrics(cpuPercentBetween(initialTimes, latestTimes));
}

function renderStatus(metrics, state, latestSample) {
  const tracker =
    state.state === "running"
      ? color(
          "32",
          `running · PID ${state.record.pid} · every ${state.record.intervalSeconds}s`,
        )
      : state.state === "starting"
        ? color("33", "starting")
        : color("90", "stopped");

  const lines = [
    color("1", `HWatch · ${metrics.hostname}`),
    `${metrics.platform} ${metrics.architecture} · uptime ${formatDuration(metrics.uptimeSeconds)}`,
    `Tracker   ${tracker}`,
    `CPU       ${formatPercent(metrics.cpuPercent)} · ${metrics.cpuCores} cores · ${metrics.cpuModel}`,
    `Memory    ${formatBytes(metrics.memoryUsed)} / ${formatBytes(metrics.memoryTotal)} (${metrics.memoryPercent.toFixed(1)}%)`,
    `Load      ${metrics.load1.toFixed(2)} / ${metrics.load5.toFixed(2)} / ${metrics.load15.toFixed(2)} (1 / 5 / 15 min)`,
    `Processes ${metrics.processCount ?? "unavailable"}`,
    `Saved     ${latestSample ? formatDate(latestSample.capturedAt) : "no samples yet"}`,
    "",
    color("1", "Temperatures"),
  ];

  if (metrics.temperatures.length) {
    for (const reading of metrics.temperatures) {
      lines.push(`  ${reading.name}: ${reading.celsius.toFixed(1)}°C`);
    }
  } else {
    lines.push("  No temperature sensors exposed by this system.");
  }

  lines.push("", color("1", "Top processes (by CPU)"));
  if (metrics.topProcesses.length) {
    for (const process of metrics.topProcesses.slice(0, 5)) {
      const name =
        process.name.length > 34 ? process.name.slice(0, 34) : process.name;
      lines.push(
        `  ${String(process.pid).padStart(6)}  ${process.cpuPercent.toFixed(1).padStart(5)}% CPU  ${process.memoryPercent.toFixed(1).padStart(5)}% MEM  ${name}`,
      );
    }
  } else {
    lines.push("  Process details unavailable.");
  }

  lines.push("", color("90", `Database: ${databasePath}`));
  return lines.join("\n");
}

async function statusCommand(args) {
  const watch = args.includes("--watch") || args.includes("-w");
  const refreshSeconds = parseInterval(args, "--interval", 2);

  const draw = async () => {
    const [metrics, store] = await Promise.all([
      liveMetrics(),
      Promise.resolve(openStore()),
    ]);
    const latestSample = sampleFromRow(store.latest());
    store.close();
    const state = collectorState();
    if (process.stdout.isTTY && watch)
      process.stdout.write("\u001b[2J\u001b[H");
    console.log(renderStatus(metrics, state, latestSample));
    if (watch)
      console.log(
        color("90", `Refreshing every ${refreshSeconds}s · Ctrl+C to exit`),
      );
  };

  await draw();
  if (!watch) return;
  const timer = setInterval(() => {
    draw().catch((error) => {
      console.error(`Could not refresh status: ${error.message}`);
    });
  }, refreshSeconds * 1000);
  process.on("SIGINT", () => {
    clearInterval(timer);
    process.exit(0);
  });
}

async function historyCommand(args) {
  const sinceIndex = args.indexOf("--since");
  const limitIndex = args.indexOf("--limit");
  const sinceSeconds =
    sinceIndex === -1 ? 3600 : parseDuration(args[sinceIndex + 1] || "");
  const limit = limitIndex === -1 ? 20 : Number(args[limitIndex + 1]);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("--limit must be an integer between 1 and 500.");
  }

  const store = openStore();
  const rows = store.history(
    new Date(Date.now() - sinceSeconds * 1000).toISOString(),
    limit,
  );
  store.close();
  if (!rows.length) {
    console.log(
      "No saved samples in that time range. Start HWatch with `hwatch start` to collect data.",
    );
    return;
  }

  console.log(
    `HWatch history · ${formatDate(rows[0].captured_at)} — ${formatDate(rows.at(-1).captured_at)}`,
  );
  console.log(
    "TIME                    CPU     MEMORY       TEMP     PROCESSES",
  );
  for (const row of rows) {
    const sample = sampleFromRow(row);
    const hottest = sample.temperatures.length
      ? `${Math.max(...sample.temperatures.map((reading) => reading.celsius)).toFixed(1)}°C`
      : "n/a";
    const time = new Date(sample.capturedAt).toLocaleTimeString();
    console.log(
      `${time.padEnd(23)} ${formatPercent(sample.cpuPercent).padStart(7)} ${`${sample.memoryPercent.toFixed(1)}%`.padStart(8)} ${hottest.padStart(9)} ${String(sample.processCount ?? "n/a").padStart(12)}`,
    );
  }
}

export async function run(args) {
  const [command, ...options] = args;
  try {
    if (command === "_collector") {
      const [, token, intervalMs] = args;
      await startCollector(token, Number(intervalMs));
      return;
    }
    if (
      !command ||
      command === "help" ||
      command === "--help" ||
      command === "-h"
    ) {
      showHelp();
      return;
    }
    if (command === "version" || command === "--version" || command === "-v") {
      console.log(packageInfo.version);
      return;
    }
    if (command === "start") return await startCommand(options);
    if (command === "stop") return stopCommand();
    if (command === "status") return await statusCommand(options);
    if (command === "history") return await historyCommand(options);
    throw new Error(
      `Unknown command "${command}". Run "hwatch help" for usage.`,
    );
  } catch (error) {
    console.error(`hwatch: ${error.message}`);
    process.exitCode = 1;
  }
}
