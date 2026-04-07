// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Bootstrap module — runs FIRST during module load, before any other
 * src/* import. Its job is to install process-level error handlers as
 * early as possible so that boot-time crashes (config validation, missing
 * env vars, EADDRINUSE on the portal port, etc.) get captured into the
 * error_log table once the database is up.
 *
 * Without this file, errors thrown during the synchronous evaluation of
 * `import { config } from './config'` happen BEFORE installProcessHandlers()
 * is called, so they only land in PM2's stderr log — invisible to the
 * admin portal which queries the SQLite error_log table. See audit P0-6.
 *
 * The error-monitor's boot buffer holds early errors in memory; when
 * setDbProvider() runs in main(), the buffer is flushed to error_log.
 *
 * IMPORTANT: this file MUST be the first import in src/index.ts. Do not
 * add other imports here unless they are guaranteed to have zero side
 * effects on module load.
 */
import { installProcessHandlers } from './services/error-monitor';

installProcessHandlers();
