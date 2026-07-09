export interface CliRunResult<T> {
  ok: boolean;
  data: T;
  error?: string;
}

export function cliFailure<T>(data: T, error: string): CliRunResult<T> {
  return { ok: false, data, error };
}

export function cliSuccess<T>(data: T): CliRunResult<T> {
  return { ok: true, data };
}
