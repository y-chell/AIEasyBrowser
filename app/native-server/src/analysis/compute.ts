import { beautify, search, unpack, type CodeLanguage, type SearchOptions } from './code';
import { describeMap, lookup, planRestore, type PageOptions } from './sourcemap';
import type { TextBase } from './text';

/** CPU-bound work that runs in the analysis worker thread. */
export type AnalysisJob =
  | { kind: 'beautify'; text: string; language: CodeLanguage }
  | { kind: 'unpack'; text: string; base: TextBase }
  | { kind: 'search'; text: string; base: TextBase; options: SearchOptions }
  | { kind: 'mapLoad'; text: string; page: PageOptions }
  | { kind: 'mapLookup'; text: string; line: number; column: number; sanitize: boolean }
  | { kind: 'mapRestore'; text: string };

export function computeJob(job: AnalysisJob): unknown {
  switch (job.kind) {
    case 'beautify':
      return beautify(job.text, job.language);
    case 'unpack':
      return unpack(job.text, job.base);
    case 'search':
      return search(job.text, job.base, job.options);
    case 'mapLoad':
      return describeMap(job.text, job.page);
    case 'mapLookup':
      return lookup(job.text, job.line, job.column, job.sanitize);
    case 'mapRestore':
      return planRestore(job.text);
  }
}
