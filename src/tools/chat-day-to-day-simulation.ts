// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  formatDayToDaySimulationResultsMarkdown,
  runDayToDaySimulationSuite,
} from '../services/chat-day-to-day-simulation';

const result = runDayToDaySimulationSuite();
console.log(formatDayToDaySimulationResultsMarkdown(result));

if (!result.passed) {
  process.exitCode = 1;
}
