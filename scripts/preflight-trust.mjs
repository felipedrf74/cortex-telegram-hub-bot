#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = execFileSync("git", ["rev-parse", "--verify", "origin/main"], { cwd: root, encoding: "utf8" }).trim();
const req = execFileSync(process.execPath, ["scripts/test-cleanup-classifier.mjs", "--base", base, "--field", "requiresMutation"], { cwd: root, encoding: "utf8" }).trim();
if (req === "false") {
  console.log("preflight:trust: mutation skipped (test-cleanup classifier=false)");
  process.exit(0);
}
if (req !== "true") {
  console.error("preflight:trust: unexpected classifier output: " + req);
  process.exit(2);
}
execFileSync(process.execPath, ["scripts/mutation-gate.mjs", "--base", "origin/main", "--scope", "test-cleanup"], { cwd: root, stdio: "inherit" });
