// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  formatDayToDaySimulationResultsMarkdown,
  runDayToDaySimulationSuite,
} from '../services/chat-day-to-day-simulation';

async function main(): Promise<void> {
  const result = await runDayToDaySimulationSuite();
  console.log(formatDayToDaySimulationResultsMarkdown(result));

  if (!result.passed) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
