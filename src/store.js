import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { databasePath, dataDirectory } from "./paths.js";

export function ensureDataDirectory() {
  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
}

export function openStore() {
  ensureDataDirectory();
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS samples (
      id INTEGER PRIMARY KEY,
      captured_at TEXT NOT NULL,
      hostname TEXT NOT NULL,
      platform TEXT NOT NULL,
      architecture TEXT NOT NULL,
      uptime_seconds INTEGER NOT NULL,
      cpu_model TEXT NOT NULL,
      cpu_cores INTEGER NOT NULL,
      cpu_percent REAL,
      load_1 REAL NOT NULL,
      load_5 REAL NOT NULL,
      load_15 REAL NOT NULL,
      memory_total INTEGER NOT NULL,
      memory_used INTEGER NOT NULL,
      memory_percent REAL NOT NULL,
      process_count INTEGER,
      temperatures_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS samples_captured_at_idx ON samples(captured_at);
  `);

  return {
    insert(sample) {
      const statement = database.prepare(`
        INSERT INTO samples (
          captured_at, hostname, platform, architecture, uptime_seconds,
          cpu_model, cpu_cores, cpu_percent, load_1, load_5, load_15,
          memory_total, memory_used, memory_percent, process_count, temperatures_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      statement.run(
        sample.capturedAt,
        sample.hostname,
        sample.platform,
        sample.architecture,
        sample.uptimeSeconds,
        sample.cpuModel,
        sample.cpuCores,
        sample.cpuPercent,
        sample.load1,
        sample.load5,
        sample.load15,
        sample.memoryTotal,
        sample.memoryUsed,
        sample.memoryPercent,
        sample.processCount,
        JSON.stringify(sample.temperatures),
      );
    },
    latest() {
      return (
        database
          .prepare("SELECT * FROM samples ORDER BY id DESC LIMIT 1")
          .get() || null
      );
    },
    history(since, limit) {
      return database
        .prepare(
          "SELECT * FROM samples WHERE captured_at >= ? ORDER BY captured_at DESC LIMIT ?",
        )
        .all(since, limit)
        .reverse();
    },
    prune(retentionDays = 7) {
      const cutoff = new Date(
        Date.now() - retentionDays * 24 * 60 * 60 * 1000,
      ).toISOString();
      database.prepare("DELETE FROM samples WHERE captured_at < ?").run(cutoff);
    },
    close() {
      database.close();
    },
  };
}

export function sampleFromRow(row) {
  if (!row) return null;
  return {
    capturedAt: row.captured_at,
    hostname: row.hostname,
    platform: row.platform,
    architecture: row.architecture,
    uptimeSeconds: row.uptime_seconds,
    cpuModel: row.cpu_model,
    cpuCores: row.cpu_cores,
    cpuPercent: row.cpu_percent,
    load1: row.load_1,
    load5: row.load_5,
    load15: row.load_15,
    memoryTotal: row.memory_total,
    memoryUsed: row.memory_used,
    memoryPercent: row.memory_percent,
    processCount: row.process_count,
    temperatures: JSON.parse(row.temperatures_json),
  };
}
