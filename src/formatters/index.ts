import type { CheckReport, OutputFormat } from '../types.js';
import { formatJson } from './json.js';
import { buildSarifLog, formatSarif, type SarifLevel, type SarifLog, severityToSarifLevel } from './sarif.js';
import { formatText } from './text.js';

export function formatReport(report: CheckReport, format: OutputFormat = 'text'): string {
  switch (format) {
    case 'json':
      return formatJson(report);
    case 'sarif':
      return formatSarif(report);
    case 'text':
    default:
      return formatText(report);
  }
}

export {
  buildSarifLog,
  formatJson,
  formatSarif,
  formatText,
  severityToSarifLevel,
};

export type { SarifLevel, SarifLog };
