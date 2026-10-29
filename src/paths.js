import os from "node:os";
import path from "node:path";

export const dataDirectory = path.resolve(
  process.env.HWATCH_DATA_DIR || path.join(os.homedir(), ".hwatch"),
);
export const databasePath = path.join(dataDirectory, "hwatch.sqlite");
export const runFilePath = path.join(dataDirectory, "collector.json");
