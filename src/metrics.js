import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return null;
  }
}

function temperatureFromFile(filePath) {
  const raw = readText(filePath);
  if (raw === null) return null;

  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const celsius = value > 1000 ? value / 1000 : value;
  if (celsius < -40 || celsius > 200) return null;
  return Math.round(celsius * 10) / 10;
}

function readTemperatures() {
  if (process.platform !== "linux") return [];
  const readings = [];
  const thermalRoot = "/sys/class/thermal";
  const hwmonRoot = "/sys/class/hwmon";

  try {
    for (const entry of fs.readdirSync(thermalRoot)) {
      if (!entry.startsWith("thermal_zone")) continue;
      const directory = path.join(thermalRoot, entry);
      const temperature = temperatureFromFile(path.join(directory, "temp"));
      if (temperature === null) continue;
      const label = readText(path.join(directory, "type")) || entry;
      readings.push({ name: label, celsius: temperature });
    }
  } catch {
    // Some systems do not expose thermal zones.
  }

  try {
    for (const device of fs.readdirSync(hwmonRoot)) {
      const directory = path.join(hwmonRoot, device);
      const deviceName = readText(path.join(directory, "name")) || device;
      for (const entry of fs.readdirSync(directory)) {
        const match = /^temp(\d+)_input$/.exec(entry);
        if (!match) continue;
        const temperature = temperatureFromFile(path.join(directory, entry));
        if (temperature === null) continue;
        const label = readText(path.join(directory, `temp${match[1]}_label`));
        readings.push({
          name: label ? `${deviceName} ${label}` : deviceName,
          celsius: temperature,
        });
      }
    }
  } catch {
    // Sensor permissions and hardware support vary by host.
  }

  const seen = new Set();
  return readings.filter((reading) => {
    const key = `${reading.name}:${reading.celsius}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readProcesses() {
  const result = spawnSync("ps", ["-A", "-o", "pid=,comm=,%cpu=,%mem="], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0 || !result.stdout) {
    return { count: null, top: [] };
  }

  const processes = result.stdout
    .split("\n")
    .map((line) => {
      const match = /^\s*(\d+)\s+(.+?)\s+([\d.]+)\s+([\d.]+)\s*$/.exec(line);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        name: match[2].trim(),
        cpuPercent: Number(match[3]),
        memoryPercent: Number(match[4]),
      };
    })
    .filter(Boolean);

  return {
    count: processes.length,
    top: processes.sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, 8),
  };
}

export function cpuTimes() {
  return os.cpus().reduce(
    (total, cpu) => ({
      idle: total.idle + cpu.times.idle,
      total:
        total.total +
        Object.values(cpu.times).reduce((sum, time) => sum + time, 0),
    }),
    { idle: 0, total: 0 },
  );
}

export function cpuPercentBetween(previous, current) {
  if (!previous || current.total <= previous.total) return null;
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  return Math.max(
    0,
    Math.min(100, Math.round((1 - idleDelta / totalDelta) * 1000) / 10),
  );
}

export function collectMetrics(cpuPercent = null) {
  const cpus = os.cpus();
  const memoryTotal = os.totalmem();
  const memoryUsed = Math.max(0, memoryTotal - os.freemem());
  const processes = readProcesses();

  return {
    capturedAt: new Date().toISOString(),
    hostname: os.hostname(),
    platform: os.platform(),
    architecture: os.arch(),
    uptimeSeconds: Math.round(os.uptime()),
    cpuModel: cpus[0]?.model?.trim() || "Unknown CPU",
    cpuCores: cpus.length,
    cpuPercent,
    load1: os.loadavg()[0] ?? 0,
    load5: os.loadavg()[1] ?? 0,
    load15: os.loadavg()[2] ?? 0,
    memoryTotal,
    memoryUsed,
    memoryPercent: memoryTotal
      ? Math.round((memoryUsed / memoryTotal) * 1000) / 10
      : 0,
    processCount: processes.count,
    temperatures: readTemperatures(),
    topProcesses: processes.top,
  };
}
