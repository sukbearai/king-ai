import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface HostLoopEvent {
  type?: string;
  runId?: string;
  loop?: number;
  timestamp?: string;
  agent?: string;
  classification?: string;
  [key: string]: unknown;
}

export interface HostLoopEventsInput {
  file?: string;
  outputDir?: string;
  runId?: string;
  agent?: string;
  type?: string;
  classification?: string;
  tail?: number;
  resultsFile?: string;
  writeResults?: boolean;
}

export interface HostLoopEventAppendInput {
  file?: string;
  outputDir?: string;
  event: HostLoopEvent;
}

export interface HostLoopEventsResult {
  file: string;
  events: HostLoopEvent[];
  totalEvents: number;
  filteredEvents: number;
  summary: HostLoopEventsSummary;
  results: HostLoopResultsTable;
}

export interface HostLoopEventsSummary {
  loops: number;
  classifications: Record<string, number>;
  productiveRate: number;
}

export interface HostLoopResultsTable {
  file: string;
  rows: HostLoopResultsRow[];
  written: boolean;
  text?: string;
}

export interface HostLoopResultsRow {
  runId: string;
  loop: number;
  timestamp: string;
  classification: string;
  tasksCreated: number;
  tasksDone: number;
  artifactsCreated: number;
  pendingMessages: number;
  completionRate: string;
  notes: string;
}

export interface HostLoopResultsInput {
  file?: string;
  outputDir?: string;
  resultsFile?: string;
}

export const HOST_LOOP_RESULTS_HEADER =
  [
    "run_id",
    "loop",
    "timestamp",
    "classification",
    "tasks_created",
    "tasks_done",
    "artifacts_created",
    "pending_messages",
    "completion_rate",
    "notes",
  ].join("\t") + "\n";

export async function appendHostLoopEvent(input: HostLoopEventAppendInput): Promise<string> {
  const file = resolveLoopEventsPath(input);
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(dropUndefined({ ...input.event }))}\n`, "utf8");
  return file;
}

export async function readHostLoopEvents(input: HostLoopEventsInput = {}): Promise<HostLoopEventsResult> {
  const file = resolveLoopEventsPath(input);
  const text = await readFile(file, "utf8").catch((err: unknown) => {
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "ENOENT") return "";
    throw err;
  });
  const events = parseLoopEvents(text);
  const filtered = events.filter((event) => matchesLoopEvent(event, input));
  const tail = normalizeTail(input.tail);
  const display = filtered.slice(-tail);
  const results = await maybeWriteLoopResults(events, input, file);
  return {
    file,
    events: display,
    totalEvents: events.length,
    filteredEvents: filtered.length,
    summary: summarizeLoopEvents(filtered),
    results,
  };
}

export async function readHostLoopResults(input: HostLoopResultsInput = {}): Promise<HostLoopResultsTable> {
  const eventsFile = resolveLoopEventsPath(input);
  const file = resolveLoopResultsPath(input, eventsFile);
  const existing = await readFile(file, "utf8").catch((err: unknown) => {
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "ENOENT")
      return undefined;
    throw err;
  });
  if (existing !== undefined) {
    return {
      file,
      rows: parseLoopResultsTable(existing),
      written: false,
      text: existing,
    };
  }

  const eventsText = await readFile(eventsFile, "utf8").catch((err: unknown) => {
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "ENOENT") return "";
    throw err;
  });
  const rows = buildLoopResultsRows(parseLoopEvents(eventsText));
  return {
    file,
    rows,
    written: false,
    text: formatLoopResultsTable(rows),
  };
}

export function formatHostLoopEvents(result: HostLoopEventsResult): string {
  if (result.events.length === 0) {
    return [`host run events: ${result.file}`, "no loop events"].join("\n");
  }
  const lines = [
    `host run events: ${result.file}`,
    `${result.events.length} shown (${result.filteredEvents} matched, ${result.totalEvents} total)`,
  ];
  for (const event of result.events) {
    lines.push(formatHostLoopEvent(event));
  }
  if (result.summary.loops > 0) {
    lines.push(`summary: ${result.summary.loops} classified loops, productive=${result.summary.productiveRate}%`);
  }
  if (result.results.written) {
    lines.push(`results: ${result.results.file} (${result.results.rows.length} rows)`);
  }
  return lines.join("\n");
}

function resolveLoopEventsPath(input: HostLoopEventsInput): string {
  if (input.file && input.file.trim()) return resolve(input.file);
  const outputDir = input.outputDir && input.outputDir.trim() ? input.outputDir : "deliverables";
  return resolve(join(outputDir, "loop-events.ndjson"));
}

function resolveLoopResultsPath(input: HostLoopEventsInput, eventsFile: string): string {
  if (input.resultsFile && input.resultsFile.trim()) return resolve(input.resultsFile);
  const outputDir = input.outputDir && input.outputDir.trim() ? input.outputDir : dirname(eventsFile);
  return resolve(join(outputDir, "results.tsv"));
}

function parseLoopEvents(text: string): HostLoopEvent[] {
  const events: HostLoopEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object") events.push(parsed as HostLoopEvent);
    } catch {
      // Ignore malformed lines so a partially written NDJSON file stays readable.
    }
  }
  return events;
}

function matchesLoopEvent(event: HostLoopEvent, input: HostLoopEventsInput): boolean {
  if (input.runId && event.runId !== input.runId) return false;
  if (input.agent && event.agent !== input.agent) return false;
  if (input.type && event.type !== input.type) return false;
  if (input.classification && event.classification !== input.classification) return false;
  return true;
}

function summarizeLoopEvents(events: HostLoopEvent[]): HostLoopEventsSummary {
  const classifications: Record<string, number> = {};
  for (const event of events) {
    if (event.type !== "loop.classified" || typeof event.classification !== "string") continue;
    classifications[event.classification] = (classifications[event.classification] ?? 0) + 1;
  }
  const loops = Object.values(classifications).reduce((sum, count) => sum + count, 0);
  const productive = classifications.productive ?? 0;
  return {
    loops,
    classifications,
    productiveRate: loops > 0 ? Math.round((productive / loops) * 100) : 0,
  };
}

async function maybeWriteLoopResults(
  events: HostLoopEvent[],
  input: HostLoopEventsInput,
  eventsFile: string,
): Promise<HostLoopResultsTable> {
  const file = resolveLoopResultsPath(input, eventsFile);
  const rows = buildLoopResultsRows(events);
  if (input.writeResults === false || (events.length === 0 && input.writeResults !== true))
    return { file, rows, written: false };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, formatLoopResultsTable(rows), "utf8");
  return { file, rows, written: true };
}

export function buildLoopResultsRows(events: HostLoopEvent[]): HostLoopResultsRow[] {
  const rows: HostLoopResultsRow[] = [];
  for (const event of events) {
    if (event.type !== "loop.classified" || typeof event.classification !== "string") continue;
    const runId = typeof event.runId === "string" && event.runId.trim() ? event.runId.trim() : "";
    const loop = numberValue(event.loop);
    if (loop === undefined) continue;
    const loopEvents = events.filter((entry) => sameLoop(entry, runId, loop));
    rows.push({
      runId,
      loop,
      timestamp: typeof event.timestamp === "string" ? event.timestamp : "",
      classification: event.classification,
      tasksCreated: loopEvents.filter((entry) => entry.type === "task.created").length,
      tasksDone: loopEvents.filter((entry) => entry.type === "task.transition" && doneStatus(entry.to)).length,
      artifactsCreated: loopEvents.filter((entry) => entry.type === "artifact.created").length,
      pendingMessages: maxNumber(
        loopEvents.map((entry) => numberValue(entry.pendingMessages) ?? numberValue(entry.pending)),
      ),
      completionRate: completionRateValue(event),
      notes: notesValue(event),
    });
  }
  return rows.sort(
    (a, b) => a.runId.localeCompare(b.runId) || a.loop - b.loop || a.timestamp.localeCompare(b.timestamp),
  );
}

export function formatLoopResultsTable(rows: HostLoopResultsRow[]): string {
  return (
    HOST_LOOP_RESULTS_HEADER +
    rows
      .map((row) =>
        [
          row.runId,
          String(row.loop),
          row.timestamp,
          row.classification,
          String(row.tasksCreated),
          String(row.tasksDone),
          String(row.artifactsCreated),
          String(row.pendingMessages),
          row.completionRate,
          row.notes,
        ]
          .map(tsvCell)
          .join("\t"),
      )
      .join("\n") +
    (rows.length ? "\n" : "")
  );
}

export function parseLoopResultsTable(text: string): HostLoopResultsRow[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length <= 1) return [];
  const header = lines[0]?.split("\t") ?? [];
  const index = new Map(header.map((name, i) => [name, i]));
  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    return {
      runId: cell(cells, index, "run_id"),
      loop: Number.parseInt(cell(cells, index, "loop") || "0", 10) || 0,
      timestamp: cell(cells, index, "timestamp"),
      classification: cell(cells, index, "classification"),
      tasksCreated: Number.parseInt(cell(cells, index, "tasks_created") || "0", 10) || 0,
      tasksDone: Number.parseInt(cell(cells, index, "tasks_done") || "0", 10) || 0,
      artifactsCreated: Number.parseInt(cell(cells, index, "artifacts_created") || "0", 10) || 0,
      pendingMessages: Number.parseInt(cell(cells, index, "pending_messages") || "0", 10) || 0,
      completionRate: cell(cells, index, "completion_rate"),
      notes: cell(cells, index, "notes"),
    };
  });
}

function cell(cells: string[], index: Map<string, number>, name: string): string {
  const i = index.get(name);
  return i === undefined ? "" : (cells[i] ?? "");
}

function sameLoop(event: HostLoopEvent, runId: string, loop: number): boolean {
  const eventRunId = typeof event.runId === "string" ? event.runId : "";
  return eventRunId === runId && numberValue(event.loop) === loop;
}

function doneStatus(value: unknown): boolean {
  return value === "done" || value === "completed" || value === "complete";
}

function completionRateValue(event: HostLoopEvent): string {
  const value = numberValue(event.completionRate) ?? numberValue(event.completion_rate);
  return value === undefined ? "" : String(value);
}

function notesValue(event: HostLoopEvent): string {
  if (Array.isArray(event.reasons)) return event.reasons.map(String).join("; ");
  if (typeof event.notes === "string") return event.notes;
  if (typeof event.reason === "string") return event.reason;
  return "";
}

function maxNumber(values: Array<number | undefined>): number {
  const numeric = values.filter((value): value is number => value !== undefined);
  return numeric.length ? Math.max(...numeric) : 0;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function tsvCell(value: string): string {
  return value.replace(/\t/g, " ").replace(/\r?\n/g, " ").trim();
}

function formatHostLoopEvent(event: HostLoopEvent): string {
  const ts = typeof event.timestamp === "string" ? event.timestamp : "no-time";
  const loop = event.loop === undefined ? "?" : String(event.loop);
  const type = typeof event.type === "string" ? event.type : "unknown";
  if (type === "loop.classified") {
    const reasons = Array.isArray(event.reasons) ? event.reasons.join("; ") : "";
    return `${ts} loop=${loop} ${type} ${event.classification ?? "unknown"}${reasons ? ` ${reasons}` : ""}`;
  }
  if (type === "task.transition") {
    return `${ts} loop=${loop} ${type} task=${event.taskId ?? "?"} ${event.from ?? "?"}->${event.to ?? "?"}`;
  }
  if (type === "queue.backlog") {
    return `${ts} loop=${loop} ${type} agent=${event.agent ?? "?"} pending=${event.pendingMessages ?? event.pending ?? "?"}`;
  }
  if (type === "agent.spawned") {
    return `${ts} loop=${loop} ${type} agent=${event.agent ?? "?"} trigger=${event.trigger ?? "?"}`;
  }
  return `${ts} loop=${loop} ${type} ${JSON.stringify(event).slice(0, 120)}`;
}

function dropUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function normalizeTail(value: unknown): number {
  if (value === undefined || value === null || value === "") return 20;
  const tail = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(tail) || tail < 1) throw new Error("loop event tail must be a positive integer");
  return Math.floor(tail);
}
