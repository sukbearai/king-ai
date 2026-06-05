import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { CONFIG_DIR } from "./paths.js";
import { join } from "node:path";

export const DEVICES_PATH = join(CONFIG_DIR, "devices.json");

export interface RemoteAppConfig {
  installMarkers?: string[];
  logRoots?: string[];
  errorPatterns?: string[];
}

export interface RemoteServiceCommand {
  type?: string;
  command: string;
}

export interface RemoteDevice {
  id: string;
  name?: string;
  host: string;
  port?: number;
  user: string;
  password?: string;
  passwordEnv?: string;
  identityFile?: string;
  defaultApp?: string;
  apps?: Record<string, RemoteAppConfig>;
  databases?: Record<string, RemoteServiceCommand>;
  redis?: Record<string, RemoteServiceCommand>;
}

export interface RemoteDevicesConfig {
  defaultDevice?: string;
  devices: RemoteDevice[];
}

export type RemoteDeviceSummary = Omit<RemoteDevice, "password"> & {
  auth: "password" | "passwordEnv" | "identityFile" | "ssh-agent";
  hasPassword: boolean;
};

export async function loadRemoteDevicesConfig(path = DEVICES_PATH): Promise<RemoteDevicesConfig> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return normalizeRemoteDevicesConfig(parsed);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT") {
      return { devices: [] };
    }
    throw err;
  }
}

export async function saveRemoteDevicesConfig(config: RemoteDevicesConfig, path = DEVICES_PATH): Promise<RemoteDevicesConfig> {
  const normalized = normalizeRemoteDevicesConfig(config);
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(path, JSON.stringify(normalized, null, 2) + "\n", "utf8");
  await chmod(path, 0o600).catch(() => undefined);
  return normalized;
}

export function summarizeRemoteDevice(device: RemoteDevice): RemoteDeviceSummary {
  const auth = device.password ? "password" : device.passwordEnv ? "passwordEnv" : device.identityFile ? "identityFile" : "ssh-agent";
  const { password: _password, ...rest } = device;
  return {
    ...rest,
    auth,
    hasPassword: Boolean(device.password)
  };
}

export function listRemoteDeviceSummaries(config: RemoteDevicesConfig): RemoteDeviceSummary[] {
  return config.devices.map(summarizeRemoteDevice);
}

export function findRemoteDevice(config: RemoteDevicesConfig, idOrHost?: string): RemoteDevice {
  const key = (idOrHost || config.defaultDevice || "").trim();
  if (!key) throw new Error("remote device is required");
  const device = config.devices.find((entry) => entry.id === key || entry.host === key);
  if (!device) throw new Error(`remote device not found: ${key}`);
  return device;
}

export function upsertRemoteDevice(config: RemoteDevicesConfig, raw: unknown): RemoteDevicesConfig {
  const device = normalizeRemoteDevice(raw, "device");
  const devices = config.devices.filter((entry) => entry.id !== device.id);
  devices.push(device);
  return normalizeRemoteDevicesConfig({
    defaultDevice: config.defaultDevice || device.id,
    devices
  });
}

export function deleteRemoteDevice(config: RemoteDevicesConfig, id: string): RemoteDevicesConfig {
  const key = id.trim();
  if (!key) throw new Error("remote device id is required");
  const devices = config.devices.filter((entry) => entry.id !== key);
  return normalizeRemoteDevicesConfig({
    defaultDevice: config.defaultDevice === key ? devices[0]?.id : config.defaultDevice,
    devices
  });
}

export function setDefaultRemoteDevice(config: RemoteDevicesConfig, id: string): RemoteDevicesConfig {
  const device = findRemoteDevice(config, id);
  return normalizeRemoteDevicesConfig({ ...config, defaultDevice: device.id });
}

export function normalizeRemoteDevicesConfig(raw: unknown): RemoteDevicesConfig {
  if (!raw || typeof raw !== "object") throw new Error("remote devices config must be an object");
  const input = raw as { defaultDevice?: unknown; devices?: unknown };
  if (!Array.isArray(input.devices)) throw new Error("remote devices config must include devices array");
  const devices = input.devices.map((item, index) => normalizeRemoteDevice(item, `devices[${index}]`));
  const ids = new Set<string>();
  for (const device of devices) {
    if (ids.has(device.id)) throw new Error(`duplicate remote device id: ${device.id}`);
    ids.add(device.id);
  }
  const defaultDevice = typeof input.defaultDevice === "string" && input.defaultDevice.trim() ? input.defaultDevice.trim() : undefined;
  if (defaultDevice && !ids.has(defaultDevice)) throw new Error(`default remote device not found: ${defaultDevice}`);
  return { ...(defaultDevice ? { defaultDevice } : {}), devices };
}

function normalizeRemoteDevice(raw: unknown, label: string): RemoteDevice {
  if (!raw || typeof raw !== "object") throw new Error(`${label} must be an object`);
  const input = raw as Record<string, unknown>;
  const id = requiredString(input.id, `${label}.id`);
  const host = requiredString(input.host, `${label}.host`);
  const user = requiredString(input.user, `${label}.user`);
  const port = optionalPort(input.port, `${label}.port`);
  return {
    id,
    ...(optionalString(input.name) ? { name: optionalString(input.name) } : {}),
    host,
    ...(port ? { port } : {}),
    user,
    ...(optionalString(input.password) ? { password: optionalString(input.password) } : {}),
    ...(optionalString(input.passwordEnv) ? { passwordEnv: optionalString(input.passwordEnv) } : {}),
    ...(optionalString(input.identityFile) ? { identityFile: optionalString(input.identityFile) } : {}),
    ...(optionalString(input.defaultApp) ? { defaultApp: optionalString(input.defaultApp) } : {}),
    ...(input.apps && typeof input.apps === "object" ? { apps: normalizeApps(input.apps as Record<string, unknown>, `${label}.apps`) } : {}),
    ...(input.databases && typeof input.databases === "object" ? { databases: normalizeServiceCommands(input.databases as Record<string, unknown>, `${label}.databases`) } : {}),
    ...(input.redis && typeof input.redis === "object" ? { redis: normalizeServiceCommands(input.redis as Record<string, unknown>, `${label}.redis`) } : {})
  };
}

function normalizeApps(raw: Record<string, unknown>, label: string): Record<string, RemoteAppConfig> {
  const result: Record<string, RemoteAppConfig> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") throw new Error(`${label}.${name} must be an object`);
    const app = value as Record<string, unknown>;
    result[name] = {
      ...(app.installMarkers !== undefined ? { installMarkers: normalizeStringArray(app.installMarkers, `${label}.${name}.installMarkers`) } : {}),
      ...(app.logRoots !== undefined ? { logRoots: normalizeStringArray(app.logRoots, `${label}.${name}.logRoots`) } : {}),
      ...(app.errorPatterns !== undefined ? { errorPatterns: normalizeStringArray(app.errorPatterns, `${label}.${name}.errorPatterns`) } : {})
    };
  }
  return result;
}

function normalizeServiceCommands(raw: Record<string, unknown>, label: string): Record<string, RemoteServiceCommand> {
  const result: Record<string, RemoteServiceCommand> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") throw new Error(`${label}.${name} must be an object`);
    const service = value as Record<string, unknown>;
    result[name] = {
      ...(optionalString(service.type) ? { type: optionalString(service.type) } : {}),
      command: requiredString(service.command, `${label}.${name}.command`)
    };
  }
  return result;
}

function normalizeStringArray(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw)) throw new Error(`${label} must be an array`);
  return raw.map((item, index) => requiredString(item, `${label}[${index}]`));
}

function requiredString(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`${label} must be a non-empty string`);
  return raw.trim();
}

function optionalString(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function optionalPort(raw: unknown, label: string): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const port = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${label} must be between 1 and 65535`);
  return port;
}
