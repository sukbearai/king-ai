import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { CONFIG_DIR, CONFIG_PATH, LEGACY_CONFIG_PATH } from "./paths.js";
import type { ComputerConfig } from "./types.js";

export async function loadConfig(): Promise<ComputerConfig | null> {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8")) as ComputerConfig;
  } catch {
    try {
      return JSON.parse(await readFile(LEGACY_CONFIG_PATH, "utf8")) as ComputerConfig;
    } catch {
      return null;
    }
  }
}

export async function saveConfig(config: ComputerConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
  await chmod(CONFIG_PATH, 0o600);
}
