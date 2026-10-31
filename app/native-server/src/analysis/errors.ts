/**
 * Failure with a stable code. It crosses the worker boundary as {code, detail}, so it must not
 * depend on anything that cannot be imported inside the analysis worker.
 */
export class AnalysisError extends Error {
  constructor(
    public readonly code: string,
    public readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'AnalysisError';
  }
}

export function invalid(message: string): never {
  throw new AnalysisError('INVALID_ARGUMENT', message);
}
