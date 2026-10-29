import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { collectMetrics, cpuPercentBetween, cpuTimes } from "./metrics.js";
import { runFilePath } from "./paths.js";
import { openStore } from "./store.js";

function readRunRecord() {
  try {
    return JSON.parse(fs.readFileSync(runFilePath, "utf8"));
  } catch {
    return null;
  }
}

export async function startCollector(token, intervalMs) {
  process.title = "hwatch-collector";
  const startDeadline = Date.now() + 5000;
  let runRecord;
  while (Date.now() < startDeadline) {
    runRecord = readRunRecord();
    if (runRecord?.token === token) break;
    await delay(50);
  }
  if (runRecord?.token !== token) return;

  let store;
  try {
    store = openStore();
  } catch (error) {
    console.error(
      `HWatch collector could not open its database: ${error.message}`,
    );
    return;
  }

  let previousCpuTimes = cpuTimes();
  let stopped = false;
  let timer;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    store.close();
    const current = readRunRecord();
    if (current?.token === token) {
      try {
        fs.unlinkSync(runFilePath);
      } catch {
        // The file may already have been removed by a newer start.
      }
    }
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("uncaughtException", (error) => {
    console.error(
      `HWatch collector stopped after an error: ${error.stack || error.message}`,
    );
    stop();
    process.exitCode = 1;
  });

  const sample = () => {
    try {
      const currentCpuTimes = cpuTimes();
      const metrics = collectMetrics(
        cpuPercentBetween(previousCpuTimes, currentCpuTimes),
      );
      previousCpuTimes = currentCpuTimes;
      store.insert(metrics);
      store.prune();
    } catch (error) {
      console.error(
        `HWatch collector could not save a sample: ${error.message}`,
      );
    }
  };

  await delay(200);
  sample();
  timer = setInterval(sample, intervalMs);
}
