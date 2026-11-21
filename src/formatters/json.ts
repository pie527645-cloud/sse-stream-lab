import type { CheckReport } from '../types.js';

export function formatJson(report: CheckReport): string {
  return JSON.stringify(report, null, 2);
}
