#!/usr/bin/env npx tsx
/**
 * Registry Feedback Report CLI — Phase 6 batch 32 (2026-05-15).
 *
 * Composes the Phase 4-5 telemetry feedback modules into a single CLI:
 *
 *   • telemetry report (per-action summary, latency, clarification rate)
 *   • adversarial discovery (refusal-pattern clusters)
 *   • readableIntents proposer (coverage-gap surfacing)
 *
 * Reads from the SQLite chat_action_telemetry table. Emits three markdown
 * sections to stdout (or to --output if provided). Intended for periodic
 * (weekly) review by Felipe, not real-time alerts.
 *
 * Usage:
 *   npx tsx scripts/registry-feedback-report.ts [options]
 *
 * Options:
 *   --db <path>           Path to SQLite database (default: ./data/app.db)
 *   --since <ISO>         Filter to rows created after this ISO timestamp
 *   --tenant <id>         Filter to a specific tenant
 *   --output <path>       Write to file instead of stdout
 *   --section <name>      Emit only one section: telemetry | adversarial | proposer | all
 *
 * Example:
 *   npx tsx scripts/registry-feedback-report.ts --since 2026-05-01T00:00:00Z --output /tmp/registry-weekly.md
 */

import { existsSync } from 'fs';
import { writeFileSync } from 'fs';
import { argv, stdout, exit } from 'process';
import Database from 'better-sqlite3';

import {
  generateRegistryTelemetryReport,
} from '../src/services/registry-telemetry-report';
import {
  discoverAdversarialCandidates,
  formatAdversarialDiscoveryMarkdown,
} from '../src/services/registry-adversarial-discovery';
import {
  proposeReadableIntentsExtensions,
  formatReadableIntentsProposalsMarkdown,
} from '../src/services/registry-readable-intents-proposer';

interface Options {
  db: string;
  since?: string;
  tenantId?: number;
  output?: string;
  section: 'telemetry' | 'adversarial' | 'proposer' | 'all';
}

function parseArgs(args: string[]): Options {
  const options: Options = { db: './data/app.db', section: 'all' };
  for (let i = 2; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    switch (flag) {
      case '--db':
        options.db = value;
        i++;
        break;
      case '--since':
        options.since = value;
        i++;
        break;
      case '--tenant':
        options.tenantId = parseInt(value, 10);
        i++;
        break;
      case '--output':
        options.output = value;
        i++;
        break;
      case '--section':
        if (value === 'telemetry' || value === 'adversarial' || value === 'proposer' || value === 'all') {
          options.section = value;
        }
        i++;
        break;
      case '--help':
      case '-h':
        printHelp();
        exit(0);
    }
  }
  return options;
}

function printHelp(): void {
  stdout.write(`Registry Feedback Report CLI

Usage:
  npx tsx scripts/registry-feedback-report.ts [options]

Options:
  --db <path>      Path to SQLite database (default: ./data/app.db)
  --since <ISO>    Filter to rows after timestamp
  --tenant <id>    Filter to tenant
  --output <path>  Write to file instead of stdout
  --section <name> telemetry | adversarial | proposer | all (default: all)
  --help, -h       Show this help
`);
}

function main(): void {
  const options = parseArgs(argv);
  if (!existsSync(options.db)) {
    stdout.write(`ERROR: database not found at ${options.db}\n`);
    exit(1);
  }
  const db = new Database(options.db, { readonly: true });
  try {
    const sections: string[] = [];
    if (options.section === 'all' || options.section === 'telemetry') {
      const telemetry = generateRegistryTelemetryReport(db, {
        since: options.since,
        tenantId: options.tenantId,
      });
      sections.push(telemetry.markdown);
    }
    if (options.section === 'all' || options.section === 'adversarial') {
      const clusters = discoverAdversarialCandidates(db, {
        since: options.since,
        tenantId: options.tenantId,
      });
      sections.push(formatAdversarialDiscoveryMarkdown(clusters, {
        since: options.since,
        tenantId: options.tenantId,
      }));
    }
    if (options.section === 'all' || options.section === 'proposer') {
      const proposals = proposeReadableIntentsExtensions(db, {
        since: options.since,
        tenantId: options.tenantId,
      });
      sections.push(formatReadableIntentsProposalsMarkdown(proposals));
    }
    const output = sections.join('\n\n---\n\n');
    if (options.output) {
      writeFileSync(options.output, output);
      stdout.write(`Report written to ${options.output}\n`);
    } else {
      stdout.write(output);
      stdout.write('\n');
    }
  } finally {
    db.close();
  }
}

main();
