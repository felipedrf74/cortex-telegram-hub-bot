import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROUTING_CALIBRATION_EXPORT_PLAN_SCHEMA =
  'nexus.routing-calibration-export-plan.v1';
export const ROUTING_CALIBRATION_EXPORT_EVIDENCE_SCHEMA =
  'nexus.routing-calibration-export-evidence.v1';
export const ROUTING_CALIBRATION_EXPORT_PARTIAL_SCHEMA =
  'nexus.routing-calibration-export-partial.v1';
export const ROUTING_CALIBRATION_EXPORT_RECEIPT_SCHEMA =
  'nexus.routing-calibration-export-receipt.v1';

const EXPECTED_CORPUS_ROWS = 300;
const PRIVATE_FILE_MODE = 0o600;
const NORMALIZED_CREATED_AT_BASE = '1970-01-01T00:00:00.000Z';
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const RUNTIME_SHA = /^[a-f0-9]{40}$/u;
const ARTIFACT_DIGEST = /^[a-f0-9]{64}$/u;
const TRANSACTION_ID = /^\d{8}T\d{6}Z-[a-f0-9]{12}$/u;
const MAXIMUM_PLAN_TTL_MS = 60 * 60_000;
const MAXIMUM_CLOCK_SKEW_MS = 60_000;

const SOURCE_TABLE_COLUMNS = Object.freeze({
  routing_corpus_items: [
    ['id', 'INTEGER', 0, 1],
    ['tenant_id', 'INTEGER', 1, 0],
    ['user_id', 'INTEGER', 0, 0],
    ['utterance_hash', 'TEXT', 1, 0],
    ['utterance_text', 'TEXT', 0, 0],
    ['source', 'TEXT', 1, 0],
    ['suggested_domain', 'TEXT', 0, 0],
    ['suggested_skill', 'TEXT', 0, 0],
    ['label_domain', 'TEXT', 0, 0],
    ['label_skill', 'TEXT', 0, 0],
    ['label_status', 'TEXT', 1, 0],
    ['labeled_at', 'TEXT', 0, 0],
    ['created_at', 'TEXT', 1, 0],
  ],
  routing_llm_classify_cache: [
    ['utterance_hash', 'TEXT', 0, 1],
    ['domain', 'TEXT', 1, 0],
    ['confidence', 'REAL', 1, 0],
    ['model', 'TEXT', 0, 0],
    ['created_at', 'TEXT', 1, 0],
  ],
  accepted_accuracy_snapshots: [
    ['id', 'INTEGER', 0, 1],
    ['created_at', 'TEXT', 1, 0],
    ['snapshot_json', 'TEXT', 1, 0],
    ['accepted', 'INTEGER', 1, 0],
  ],
});

export const ROUTING_CALIBRATION_SANITIZED_SCHEMA = `
  CREATE TABLE routing_corpus_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 0,
    user_id INTEGER,
    utterance_hash TEXT NOT NULL UNIQUE CHECK (length(utterance_hash) = 64),
    utterance_text TEXT,
    source TEXT NOT NULL CHECK (source IN (
      'classify_shadow_disagreement',
      'online_eval_sampler',
      'bilingual_fixture',
      'history_unmatched',
      'manual'
    )),
    suggested_domain TEXT,
    suggested_skill TEXT,
    label_domain TEXT,
    label_skill TEXT,
    label_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (label_status IN ('pending', 'labeled', 'skipped')),
    labeled_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (
      (label_status = 'pending' AND label_domain IS NULL
        AND label_skill IS NULL AND labeled_at IS NULL)
      OR (label_status = 'labeled' AND label_domain IS NOT NULL
        AND labeled_at IS NOT NULL)
      OR (label_status = 'skipped' AND label_domain IS NULL
        AND label_skill IS NULL AND labeled_at IS NOT NULL)
    )
  );
  CREATE INDEX idx_routing_corpus_items_status
    ON routing_corpus_items(label_status, created_at ASC, id ASC);
  CREATE INDEX idx_routing_corpus_items_tenant_status
    ON routing_corpus_items(tenant_id, label_status);
  CREATE INDEX idx_routing_corpus_items_source
    ON routing_corpus_items(source, label_status);

  CREATE TABLE routing_llm_classify_cache (
    utterance_hash TEXT PRIMARY KEY CHECK (length(utterance_hash) = 64),
    domain TEXT NOT NULL,
    confidence REAL NOT NULL,
    model TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE accepted_accuracy_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    snapshot_json TEXT NOT NULL,
    accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1))
  );
  CREATE INDEX idx_accepted_accuracy_snapshots_accepted
    ON accepted_accuracy_snapshots(accepted, created_at DESC, id DESC);
`;

function fail(message) {
  throw new Error(message);
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('\n') !== [...expected].sort().join('\n')) {
    fail(`${label} has unexpected or missing fields`);
  }
}

function assertCanonicalTimestamp(value, label) {
  if (typeof value !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
      || !Number.isFinite(Date.parse(value))
      || new Date(value).toISOString() !== value) {
    fail(`${label} must be a canonical UTC timestamp with milliseconds`);
  }
  return value;
}

function assertDigest(value, label) {
  if (!SHA256.test(value ?? '')) fail(`${label} must be a canonical SHA-256 digest`);
  return value;
}

function assertIdentity(input) {
  if (!RUNTIME_SHA.test(input.runtimeSha ?? '')) fail('runtime SHA must be full lowercase 40-hex');
  if (!ARTIFACT_DIGEST.test(input.artifactDigest ?? '')) {
    fail('artifact digest must be full lowercase SHA-256');
  }
  if (!TRANSACTION_ID.test(input.transactionId ?? '')) fail('transaction ID is invalid');
}

export function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') fail('value is not canonical JSON');
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

export function sha256Digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function publishPrivateEvidenceFile(input) {
  const { resolved: sourcePath } = safePrivateFile(input.sourcePath, 'publication source');
  const parent = safePrivateDirectory(
    path.dirname(path.resolve(input.destinationPath)),
    'publication destination directory',
  );
  const destinationPath = path.join(
    parent.resolved,
    path.basename(path.resolve(input.destinationPath)),
  );
  const sourceBytes = fs.readFileSync(sourcePath);
  recoverInterruptedPrivatePublication({
    parentPath: parent.resolved,
    destinationPath,
    sourceBytes,
  });
  if (fs.existsSync(destinationPath) || (() => {
    try { return fs.lstatSync(destinationPath).isSymbolicLink(); } catch { return false; }
  })()) {
    const { resolved } = safePrivateFile(destinationPath, 'existing published evidence');
    if (!fs.readFileSync(resolved).equals(sourceBytes)) {
      fail('existing published evidence differs from the exact retry bytes');
    }
    return { status: 'already_published', destinationPath };
  }
  const temporaryPath = path.join(
    parent.resolved,
    `.${path.basename(destinationPath)}.next-${process.pid}-${randomBytes(6).toString('hex')}`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', PRIVATE_FILE_MODE);
    fs.writeFileSync(descriptor, sourceBytes);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  fs.chmodSync(temporaryPath, PRIVATE_FILE_MODE);
  try {
    input.beforeExclusivePublish?.({ temporaryPath, destinationPath });
    fs.linkSync(temporaryPath, destinationPath);
    fs.unlinkSync(temporaryPath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch { /* best-effort private temp cleanup */ }
    throw error;
  }
  const parentDescriptor = fs.openSync(parent.resolved, 'r');
  try { fs.fsyncSync(parentDescriptor); } finally { fs.closeSync(parentDescriptor); }
  const published = safePrivateFile(destinationPath, 'published evidence');
  if (!fs.readFileSync(published.resolved).equals(sourceBytes)) {
    fail('published evidence differs from its source bytes');
  }
  return { status: 'published', destinationPath };
}

function pathEntryExists(filename) {
  try {
    fs.lstatSync(filename);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function readSequencePlan(filename, expectedTransactionId, label) {
  const plan = JSON.parse(fs.readFileSync(
    safePrivateFile(filename, label).resolved,
    'utf8',
  ));
  if (plan?.schema !== ROUTING_CALIBRATION_EXPORT_PLAN_SCHEMA
      || plan.transactionId !== expectedTransactionId
      || !Number.isSafeInteger(plan.planSequence) || plan.planSequence < 1) {
    fail(`${label} does not carry a valid transaction sequence`);
  }
  return plan;
}

export function nextRoutingCalibrationExportPlanSequence(input) {
  const stateRoot = safePrivateDirectory(
    path.dirname(path.resolve(input.sequencePath)),
    'routing export state root',
  ).resolved;
  const roots = {
    plan: safePrivateDirectory(input.planRoot, 'routing export plan root').resolved,
    claim: safePrivateDirectory(input.claimRoot, 'routing export claim root').resolved,
    export: safePrivateDirectory(input.exportRoot, 'routing export output root').resolved,
    receipt: safePrivateDirectory(input.receiptRoot, 'routing export receipt root').resolved,
  };
  for (const [kind, root] of Object.entries(roots)) {
    if (path.dirname(root) !== stateRoot || path.basename(root) !== `${kind}s`) {
      fail(`routing export ${kind} root is outside the exact state layout`);
    }
  }
  if (path.resolve(input.sequencePath) !== path.join(stateRoot, 'sequence.json')) {
    fail('routing export sequence path is outside the exact state layout');
  }
  const patterns = {
    plan: /^(\d{8}T\d{6}Z-[a-f0-9]{12})\.json$/u,
    claim: /^(\d{8}T\d{6}Z-[a-f0-9]{12})\.(plan\.json|export-evidence\.json)$/u,
    export: /^(\d{8}T\d{6}Z-[a-f0-9]{12})\.sqlite(?:\.partial)?$/u,
    receipt: /^(\d{8}T\d{6}Z-[a-f0-9]{12})(?:\.partial)?\.json$/u,
  };
  const entries = {};
  for (const [kind, root] of Object.entries(roots)) {
    entries[kind] = fs.readdirSync(root).map((name) => {
      const match = patterns[kind].exec(name);
      if (!match) fail(`routing export ${kind} root contains an unknown state entry`);
      const filename = path.join(root, name);
      safePrivateFile(filename, `routing export ${kind} state`);
      return { name, transactionId: match[1], filename };
    });
  }

  if (!pathEntryExists(input.sequencePath)) {
    if (Object.values(entries).some((values) => values.length !== 0)) {
      fail('routing export sequence is missing while transaction state exists');
    }
    return 1;
  }
  const sequence = JSON.parse(fs.readFileSync(
    safePrivateFile(input.sequencePath, 'routing export sequence').resolved,
    'utf8',
  ));
  assertExactKeys(sequence, ['schema', 'lastIssued'], 'routing export sequence');
  if (sequence.schema !== 'nexus.routing-calibration-export-sequence.v1'
      || !Number.isSafeInteger(sequence.lastIssued) || sequence.lastIssued < 1
      || sequence.lastIssued >= Number.MAX_SAFE_INTEGER) {
    fail('routing export sequence is invalid');
  }

  let maximumObserved = 0;
  const planIds = new Set();
  for (const entry of entries.plan) {
    const plan = readSequencePlan(entry.filename, entry.transactionId, 'pending export plan');
    planIds.add(entry.transactionId);
    maximumObserved = Math.max(maximumObserved, plan.planSequence);
  }
  for (const entry of entries.claim.filter(({ name }) => name.endsWith('.plan.json'))) {
    const plan = readSequencePlan(entry.filename, entry.transactionId, 'claimed export plan');
    planIds.add(entry.transactionId);
    maximumObserved = Math.max(maximumObserved, plan.planSequence);
  }
  for (const entry of [
    ...entries.claim.filter(({ name }) => name.endsWith('.export-evidence.json')),
    ...entries.export,
    ...entries.receipt,
  ]) {
    if (!planIds.has(entry.transactionId)) {
      fail('routing export artifact has no retained pending or claimed plan');
    }
  }
  if (sequence.lastIssued < maximumObserved) {
    fail('routing export sequence was reset below retained transaction state');
  }
  return sequence.lastIssued + 1;
}

function listExactPrivateState(root, pattern, label) {
  return fs.readdirSync(root).map((name) => {
    const match = pattern.exec(name);
    if (!match) fail(`${label} contains an unknown state entry`);
    const filename = path.join(root, name);
    safePrivateFile(filename, `${label} entry`);
    return { name, transactionId: match[1], filename };
  });
}

export function assertRoutingCalibrationExportStateResolved(input) {
  const planRoot = safePrivateDirectory(input.planRoot, 'routing export plan root').resolved;
  const claimRoot = safePrivateDirectory(input.claimRoot, 'routing export claim root').resolved;
  const exportRoot = safePrivateDirectory(input.exportRoot, 'routing export output root').resolved;
  const receiptRoot = safePrivateDirectory(
    input.receiptRoot,
    'routing export receipt root',
  ).resolved;
  const plans = listExactPrivateState(
    planRoot,
    /^(\d{8}T\d{6}Z-[a-f0-9]{12})\.json$/u,
    'routing export plan root',
  );
  const claims = listExactPrivateState(
    claimRoot,
    /^(\d{8}T\d{6}Z-[a-f0-9]{12})\.(plan\.json|export-evidence\.json)$/u,
    'routing export claim root',
  );
  const exports = listExactPrivateState(
    exportRoot,
    /^(\d{8}T\d{6}Z-[a-f0-9]{12})\.sqlite(?:\.partial)?$/u,
    'routing export output root',
  );
  const receipts = listExactPrivateState(
    receiptRoot,
    /^(\d{8}T\d{6}Z-[a-f0-9]{12})(?:\.partial)?\.json$/u,
    'routing export receipt root',
  );
  const attemptedIds = new Set([
    ...claims.map(({ transactionId }) => transactionId),
    ...exports.map(({ transactionId }) => transactionId),
    ...receipts.map(({ transactionId }) => transactionId),
  ]);
  for (const transactionId of attemptedIds) {
    const pendingPath = path.join(planRoot, `${transactionId}.json`);
    const claimPath = path.join(claimRoot, `${transactionId}.plan.json`);
    const evidencePath = path.join(claimRoot, `${transactionId}.export-evidence.json`);
    const partialExportPath = path.join(exportRoot, `${transactionId}.sqlite.partial`);
    const finalExportPath = path.join(exportRoot, `${transactionId}.sqlite`);
    const partialReceiptPath = path.join(receiptRoot, `${transactionId}.partial.json`);
    const finalReceiptPath = path.join(receiptRoot, `${transactionId}.json`);
    const hasClaim = pathEntryExists(claimPath);
    const planPath = hasClaim ? claimPath : pendingPath;
    if (!pathEntryExists(planPath)) fail('attempted routing export has no retained exact plan');
    const plan = validateRoutingCalibrationExportPlan(JSON.parse(fs.readFileSync(
      safePrivateFile(planPath, 'retained routing export plan').resolved,
      'utf8',
    )));
    if (plan.transactionId !== transactionId) {
      fail('retained routing export plan transaction identity is inconsistent');
    }
    if (hasClaim && pathEntryExists(pendingPath)) {
      const pendingPlan = validateRoutingCalibrationExportPlan(JSON.parse(fs.readFileSync(
        safePrivateFile(pendingPath, 'retained pending export plan').resolved,
        'utf8',
      )));
      if (canonicalJson(pendingPlan) !== canonicalJson(plan)) {
        fail('retained pending and claimed routing export plans differ');
      }
    }

    if (pathEntryExists(finalReceiptPath)) {
      if (!hasClaim || !pathEntryExists(evidencePath) || !pathEntryExists(finalExportPath)
          || pathEntryExists(partialExportPath) || !pathEntryExists(partialReceiptPath)) {
        fail('final routing export state has missing or ambiguous partial/final dependencies');
      }
      const evidence = JSON.parse(fs.readFileSync(
        safePrivateFile(evidencePath, 'final routing export evidence').resolved,
        'utf8',
      ));
      const partial = validateRoutingCalibrationExportPartialReceipt(
        JSON.parse(fs.readFileSync(
          safePrivateFile(partialReceiptPath, 'final routing export partial receipt').resolved,
          'utf8',
        )),
        plan,
      );
      if (partial.status !== 'exported_pending_post_health'
          || canonicalJson(partial.evidence) !== canonicalJson(evidence)) {
        fail('final routing export has contradictory partial evidence');
      }
      validateRoutingCalibrationExportReceipt(
        JSON.parse(fs.readFileSync(
          safePrivateFile(finalReceiptPath, 'final routing export receipt').resolved,
          'utf8',
        )),
        plan,
        evidence,
      );
      verifyRoutingCalibrationExport({
        plan,
        evidence,
        releaseDir: input.releaseDir,
        outputPath: finalExportPath,
      });
      continue;
    }

    if (!pathEntryExists(partialReceiptPath)) {
      fail('attempted routing export has no terminal failed receipt');
    }
    const partial = validateRoutingCalibrationExportPartialReceipt(
      JSON.parse(fs.readFileSync(
        safePrivateFile(partialReceiptPath, 'partial routing export receipt').resolved,
        'utf8',
      )),
      plan,
    );
    if (partial.status !== 'failed') {
      fail('attempted routing export has a nonterminal partial receipt');
    }
    const hasEvidence = pathEntryExists(evidencePath);
    const outputCandidates = [partialExportPath, finalExportPath].filter(pathEntryExists);
    if (partial.evidence === null) {
      if (hasEvidence || outputCandidates.length !== 0) {
        fail('failed routing export has unbound evidence or output bytes');
      }
      continue;
    }
    if (!hasClaim) {
      fail('failed routing export with evidence has no durable one-shot claim');
    }
    if (!hasEvidence || outputCandidates.length !== 1) {
      fail('failed routing export evidence is incomplete or ambiguous');
    }
    const evidence = JSON.parse(fs.readFileSync(
      safePrivateFile(evidencePath, 'failed routing export evidence').resolved,
      'utf8',
    ));
    if (canonicalJson(evidence) !== canonicalJson(partial.evidence)) {
      fail('failed routing export receipt differs from retained export evidence');
    }
    verifyRoutingCalibrationExport({
      plan,
      evidence,
      releaseDir: input.releaseDir,
      outputPath: outputCandidates[0],
    });
  }
  return { attemptedTransactions: attemptedIds.size, status: 'resolved' };
}

function recoverInterruptedPrivatePublication(input) {
  const prefixes = [
    `.${path.basename(input.destinationPath)}.next-`,
    `.${path.basename(input.destinationPath)}.replace-`,
  ];
  const orphanCandidates = fs.readdirSync(input.parentPath)
    .filter((name) => prefixes.some((prefix) => name.startsWith(prefix)))
    .map((name) => {
      const filename = path.join(input.parentPath, name);
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink()
          || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
          || (stat.mode & 0o777) !== PRIVATE_FILE_MODE) {
        fail('interrupted publication alias is not private and operator-owned');
      }
      return { filename, stat };
    });
  let destinationStat;
  try {
    destinationStat = fs.lstatSync(input.destinationPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      if (orphanCandidates.some(({ stat }) => stat.nlink !== 1)) {
        fail('unpublished private temporary file has an unexpected hard link');
      }
      for (const { filename } of orphanCandidates) fs.unlinkSync(filename);
      if (orphanCandidates.length !== 0) {
        const parentDescriptor = fs.openSync(input.parentPath, 'r');
        try { fs.fsyncSync(parentDescriptor); } finally { fs.closeSync(parentDescriptor); }
        return 'discarded_unpublished_temporary';
      }
      return 'absent';
    }
    throw error;
  }
  if (!destinationStat.isFile() || destinationStat.isSymbolicLink()
      || (typeof process.getuid === 'function' && destinationStat.uid !== process.getuid())
      || (destinationStat.mode & 0o777) !== PRIVATE_FILE_MODE) {
    fail('existing published evidence is not a private ordinary file');
  }
  if (destinationStat.nlink === 1) {
    if (orphanCandidates.some(({ stat }) => stat.nlink !== 1)) {
      fail('private publication has an unrelated hard-linked temporary file');
    }
    for (const { filename } of orphanCandidates) fs.unlinkSync(filename);
    if (orphanCandidates.length !== 0) {
      const parentDescriptor = fs.openSync(input.parentPath, 'r');
      try { fs.fsyncSync(parentDescriptor); } finally { fs.closeSync(parentDescriptor); }
      return 'discarded_unpublished_temporary';
    }
    return 'intact';
  }

  // Publication is an exclusive hard-link followed by unlinking the private
  // temporary name. A process crash in that two-call window leaves both names
  // on the same inode. Recover only that exact, fully enumerable orphan pair;
  // any unaccounted hard link remains a fail-closed condition.
  const descriptor = fs.openSync(
    input.destinationPath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const anchor = fs.fstatSync(descriptor);
    const anchoredBytes = fs.readFileSync(descriptor);
    if (!sameFileIdentity(anchor, destinationStat)
        || anchor.nlink !== destinationStat.nlink
        || (input.sourceBytes !== undefined && !anchoredBytes.equals(input.sourceBytes))) {
      fail('interrupted publication destination differs from exact retry bytes');
    }
    const aliases = [];
    const unrelated = [];
    for (const { filename, stat } of orphanCandidates) {
      if (sameFileIdentity(stat, anchor)) aliases.push(filename);
      else unrelated.push({ filename, stat });
    }
    if (aliases.length === 0 || anchor.nlink !== aliases.length + 1) {
      fail('published evidence has an unaccounted hard-link identity');
    }
    if (unrelated.some(({ stat }) => stat.nlink !== 1)) {
      fail('private publication has an unrelated hard-linked temporary file');
    }
    for (const alias of aliases) fs.unlinkSync(alias);
    for (const { filename } of unrelated) fs.unlinkSync(filename);
    const parentDescriptor = fs.openSync(input.parentPath, 'r');
    try { fs.fsyncSync(parentDescriptor); } finally { fs.closeSync(parentDescriptor); }
    const after = fs.fstatSync(descriptor);
    const pathAfter = fs.lstatSync(input.destinationPath);
    if (!sameFileIdentity(anchor, after) || !sameFileIdentity(after, pathAfter)
        || after.nlink !== 1 || pathAfter.nlink !== 1) {
      fail('interrupted publication recovery did not converge to one exact link');
    }
    return 'recovered';
  } finally {
    fs.closeSync(descriptor);
  }
}

export function recoverPrivateEvidencePublication(input) {
  const parent = safePrivateDirectory(
    path.dirname(path.resolve(input.destinationPath)),
    'publication recovery directory',
  );
  const destinationPath = path.join(
    parent.resolved,
    path.basename(path.resolve(input.destinationPath)),
  );
  const status = recoverInterruptedPrivatePublication({
    parentPath: parent.resolved,
    destinationPath,
  });
  if (pathEntryExists(destinationPath)) {
    safePrivateFile(destinationPath, 'recovered private evidence');
  }
  return { status, destinationPath };
}

function canonicalPlanDigest(body) {
  return sha256Digest(canonicalJson(body));
}

function assertNoSymlinkPathComponents(filename, label) {
  const absolute = path.resolve(filename);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) fail(`${label} contains a symbolic-link path component`);
  }
}

export function safePrivateFile(filename, label) {
  const unresolved = path.resolve(filename);
  assertNoSymlinkPathComponents(unresolved, label);
  const unresolvedStat = fs.lstatSync(unresolved);
  if (!unresolvedStat.isFile() || unresolvedStat.isSymbolicLink()
      || unresolvedStat.nlink !== 1) {
    fail(`${label} must be an ordinary single-link file`);
  }
  const resolved = fs.realpathSync(unresolved);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.dev !== unresolvedStat.dev || stat.ino !== unresolvedStat.ino) {
    fail(`${label} identity changed while resolving it`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    fail(`${label} must be owned by the current operator`);
  }
  if ((stat.mode & 0o777) !== PRIVATE_FILE_MODE) {
    fail(`${label} must have exact mode 0600`);
  }
  return { resolved, stat };
}

export function safePrivateDirectory(directory, label) {
  const unresolved = path.resolve(directory);
  assertNoSymlinkPathComponents(unresolved, label);
  const unresolvedStat = fs.lstatSync(unresolved);
  if (!unresolvedStat.isDirectory() || unresolvedStat.isSymbolicLink()) {
    fail(`${label} must be an ordinary directory`);
  }
  const resolved = fs.realpathSync(unresolved);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || stat.dev !== unresolvedStat.dev || stat.ino !== unresolvedStat.ino) {
    fail(`${label} identity changed while resolving it`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    fail(`${label} must be owned by the current operator`);
  }
  if ((stat.mode & 0o077) !== 0) fail(`${label} must not be group/world accessible`);
  return { resolved, stat };
}

export function safeOwnerControlledDirectory(directory, label) {
  const unresolved = path.resolve(directory);
  assertNoSymlinkPathComponents(unresolved, label);
  const unresolvedStat = fs.lstatSync(unresolved);
  if (!unresolvedStat.isDirectory() || unresolvedStat.isSymbolicLink()) {
    fail(`${label} must be an ordinary directory`);
  }
  const resolved = fs.realpathSync(unresolved);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || stat.dev !== unresolvedStat.dev || stat.ino !== unresolvedStat.ino) {
    fail(`${label} identity changed while resolving it`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    fail(`${label} must be owned by the current operator`);
  }
  if ((stat.mode & 0o022) !== 0) fail(`${label} must not be group/world writable`);
  return { resolved, stat };
}

function databaseConstructor(releaseDir) {
  const packageFile = path.join(path.resolve(releaseDir), 'package.json');
  const require = createRequire(fs.existsSync(packageFile) ? packageFile : import.meta.url);
  return require('better-sqlite3');
}

function tableExists(db, table) {
  return db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table) !== undefined;
}

function assertSourceSchema(db) {
  for (const [table, expectedColumns] of Object.entries(SOURCE_TABLE_COLUMNS)) {
    if (!tableExists(db, table)) fail(`source routing schema is missing ${table}`);
    const observedColumns = db.pragma(`table_info(${table})`).map((column) => [
      String(column.name),
      String(column.type).toUpperCase(),
      Number(column.notnull),
      Number(column.pk),
    ]);
    if (canonicalJson(observedColumns) !== canonicalJson(expectedColumns)) {
      fail(`source routing table schema differs from the approved contract: ${table}`);
    }
  }
  const protectedNames = Object.keys(SOURCE_TABLE_COLUMNS);
  const unsafeSchemaObjects = db.prepare(`
    SELECT type, name, sql
    FROM sqlite_master
    WHERE type IN ('trigger', 'view')
    ORDER BY type ASC, name ASC
  `).all().filter((entry) => {
    const sql = String(entry.sql ?? '').toLowerCase();
    return protectedNames.some((table) => sql.includes(table));
  });
  if (unsafeSchemaObjects.length !== 0) {
    fail('source routing tables are observed by an unexpected trigger or view');
  }
}

function sqliteSchemaContract(db) {
  const objects = db.prepare(`
    SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_master
    ORDER BY type ASC, name ASC
  `).all().map((entry) => ({
    type: String(entry.type),
    name: String(entry.name),
    tableName: String(entry.tableName),
    sql: entry.sql === null ? null : String(entry.sql),
  }));
  const tableInfo = {};
  for (const table of [...Object.keys(SOURCE_TABLE_COLUMNS), 'sqlite_sequence']) {
    tableInfo[table] = db.pragma(`table_info(${table})`).map((column) => ({
      name: String(column.name),
      type: String(column.type).toUpperCase(),
      notNull: Number(column.notnull),
      defaultValue: column.dflt_value === null ? null : String(column.dflt_value),
      primaryKey: Number(column.pk),
    }));
  }
  const indexes = {};
  for (const table of Object.keys(SOURCE_TABLE_COLUMNS)) {
    indexes[table] = db.pragma(`index_list(${table})`).map((index) => ({
      name: String(index.name),
      unique: Number(index.unique),
      origin: String(index.origin),
      partial: Number(index.partial),
      columns: db.pragma(`index_info(${index.name})`)
        .map((column) => String(column.name)),
    })).sort((left, right) => left.name.localeCompare(right.name));
  }
  return { objects, tableInfo, indexes };
}

export function assertSanitizedSchema(db, Database) {
  const expected = new Database(':memory:');
  try {
    expected.exec(ROUTING_CALIBRATION_SANITIZED_SCHEMA);
    if (canonicalJson(sqliteSchemaContract(db))
        !== canonicalJson(sqliteSchemaContract(expected))) {
      fail('sanitized export SQLite schema differs from the exact routing-only contract');
    }
  } finally {
    expected.close();
  }
}

function mapCorpusRow(row) {
  return {
    id: Number(row.id),
    tenantId: Number(row.tenantId),
    userId: row.userId === null ? null : Number(row.userId),
    utteranceHash: String(row.utteranceHash),
    utteranceText: row.utteranceText === null ? null : String(row.utteranceText),
    source: String(row.source),
    suggestedDomain: row.suggestedDomain === null ? null : String(row.suggestedDomain),
    suggestedSkill: row.suggestedSkill === null ? null : String(row.suggestedSkill),
    labelDomain: row.labelDomain === null ? null : String(row.labelDomain),
    labelSkill: row.labelSkill === null ? null : String(row.labelSkill),
    labelStatus: String(row.labelStatus),
    labeledAt: row.labeledAt === null ? null : String(row.labeledAt),
    createdAt: String(row.createdAt),
  };
}

function readCorpusRows(db) {
  return db.prepare(`
    SELECT
      id,
      tenant_id AS tenantId,
      user_id AS userId,
      utterance_hash AS utteranceHash,
      utterance_text AS utteranceText,
      source,
      suggested_domain AS suggestedDomain,
      suggested_skill AS suggestedSkill,
      label_domain AS labelDomain,
      label_skill AS labelSkill,
      label_status AS labelStatus,
      labeled_at AS labeledAt,
      created_at AS createdAt
    FROM routing_corpus_items
    ORDER BY created_at ASC, id ASC
  `).all().map(mapCorpusRow);
}

function validateApprovedCorpus(allRows, isApprovedSyntheticItem) {
  if (typeof isApprovedSyntheticItem !== 'function') {
    fail('approved synthetic corpus predicate is unavailable');
  }
  const approved = allRows.filter((row) => isApprovedSyntheticItem(row));
  if (approved.length !== EXPECTED_CORPUS_ROWS) {
    fail(`expected exactly ${EXPECTED_CORPUS_ROWS} approved synthetic corpus rows; found ${approved.length}`);
  }
  for (const row of approved) {
    if (row.tenantId !== 0 || row.userId !== null
        || !['bilingual_fixture', 'manual'].includes(row.source)
        || row.labelStatus !== 'labeled' || row.labelDomain === null
        || row.labeledAt === null || row.utteranceText === null
        || !/^[a-f0-9]{64}$/u.test(row.utteranceHash)) {
      fail('approved synthetic corpus row is not fully labeled or has unsafe provenance');
    }
  }
  const replayable = allRows.filter((row) => (
    row.labelStatus === 'labeled' && row.utteranceText !== null
  ));
  if (replayable.length !== EXPECTED_CORPUS_ROWS
      || replayable.some((row, index) => row.id !== approved[index]?.id)) {
    fail('complete labeled corpus differs from the exact approved 300-row synthetic corpus');
  }
  return approved;
}

export function routingCalibrationCorpusIdentityDigest(rows) {
  const ordered = [...rows].sort((left, right) => (
    String(left.createdAt).localeCompare(String(right.createdAt))
      || Number(left.id) - Number(right.id)
  ));
  const identity = ordered.map((item) => ({
    id: Number(item.id),
    tenantId: Number(item.tenantId),
    userId: item.userId === null ? null : Number(item.userId),
    utteranceHash: String(item.utteranceHash),
    utteranceTextSha256: createHash('sha256')
      .update(item.utteranceText ?? '')
      .digest('hex'),
    source: String(item.source),
    labelDomain: item.labelDomain === null ? null : String(item.labelDomain),
    labelSkill: item.labelSkill === null ? null : String(item.labelSkill),
    labelStatus: String(item.labelStatus),
    labeledAt: item.labeledAt === null ? null : String(item.labeledAt),
  }));
  return sha256Digest(JSON.stringify(identity));
}

export function routingCalibrationCacheRowsDigest(rows) {
  const identity = [...rows]
    .sort((left, right) => String(left.utteranceHash).localeCompare(String(right.utteranceHash)))
    .map((row) => ({
      utteranceHash: String(row.utteranceHash),
      domain: String(row.domain),
      confidence: Number(row.confidence),
    }));
  return sha256Digest(canonicalJson(identity));
}

function readMatchingCacheRows(db, corpusRows, isApprovedCacheDomain) {
  if (typeof isApprovedCacheDomain !== 'function') {
    fail('governed routing-cache domain predicate is unavailable');
  }
  const hashes = corpusRows.map((row) => row.utteranceHash);
  const placeholders = hashes.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT
      utterance_hash AS utteranceHash,
      domain,
      confidence,
      model,
      created_at AS createdAt
    FROM routing_llm_classify_cache
    WHERE utterance_hash IN (${placeholders})
    ORDER BY utterance_hash ASC
  `).all(...hashes).map((row) => ({
    utteranceHash: String(row.utteranceHash),
    domain: String(row.domain),
    confidence: Number(row.confidence),
    model: row.model === null ? null : String(row.model),
    createdAt: String(row.createdAt),
  }));
  for (const row of rows) {
    if (!/^[a-f0-9]{64}$/u.test(row.utteranceHash)
        || row.domain.length === 0
        || !isApprovedCacheDomain(row.domain)
        || !Number.isFinite(row.confidence)
        || row.confidence < 0 || row.confidence > 1) {
      fail('matching LLM-cache row is invalid');
    }
  }
  if (rows.length > corpusRows.length) fail('matching LLM-cache coverage exceeds corpus size');
  return rows;
}

function readAcceptedSnapshot(
  db,
  corpusIdentityDigest,
  cacheRows,
  parseAcceptedSnapshot,
) {
  const count = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM accepted_accuracy_snapshots WHERE accepted = 1
  `).get().count);
  if (!Number.isSafeInteger(count) || count < 1) {
    fail('an accepted routing-accuracy snapshot is required');
  }
  const row = db.prepare(`
    SELECT id, created_at AS createdAt, snapshot_json AS snapshotJson
    FROM accepted_accuracy_snapshots
    WHERE accepted = 1
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get();
  if (typeof parseAcceptedSnapshot !== 'function') {
    fail('canonical accepted routing-accuracy snapshot validator is unavailable');
  }
  let snapshot;
  try {
    snapshot = parseAcceptedSnapshot(row.snapshotJson);
  } catch {
    fail('accepted routing-accuracy snapshot is invalid under the canonical contract');
  }
  if (snapshot === null) fail('an accepted routing-accuracy snapshot is required');
  const llmSurface = Array.isArray(snapshot?.surfaces)
    ? snapshot.surfaces.find((surface) => surface?.surface === 'llm_classify_cache')
    : undefined;
  if (snapshot?.version !== 'routing-accuracy@1.1.0'
      || snapshot?.itemCount !== EXPECTED_CORPUS_ROWS
      || snapshot?.corpusIdentityDigest !== corpusIdentityDigest
      || !Number.isSafeInteger(llmSurface?.covered)
      || llmSurface.covered !== cacheRows
      || llmSurface.uncovered !== EXPECTED_CORPUS_ROWS - cacheRows) {
    fail('accepted routing-accuracy snapshot does not bind the exact approved corpus');
  }
  return {
    acceptedRows: count,
    latestId: Number(row.id),
    jsonSha256: sha256Digest(row.snapshotJson),
    itemCount: snapshot.itemCount,
    llmCacheCovered: llmSurface.covered,
    corpusIdentityDigest: snapshot.corpusIdentityDigest,
  };
}

function linuxFileDescriptors() {
  if (process.platform !== 'linux' || !fs.existsSync('/proc/self/fd')) return null;
  const descriptors = new Map();
  for (const entry of fs.readdirSync('/proc/self/fd')) {
    if (!/^\d+$/u.test(entry)) continue;
    const descriptor = Number(entry);
    try {
      const stat = fs.fstatSync(descriptor);
      descriptors.set(descriptor, { dev: stat.dev, ino: stat.ino });
    } catch {
      // The descriptor used to enumerate `/proc/self/fd` closes immediately.
    }
  }
  return descriptors;
}

export function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export function findAnchoredSqliteDescriptor(
  descriptorsBefore,
  descriptorsAfter,
  anchorDescriptor,
  anchorStat,
) {
  for (const [descriptor, identity] of descriptorsAfter) {
    const previous = descriptorsBefore.get(descriptor);
    if ((previous && sameFileIdentity(previous, identity))
        || descriptor === anchorDescriptor) continue;
    if (sameFileIdentity(identity, anchorStat)) return descriptor;
  }
  return null;
}

function assertAnchoredDatabaseIdentity(input) {
  const { anchorStat, sqliteDescriptor, sourcePath } = input;
  const anchorNow = fs.fstatSync(input.anchorDescriptor);
  const sourceNow = fs.lstatSync(sourcePath);
  const sqliteNow = sqliteDescriptor === null ? anchorNow : fs.fstatSync(sqliteDescriptor);
  if (!anchorNow.isFile() || !sourceNow.isFile() || sourceNow.isSymbolicLink()
      || !sqliteNow.isFile() || anchorNow.nlink !== 1 || sourceNow.nlink !== 1
      || sqliteNow.nlink !== 1 || !sameFileIdentity(anchorStat, anchorNow)
      || !sameFileIdentity(anchorNow, sourceNow)
      || !sameFileIdentity(anchorNow, sqliteNow)
      || (sourceNow.mode & 0o777) !== PRIVATE_FILE_MODE
      || (anchorNow.mode & 0o777) !== PRIVATE_FILE_MODE
      || (sqliteNow.mode & 0o777) !== PRIVATE_FILE_MODE) {
    fail('production database path, anchor, or SQLite main descriptor changed identity');
  }
}

function captureSourceSnapshot(input, callback) {
  const { resolved: dbPath, stat } = safePrivateFile(input.dbPath, 'production database');
  const anchorDescriptor = fs.openSync(
    dbPath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  const anchorStat = fs.fstatSync(anchorDescriptor);
  if (!sameFileIdentity(anchorStat, stat)) {
    fs.closeSync(anchorDescriptor);
    fail('production database changed before its read-only anchor opened');
  }
  const descriptorsBeforeSqlite = linuxFileDescriptors();
  let db;
  let sqliteDescriptor = null;
  try {
    input.afterSourceAnchorOpened?.({ dbPath, anchorDescriptor });
    const Database = databaseConstructor(input.releaseDir);
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('query_only = ON');
    db.exec('BEGIN');
    if (descriptorsBeforeSqlite !== null) {
      sqliteDescriptor = findAnchoredSqliteDescriptor(
        descriptorsBeforeSqlite,
        linuxFileDescriptors(),
        anchorDescriptor,
        anchorStat,
      );
      if (sqliteDescriptor === null) {
        fail('could not attest the live SQLite main-database descriptor');
      }
    }
    assertAnchoredDatabaseIdentity({
      anchorDescriptor,
      anchorStat,
      sqliteDescriptor,
      sourcePath: dbPath,
    });
    assertSourceSchema(db);
    const integrity = db.pragma('integrity_check');
    const foreignKeys = db.pragma('foreign_key_check');
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      fail('production database integrity check failed');
    }
    if (foreignKeys.length !== 0) fail('production database foreign-key check failed');
    const corpusRows = validateApprovedCorpus(
      readCorpusRows(db),
      input.isApprovedSyntheticItem,
    );
    const corpusIdentityDigest = routingCalibrationCorpusIdentityDigest(corpusRows);
    const cacheRows = readMatchingCacheRows(
      db,
      corpusRows,
      input.isApprovedCacheDomain,
    );
    const acceptedSnapshot = readAcceptedSnapshot(
      db,
      corpusIdentityDigest,
      cacheRows.length,
      input.parseAcceptedSnapshot,
    );
    const state = {
      database: {
        path: dbPath,
        device: String(stat.dev),
        inode: String(stat.ino),
        mode: (stat.mode & 0o777).toString(8).padStart(4, '0'),
        integrity: 'ok',
        foreignKeys: 'ok',
      },
      corpus: {
        rows: corpusRows.length,
        identityDigest: corpusIdentityDigest,
      },
      cache: {
        rows: cacheRows.length,
        corpusRows: corpusRows.length,
        coverage: cacheRows.length / corpusRows.length,
        complete: cacheRows.length === corpusRows.length,
        rowsDigest: routingCalibrationCacheRowsDigest(cacheRows),
      },
      acceptedSnapshot,
    };
    const result = callback({ db, state, corpusRows, cacheRows });
    input.beforeSourceSnapshotComplete?.({ dbPath, anchorDescriptor });
    assertAnchoredDatabaseIdentity({
      anchorDescriptor,
      anchorStat,
      sqliteDescriptor,
      sourcePath: dbPath,
    });
    return result;
  } finally {
    if (db?.inTransaction) db.exec('ROLLBACK');
    db?.close();
    fs.closeSync(anchorDescriptor);
  }
}

function assertPreflight(preflight, releaseDir, runtimeSha, artifactDigest) {
  assertExactKeys(
    preflight,
    ['selector', 'health', 'pm2'],
    'export preflight',
  );
  if (fs.realpathSync(preflight.selector) !== releaseDir) {
    fail('preflight selector does not bind the exact release');
  }
  assertAttestationPair(
    {
      ...preflight,
      healthSha256: sha256Digest(canonicalJson(preflight.health)),
      pm2Sha256: sha256Digest(canonicalJson(preflight.pm2)),
    },
    releaseDir,
    runtimeSha,
    artifactDigest,
    'preflight',
  );
}

function assertAttestationPair(
  evidence,
  releaseDir,
  runtimeSha,
  artifactDigest,
  label,
) {
  assertExactKeys(evidence.health, [
    'schema', 'status', 'database', 'databaseProbe', 'contentHealth',
    'role', 'runtimeSha', 'artifactDigest', 'releaseAttestationSchema',
  ], `${label} health evidence`);
  assertExactKeys(evidence.pm2, [
    'schema', 'role', 'runtimeSha', 'artifactDigest', 'processes',
  ], `${label} PM2 evidence`);
  const expectedRuntimeSha = runtimeSha ?? evidence.health.runtimeSha;
  const expectedArtifactDigest = artifactDigest ?? evidence.health.artifactDigest;
  if (evidence.health.schema !== 'nexus.routing-calibration-export-health-evidence.v1'
      || evidence.health.status !== 'healthy'
      || evidence.health.database !== 'connected'
      || evidence.health.databaseProbe !== 'connected'
      || evidence.health.contentHealth !== 'passed'
      || evidence.health.role !== 'production'
      || evidence.health.runtimeSha !== expectedRuntimeSha
      || evidence.health.artifactDigest !== expectedArtifactDigest
      || evidence.health.releaseAttestationSchema
        !== 'nexus.chat-capability-release-attestation.v2') {
    fail(`${label} health evidence is invalid`);
  }
  if (evidence.pm2.schema !== 'nexus.routing-calibration-export-pm2-evidence.v1'
      || evidence.pm2.role !== 'production'
      || evidence.pm2.runtimeSha !== expectedRuntimeSha
      || evidence.pm2.artifactDigest !== expectedArtifactDigest
      || !Array.isArray(evidence.pm2.processes)
      || evidence.pm2.processes.length !== 2) {
    fail(`${label} PM2 evidence is invalid`);
  }
  const expectedProcesses = new Set(['content-engine', 'nexus-hub']);
  for (const processEvidence of evidence.pm2.processes) {
    assertExactKeys(processEvidence, [
      'name', 'status', 'cwd', 'runtimeSha', 'artifactDigest',
    ], `${label} PM2 process evidence`);
    const expectedCwd = processEvidence.name === 'content-engine'
      ? `${releaseDir}/content-engine`
      : releaseDir;
    if (!expectedProcesses.delete(processEvidence.name)
        || processEvidence.status !== 'online'
        || processEvidence.runtimeSha !== expectedRuntimeSha
        || processEvidence.artifactDigest !== expectedArtifactDigest
        || processEvidence.cwd !== expectedCwd) {
      fail(`${label} PM2 process evidence is invalid`);
    }
  }
  if (expectedProcesses.size !== 0) fail(`${label} PM2 process set is incomplete`);
  assertDigest(evidence.healthSha256, `${label} health digest`);
  assertDigest(evidence.pm2Sha256, `${label} PM2 digest`);
  if (evidence.healthSha256 !== sha256Digest(canonicalJson(evidence.health))
      || evidence.pm2Sha256 !== sha256Digest(canonicalJson(evidence.pm2))) {
    fail(`${label} attestation digest does not match its persisted evidence`);
  }
}

function inspectBody(input) {
  assertIdentity(input);
  assertCanonicalTimestamp(input.generatedAt, 'generatedAt');
  assertCanonicalTimestamp(input.expiresAt, 'expiresAt');
  const generatedMs = Date.parse(input.generatedAt);
  const expiresMs = Date.parse(input.expiresAt);
  if (expiresMs <= generatedMs || expiresMs - generatedMs > MAXIMUM_PLAN_TTL_MS) {
    fail('plan expiry must follow generation by no more than one hour');
  }
  if (generatedMs > Date.now() + MAXIMUM_CLOCK_SKEW_MS
      || Date.now() - generatedMs > MAXIMUM_PLAN_TTL_MS) {
    fail('plan generation timestamp is expired or unreasonably future-dated');
  }
  if (!Number.isSafeInteger(input.planSequence) || input.planSequence < 1) {
    fail('plan sequence must be a positive safe integer');
  }
  assertDigest(input.operatorSha256, 'operator digest');
  assertDigest(input.helperSha256, 'helper digest');
  const releaseDir = fs.realpathSync(input.releaseDir);
  if (!fs.lstatSync(releaseDir).isDirectory()) fail('release directory is unavailable');
  assertPreflight(input.preflight, releaseDir, input.runtimeSha, input.artifactDigest);
  const productionBase = safeOwnerControlledDirectory(
    input.productionBaseDir,
    'production base directory',
  );
  const sourceDataRoot = safePrivateDirectory(
    path.join(productionBase.resolved, 'data'),
    'production data directory',
  );
  const expectedDatabasePath = path.join(sourceDataRoot.resolved, 'bot.db');
  const canonicalDatabasePath = fs.realpathSync(input.dbPath);
  if (canonicalDatabasePath !== expectedDatabasePath) {
    fail('source database is outside the exact production data path');
  }
  const exportRoot = safePrivateDirectory(input.exportRoot, 'export output directory');
  const unresolvedOutputPath = path.resolve(input.outputPath);
  const outputParent = fs.realpathSync(path.dirname(unresolvedOutputPath));
  if (outputParent !== exportRoot.resolved) {
    fail('export output is not one direct child of the protected export root');
  }
  const outputPath = path.join(outputParent, path.basename(unresolvedOutputPath));
  if (fs.existsSync(outputPath) || (() => {
    try { return fs.lstatSync(outputPath).isSymbolicLink(); } catch { return false; }
  })()) fail('export output path already exists');

  return captureSourceSnapshot(input, ({ state }) => ({
    schema: ROUTING_CALIBRATION_EXPORT_PLAN_SCHEMA,
    operation: 'export_sanitized_routing_calibration_corpus',
    role: 'production',
    runtimeSha: input.runtimeSha,
    artifactDigest: input.artifactDigest,
    transactionId: input.transactionId,
    planSequence: input.planSequence,
    releaseDir,
    operatorSha256: input.operatorSha256,
    helperSha256: input.helperSha256,
    preflight: {
      selector: releaseDir,
      health: input.preflight.health,
      healthSha256: sha256Digest(canonicalJson(input.preflight.health)),
      pm2: input.preflight.pm2,
      pm2Sha256: sha256Digest(canonicalJson(input.preflight.pm2)),
    },
    containment: {
      productionBaseDir: productionBase.resolved,
      sourceDataRoot: sourceDataRoot.resolved,
      sourceDataRootDevice: String(sourceDataRoot.stat.dev),
      sourceDataRootInode: String(sourceDataRoot.stat.ino),
      sourceDatabasePath: canonicalDatabasePath,
      exportRoot: exportRoot.resolved,
      exportRootDevice: String(exportRoot.stat.dev),
      exportRootInode: String(exportRoot.stat.ino),
    },
    ...state,
    normalization: {
      createdAtBase: NORMALIZED_CREATED_AT_BASE,
      createdAtOrder: 'source_corpus_order_then_cache_hash_order',
      preserveLabeledAt: true,
      suggestedFields: null,
      providerModel: null,
    },
    output: {
      path: outputPath,
      mode: '0600',
      corpusRows: EXPECTED_CORPUS_ROWS,
      cacheRows: state.cache.rows,
      acceptedSnapshotRows: 0,
    },
    providerCalls: 0,
    generatedAt: input.generatedAt,
    expiresAt: input.expiresAt,
  }));
}

export function inspectRoutingCalibrationExport(input) {
  const body = inspectBody(input);
  return { ...body, planDigest: canonicalPlanDigest(body) };
}

export function validateRoutingCalibrationExportPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) fail('export plan is invalid');
  assertExactKeys(plan, [
    'schema', 'operation', 'role', 'runtimeSha', 'artifactDigest',
    'transactionId', 'planSequence', 'releaseDir', 'operatorSha256',
    'helperSha256', 'preflight', 'containment', 'database', 'corpus',
    'cache', 'acceptedSnapshot', 'normalization', 'output', 'providerCalls',
    'generatedAt', 'expiresAt', 'planDigest',
  ], 'routing-calibration export plan');
  assertExactKeys(plan.preflight, [
    'selector', 'health', 'healthSha256', 'pm2', 'pm2Sha256',
  ], 'plan preflight');
  assertExactKeys(plan.containment, [
    'productionBaseDir', 'sourceDataRoot', 'sourceDataRootDevice',
    'sourceDataRootInode', 'sourceDatabasePath', 'exportRoot',
    'exportRootDevice', 'exportRootInode',
  ], 'plan containment');
  assertExactKeys(plan.database, [
    'path', 'device', 'inode', 'mode', 'integrity', 'foreignKeys',
  ], 'plan database');
  assertExactKeys(plan.corpus, ['rows', 'identityDigest'], 'plan corpus');
  assertExactKeys(plan.cache, [
    'rows', 'corpusRows', 'coverage', 'complete', 'rowsDigest',
  ], 'plan cache');
  assertExactKeys(plan.acceptedSnapshot, [
    'acceptedRows', 'latestId', 'jsonSha256', 'itemCount',
    'llmCacheCovered', 'corpusIdentityDigest',
  ], 'plan accepted snapshot');
  assertExactKeys(plan.normalization, [
    'createdAtBase', 'createdAtOrder', 'preserveLabeledAt',
    'suggestedFields', 'providerModel',
  ], 'plan normalization');
  assertExactKeys(plan.output, [
    'path', 'mode', 'corpusRows', 'cacheRows', 'acceptedSnapshotRows',
  ], 'plan output');
  const { planDigest, ...body } = plan;
  if (plan.schema !== ROUTING_CALIBRATION_EXPORT_PLAN_SCHEMA
      || plan.operation !== 'export_sanitized_routing_calibration_corpus'
      || plan.role !== 'production' || plan.corpus?.rows !== EXPECTED_CORPUS_ROWS
      || plan.database?.path !== plan.containment?.sourceDatabasePath
      || plan.database?.mode !== '0600' || plan.database?.integrity !== 'ok'
      || plan.database?.foreignKeys !== 'ok'
      || plan.cache?.corpusRows !== EXPECTED_CORPUS_ROWS
      || !Number.isSafeInteger(plan.cache?.rows) || plan.cache.rows < 0
      || plan.cache.rows > EXPECTED_CORPUS_ROWS
      || plan.cache.coverage !== plan.cache.rows / EXPECTED_CORPUS_ROWS
      || plan.cache.complete !== (plan.cache.rows === EXPECTED_CORPUS_ROWS)
      || !Number.isSafeInteger(plan.acceptedSnapshot?.acceptedRows)
      || plan.acceptedSnapshot.acceptedRows < 1
      || !Number.isSafeInteger(plan.acceptedSnapshot?.latestId)
      || plan.acceptedSnapshot.latestId < 1
      || plan.acceptedSnapshot.itemCount !== EXPECTED_CORPUS_ROWS
      || plan.acceptedSnapshot.llmCacheCovered !== plan.cache.rows
      || plan.acceptedSnapshot.corpusIdentityDigest !== plan.corpus.identityDigest
      || plan.output?.corpusRows !== EXPECTED_CORPUS_ROWS
      || plan.output?.cacheRows !== plan.cache?.rows
      || plan.output?.acceptedSnapshotRows !== 0
      || plan.output?.mode !== '0600'
      || plan.providerCalls !== 0
      || !Number.isSafeInteger(plan.planSequence) || plan.planSequence < 1
      || plan.normalization?.createdAtBase !== NORMALIZED_CREATED_AT_BASE
      || plan.normalization?.createdAtOrder
        !== 'source_corpus_order_then_cache_hash_order'
      || plan.normalization?.preserveLabeledAt !== true
      || plan.normalization?.suggestedFields !== null
      || plan.normalization?.providerModel !== null
      || plan.preflight?.selector !== plan.releaseDir
      || path.dirname(plan.output?.path ?? '') !== plan.containment?.exportRoot
      || path.basename(plan.output?.path ?? '') !== `${plan.transactionId}.sqlite`
      || path.dirname(plan.containment?.sourceDataRoot ?? '')
        !== plan.containment?.productionBaseDir
      || path.basename(plan.containment?.sourceDataRoot ?? '') !== 'data'
      || path.dirname(plan.containment?.sourceDatabasePath ?? '')
        !== plan.containment?.sourceDataRoot
      || path.basename(plan.containment?.sourceDatabasePath ?? '') !== 'bot.db'
      || path.basename(plan.releaseDir ?? '')
        !== `${plan.runtimeSha}-${plan.artifactDigest?.slice(0, 12)}`
      || planDigest !== canonicalPlanDigest(body)) {
    fail('routing-calibration export plan schema or digest is invalid');
  }
  assertIdentity(plan);
  assertDigest(plan.corpus?.identityDigest, 'corpus identity digest');
  assertDigest(plan.cache?.rowsDigest, 'cache rows digest');
  assertDigest(plan.acceptedSnapshot?.jsonSha256, 'accepted snapshot digest');
  assertDigest(plan.operatorSha256, 'operator digest');
  assertDigest(plan.helperSha256, 'helper digest');
  assertAttestationPair(
    plan.preflight,
    plan.releaseDir,
    plan.runtimeSha,
    plan.artifactDigest,
    'plan preflight',
  );
  for (const [value, label] of [
    [plan.database.device, 'database device'],
    [plan.database.inode, 'database inode'],
    [plan.containment.sourceDataRootDevice, 'source data-root device'],
    [plan.containment.sourceDataRootInode, 'source data-root inode'],
    [plan.containment.exportRootDevice, 'export-root device'],
    [plan.containment.exportRootInode, 'export-root inode'],
  ]) {
    if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
      fail(`${label} must be an unsigned decimal identity`);
    }
  }
  for (const [value, label] of [
    [plan.releaseDir, 'release directory'],
    [plan.containment.productionBaseDir, 'production base directory'],
    [plan.containment.sourceDataRoot, 'source data directory'],
    [plan.containment.sourceDatabasePath, 'source database path'],
    [plan.containment.exportRoot, 'export root'],
    [plan.output.path, 'export output path'],
  ]) {
    if (typeof value !== 'string' || !path.isAbsolute(value)
        || path.normalize(value) !== value) {
      fail(`${label} must be a normalized absolute path`);
    }
  }
  assertCanonicalTimestamp(plan.generatedAt, 'plan generatedAt');
  assertCanonicalTimestamp(plan.expiresAt, 'plan expiresAt');
  if (Date.parse(plan.expiresAt) - Date.parse(plan.generatedAt) > MAXIMUM_PLAN_TTL_MS
      || Date.parse(plan.expiresAt) <= Date.parse(plan.generatedAt)
      || Date.parse(plan.generatedAt) > Date.now() + MAXIMUM_CLOCK_SKEW_MS) {
    fail('routing-calibration export plan TTL is invalid');
  }
  return plan;
}

function assertSourceContainment(plan, input) {
  const productionBase = safeOwnerControlledDirectory(
    input.productionBaseDir,
    'apply production base directory',
  );
  if (productionBase.resolved !== plan.containment.productionBaseDir) {
    fail('apply production base differs from the reviewed plan');
  }
  const sourceDataRoot = safePrivateDirectory(
    path.join(productionBase.resolved, 'data'),
    'apply production data directory',
  );
  if (sourceDataRoot.resolved !== plan.containment.sourceDataRoot
      || String(sourceDataRoot.stat.dev) !== plan.containment.sourceDataRootDevice
      || String(sourceDataRoot.stat.ino) !== plan.containment.sourceDataRootInode) {
    fail('apply source data directory identity differs from the reviewed plan');
  }
  const databasePath = fs.realpathSync(input.dbPath);
  if (databasePath !== path.join(sourceDataRoot.resolved, 'bot.db')
      || databasePath !== plan.database.path
      || plan.database.path !== plan.containment.sourceDatabasePath) {
    fail('apply source database path differs from the reviewed containment');
  }
}

function comparableState(state) {
  return {
    database: state.database,
    corpus: state.corpus,
    cache: state.cache,
    acceptedSnapshot: state.acceptedSnapshot,
  };
}

function normalizedCreatedAt(index) {
  return new Date(Date.parse(NORMALIZED_CREATED_AT_BASE) + index).toISOString();
}

function createSanitizedDatabase(input) {
  const unresolvedOutputPath = path.resolve(input.partialOutputPath);
  const outputPath = path.join(
    fs.realpathSync(path.dirname(unresolvedOutputPath)),
    path.basename(unresolvedOutputPath),
  );
  const expectedPartial = `${path.resolve(input.plan.output.path)}.partial`;
  if (outputPath !== expectedPartial) fail('partial export path differs from reviewed plan');
  const parentBefore = safePrivateDirectory(
    path.dirname(outputPath),
    'partial export directory',
  );
  if (parentBefore.resolved !== input.plan.containment.exportRoot
      || String(parentBefore.stat.dev) !== input.plan.containment.exportRootDevice
      || String(parentBefore.stat.ino) !== input.plan.containment.exportRootInode) {
    fail('partial export parent identity differs from the reviewed plan');
  }
  for (const candidate of [outputPath, input.plan.output.path]) {
    if (fs.existsSync(candidate) || (() => {
      try { return fs.lstatSync(candidate).isSymbolicLink(); } catch { return false; }
    })()) fail('routing-calibration export output already exists');
  }
  const descriptor = fs.openSync(outputPath, 'wx', PRIVATE_FILE_MODE);
  fs.closeSync(descriptor);
  fs.chmodSync(outputPath, PRIVATE_FILE_MODE);
  const createdStat = fs.lstatSync(outputPath);
  if (!createdStat.isFile() || createdStat.isSymbolicLink() || createdStat.nlink !== 1) {
    fail('new partial export is not an ordinary single-link file');
  }

  const Database = databaseConstructor(input.releaseDir);
  const output = new Database(outputPath);
  try {
    output.pragma('foreign_keys = ON');
    output.exec(ROUTING_CALIBRATION_SANITIZED_SCHEMA);
    const insertCorpus = output.prepare(`
      INSERT INTO routing_corpus_items (
        id, tenant_id, user_id, utterance_hash, utterance_text, source,
        suggested_domain, suggested_skill, label_domain, label_skill,
        label_status, labeled_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)
    `);
    const insertCache = output.prepare(`
      INSERT INTO routing_llm_classify_cache (
        utterance_hash, domain, confidence, model, created_at
      ) VALUES (?, ?, ?, NULL, ?)
    `);
    const write = output.transaction(() => {
      input.corpusRows.forEach((row, index) => {
        insertCorpus.run(
          row.id,
          row.tenantId,
          row.userId,
          row.utteranceHash,
          row.utteranceText,
          row.source,
          row.labelDomain,
          row.labelSkill,
          row.labelStatus,
          row.labeledAt,
          normalizedCreatedAt(index),
        );
      });
      input.cacheRows.forEach((row, index) => {
        insertCache.run(
          row.utteranceHash,
          row.domain,
          row.confidence,
          normalizedCreatedAt(index),
        );
      });
    });
    write.immediate();
  } finally {
    output.close();
  }
  fs.chmodSync(outputPath, PRIVATE_FILE_MODE);
  const sync = fs.openSync(outputPath, 'r');
  try { fs.fsyncSync(sync); } finally { fs.closeSync(sync); }
  const parentAfter = safePrivateDirectory(
    path.dirname(outputPath),
    'post-write partial export directory',
  );
  const outputAfter = fs.lstatSync(outputPath);
  if (parentAfter.resolved !== parentBefore.resolved
      || parentAfter.stat.dev !== parentBefore.stat.dev
      || parentAfter.stat.ino !== parentBefore.stat.ino
      || !outputAfter.isFile() || outputAfter.isSymbolicLink()
      || outputAfter.nlink !== 1 || (outputAfter.mode & 0o777) !== PRIVATE_FILE_MODE) {
    fail('partial export or its parent changed identity after write');
  }
  return outputPath;
}

function inspectSanitizedDatabase(input) {
  const outputParent = safePrivateDirectory(
    path.dirname(path.resolve(input.outputPath)),
    'sanitized export parent',
  );
  if (input.copiedEvidence !== true
      && (outputParent.resolved !== input.plan.containment.exportRoot
        || String(outputParent.stat.dev) !== input.plan.containment.exportRootDevice
        || String(outputParent.stat.ino) !== input.plan.containment.exportRootInode)) {
    fail('sanitized export parent identity differs from the reviewed plan');
  }
  const { resolved: outputPath, stat } = safePrivateFile(input.outputPath, 'sanitized export');
  const Database = databaseConstructor(input.releaseDir);
  const output = new Database(outputPath, { readonly: true, fileMustExist: true });
  try {
    output.pragma('query_only = ON');
    assertSanitizedSchema(output, Database);
    const tables = output.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name ASC
    `).all().map((row) => row.name);
    if (JSON.stringify(tables) !== JSON.stringify([
      'accepted_accuracy_snapshots',
      'routing_corpus_items',
      'routing_llm_classify_cache',
    ])) fail('sanitized export contains unexpected application tables');
    const integrity = output.pragma('integrity_check');
    const foreignKeys = output.pragma('foreign_key_check');
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      fail('sanitized export integrity check failed');
    }
    if (foreignKeys.length !== 0) fail('sanitized export foreign-key check failed');
    const corpusRows = readCorpusRows(output);
    const cacheRows = output.prepare(`
      SELECT utterance_hash AS utteranceHash, domain, confidence,
             model, created_at AS createdAt
      FROM routing_llm_classify_cache ORDER BY utterance_hash ASC
    `).all().map((row) => ({
      utteranceHash: String(row.utteranceHash),
      domain: String(row.domain),
      confidence: Number(row.confidence),
      model: row.model === null ? null : String(row.model),
      createdAt: String(row.createdAt),
    }));
    const snapshotRows = Number(output.prepare(
      'SELECT COUNT(*) AS count FROM accepted_accuracy_snapshots',
    ).get().count);
    if (corpusRows.length !== input.plan.corpus.rows
        || cacheRows.length !== input.plan.cache.rows || snapshotRows !== 0
        || corpusRows.some((row) => row.suggestedDomain !== null || row.suggestedSkill !== null)
        || cacheRows.some((row) => row.model !== null)
        || routingCalibrationCorpusIdentityDigest(corpusRows)
          !== input.plan.corpus.identityDigest
        || routingCalibrationCacheRowsDigest(cacheRows) !== input.plan.cache.rowsDigest) {
      fail('sanitized export content differs from the reviewed plan');
    }
    const raw = fs.readFileSync(outputPath);
    return {
      schema: ROUTING_CALIBRATION_EXPORT_EVIDENCE_SCHEMA,
      outputPath: input.plan.output.path,
      outputSha256: sha256Digest(raw),
      outputBytes: stat.size,
      outputMode: (stat.mode & 0o777).toString(8).padStart(4, '0'),
      corpusRows: corpusRows.length,
      cacheRows: cacheRows.length,
      cacheCoverage: cacheRows.length / corpusRows.length,
      cacheComplete: cacheRows.length === corpusRows.length,
      acceptedSnapshotRows: snapshotRows,
      corpusIdentityDigest: input.plan.corpus.identityDigest,
      cacheRowsDigest: input.plan.cache.rowsDigest,
      acceptedSnapshotJsonSha256: input.plan.acceptedSnapshot.jsonSha256,
      integrity: 'ok',
      foreignKeys: 'ok',
      providerCalls: 0,
      providerCalled: false,
      externalCallPerformed: false,
    };
  } finally {
    output.close();
  }
}

export function exportRoutingCalibrationCorpus(input) {
  const plan = validateRoutingCalibrationExportPlan(input.plan);
  if (input.ownerAuthorized !== true) {
    fail('routing-calibration export requires explicit owner authorization');
  }
  if (input.acknowledgedPlanDigest !== plan.planDigest) {
    fail('acknowledged plan digest does not match the exact inspected plan');
  }
  if (Date.now() > Date.parse(plan.expiresAt)) fail('routing-calibration export plan expired');
  assertIdentity(input);
  if (input.runtimeSha !== plan.runtimeSha || input.artifactDigest !== plan.artifactDigest
      || input.transactionId !== plan.transactionId
      || fs.realpathSync(input.releaseDir) !== plan.releaseDir) {
    fail('apply release identity differs from the reviewed plan');
  }
  assertSourceContainment(plan, input);
  const exportRoot = safePrivateDirectory(
    plan.containment.exportRoot,
    'apply export root',
  );
  if (String(exportRoot.stat.dev) !== plan.containment.exportRootDevice
      || String(exportRoot.stat.ino) !== plan.containment.exportRootInode) {
    fail('apply export root identity differs from the reviewed plan');
  }
  return captureSourceSnapshot(input, ({ state, corpusRows, cacheRows }) => {
    if (canonicalJson(comparableState(state))
        !== canonicalJson(comparableState(plan))) {
      fail('routing-calibration export source state changed after inspect');
    }
    const outputPath = createSanitizedDatabase({
      ...input,
      plan,
      corpusRows,
      cacheRows,
    });
    return inspectSanitizedDatabase({
      releaseDir: input.releaseDir,
      outputPath,
      plan,
    });
  });
}

export function verifyRoutingCalibrationExportSource(input) {
  const plan = validateRoutingCalibrationExportPlan(input.plan);
  if (fs.realpathSync(input.releaseDir) !== plan.releaseDir) {
    fail('source revalidation path differs from the reviewed plan');
  }
  assertSourceContainment(plan, input);
  return captureSourceSnapshot(input, ({ state }) => {
    if (canonicalJson(comparableState(state)) !== canonicalJson(comparableState(plan))) {
      fail('routing-calibration export source state changed after export');
    }
    return {
      corpusIdentityDigest: state.corpus.identityDigest,
      cacheRowsDigest: state.cache.rowsDigest,
      acceptedSnapshotJsonSha256: state.acceptedSnapshot.jsonSha256,
    };
  });
}

function assertEvidenceMatchesPlan(plan, evidence) {
  assertExactKeys(evidence, [
    'schema', 'outputPath', 'outputSha256', 'outputBytes', 'outputMode',
    'corpusRows', 'cacheRows', 'cacheCoverage', 'cacheComplete',
    'acceptedSnapshotRows', 'corpusIdentityDigest', 'cacheRowsDigest',
    'acceptedSnapshotJsonSha256', 'integrity', 'foreignKeys',
    'providerCalls', 'providerCalled', 'externalCallPerformed',
  ], 'routing-calibration export evidence');
  if (evidence.schema !== ROUTING_CALIBRATION_EXPORT_EVIDENCE_SCHEMA
      || evidence.outputPath !== plan.output.path
      || evidence.corpusRows !== plan.corpus.rows
      || evidence.cacheRows !== plan.cache.rows
      || evidence.cacheCoverage !== plan.cache.coverage
      || evidence.cacheComplete !== plan.cache.complete
      || evidence.acceptedSnapshotRows !== 0
      || evidence.corpusIdentityDigest !== plan.corpus.identityDigest
      || evidence.cacheRowsDigest !== plan.cache.rowsDigest
      || evidence.acceptedSnapshotJsonSha256 !== plan.acceptedSnapshot.jsonSha256
      || evidence.integrity !== 'ok' || evidence.foreignKeys !== 'ok'
      || evidence.providerCalls !== 0 || evidence.providerCalled !== false
      || evidence.externalCallPerformed !== false
      || evidence.outputMode !== '0600') {
    fail('routing-calibration export evidence differs from the reviewed plan');
  }
  assertDigest(evidence.outputSha256, 'export output digest');
  if (!Number.isSafeInteger(evidence.outputBytes) || evidence.outputBytes < 1) {
    fail('export byte count is invalid');
  }
}

export function verifyRoutingCalibrationExport(input) {
  const plan = validateRoutingCalibrationExportPlan(input.plan);
  const observed = inspectSanitizedDatabase({
    releaseDir: input.releaseDir,
    outputPath: input.outputPath,
    plan,
    copiedEvidence: input.copiedEvidence === true,
  });
  assertEvidenceMatchesPlan(plan, input.evidence);
  if (canonicalJson(observed) !== canonicalJson(input.evidence)) {
    fail('persisted sanitized export differs from recorded evidence');
  }
  return observed;
}

export function buildRoutingCalibrationExportPartialReceipt(input) {
  const plan = validateRoutingCalibrationExportPlan(input.plan);
  if (!['started', 'exported_pending_post_health', 'failed'].includes(input.status)) {
    fail('partial receipt status is invalid');
  }
  assertCanonicalTimestamp(input.startedAt, 'partial receipt startedAt');
  if (input.evidence !== undefined && input.evidence !== null) {
    assertEvidenceMatchesPlan(plan, input.evidence);
  }
  const body = {
    schema: ROUTING_CALIBRATION_EXPORT_PARTIAL_SCHEMA,
    status: input.status,
    role: 'production',
    runtimeSha: plan.runtimeSha,
    artifactDigest: plan.artifactDigest,
    transactionId: plan.transactionId,
    planDigest: plan.planDigest,
    outputPath: plan.output.path,
    startedAt: input.startedAt,
    evidence: input.evidence ?? null,
  };
  return { ...body, partialReceiptDigest: canonicalPlanDigest(body) };
}

export function validateRoutingCalibrationExportPartialReceipt(receipt, planInput) {
  const plan = validateRoutingCalibrationExportPlan(planInput);
  assertExactKeys(receipt, [
    'schema', 'status', 'role', 'runtimeSha', 'artifactDigest',
    'transactionId', 'planDigest', 'outputPath', 'startedAt', 'evidence',
    'partialReceiptDigest',
  ], 'routing-calibration partial receipt');
  const { partialReceiptDigest, ...body } = receipt;
  if (receipt.schema !== ROUTING_CALIBRATION_EXPORT_PARTIAL_SCHEMA
      || !['started', 'exported_pending_post_health', 'failed'].includes(receipt.status)
      || receipt.role !== 'production' || receipt.runtimeSha !== plan.runtimeSha
      || receipt.artifactDigest !== plan.artifactDigest
      || receipt.transactionId !== plan.transactionId
      || receipt.planDigest !== plan.planDigest
      || receipt.outputPath !== plan.output.path
      || partialReceiptDigest !== canonicalPlanDigest(body)) {
    fail('routing-calibration partial receipt is invalid');
  }
  assertCanonicalTimestamp(receipt.startedAt, 'partial receipt startedAt');
  if (receipt.evidence !== null) assertEvidenceMatchesPlan(plan, receipt.evidence);
  if (receipt.status === 'exported_pending_post_health' && receipt.evidence === null) {
    fail('exported partial receipt must contain exact export evidence');
  }
  return receipt;
}

export function buildRoutingCalibrationExportReceipt(input) {
  const plan = validateRoutingCalibrationExportPlan(input.plan);
  assertEvidenceMatchesPlan(plan, input.evidence);
  assertCanonicalTimestamp(input.completedAt, 'receipt completedAt');
  assertExactKeys(
    input.postflight,
    ['selector', 'health', 'pm2'],
    'export postflight',
  );
  if (fs.realpathSync(input.postflight.selector) !== plan.releaseDir) {
    fail('postflight selector does not bind the exact release');
  }
  const postflight = {
    selector: plan.releaseDir,
    health: input.postflight.health,
    healthSha256: sha256Digest(canonicalJson(input.postflight.health)),
    pm2: input.postflight.pm2,
    pm2Sha256: sha256Digest(canonicalJson(input.postflight.pm2)),
  };
  assertAttestationPair(
    postflight,
    plan.releaseDir,
    plan.runtimeSha,
    plan.artifactDigest,
    'postflight',
  );
  const body = {
    schema: ROUTING_CALIBRATION_EXPORT_RECEIPT_SCHEMA,
    status: 'passed',
    role: 'production',
    runtimeSha: plan.runtimeSha,
    artifactDigest: plan.artifactDigest,
    transactionId: plan.transactionId,
    planDigest: plan.planDigest,
    corpusIdentityDigest: plan.corpus.identityDigest,
    cacheRowsDigest: plan.cache.rowsDigest,
    acceptedSnapshotJsonSha256: plan.acceptedSnapshot.jsonSha256,
    corpusRows: input.evidence.corpusRows,
    cacheRows: input.evidence.cacheRows,
    cacheCoverage: input.evidence.cacheCoverage,
    cacheComplete: input.evidence.cacheComplete,
    acceptedSnapshotRows: input.evidence.acceptedSnapshotRows,
    outputPath: plan.output.path,
    outputSha256: input.evidence.outputSha256,
    outputBytes: input.evidence.outputBytes,
    outputMode: input.evidence.outputMode,
    integrity: input.evidence.integrity,
    foreignKeys: input.evidence.foreignKeys,
    providerCalls: 0,
    providerCalled: false,
    externalCallPerformed: false,
    normalization: plan.normalization,
    preflight: plan.preflight,
    postflight,
    completedAt: input.completedAt,
  };
  return { ...body, receiptDigest: canonicalPlanDigest(body) };
}

export function validateRoutingCalibrationExportReceipt(receipt, planInput, evidence) {
  if (!receipt || receipt.schema !== ROUTING_CALIBRATION_EXPORT_RECEIPT_SCHEMA) {
    fail('routing-calibration export receipt schema is invalid');
  }
  assertExactKeys(receipt, [
    'schema', 'status', 'role', 'runtimeSha', 'artifactDigest',
    'transactionId', 'planDigest', 'corpusIdentityDigest', 'cacheRowsDigest',
    'acceptedSnapshotJsonSha256', 'corpusRows', 'cacheRows', 'cacheCoverage',
    'cacheComplete', 'acceptedSnapshotRows', 'outputPath', 'outputSha256',
    'outputBytes', 'outputMode', 'integrity', 'foreignKeys', 'providerCalls',
    'providerCalled', 'externalCallPerformed', 'normalization', 'preflight',
    'postflight', 'completedAt', 'receiptDigest',
  ], 'routing-calibration export receipt');
  assertExactKeys(receipt.preflight, [
    'selector', 'health', 'healthSha256', 'pm2', 'pm2Sha256',
  ], 'receipt preflight');
  assertExactKeys(receipt.postflight, [
    'selector', 'health', 'healthSha256', 'pm2', 'pm2Sha256',
  ], 'receipt postflight');
  const { receiptDigest, ...body } = receipt;
  if (receipt.status !== 'passed' || receipt.role !== 'production'
      || receipt.providerCalls !== 0 || receipt.acceptedSnapshotRows !== 0
      || receipt.providerCalled !== false || receipt.externalCallPerformed !== false
      || typeof receipt.cacheComplete !== 'boolean'
      || !Number.isFinite(receipt.cacheCoverage)
      || receipt.outputMode !== '0600'
      || receiptDigest !== canonicalPlanDigest(body)) {
    fail('routing-calibration export receipt is invalid');
  }
  assertIdentity(receipt);
  assertDigest(receipt.planDigest, 'receipt plan digest');
  assertDigest(receipt.outputSha256, 'receipt output digest');
  assertCanonicalTimestamp(receipt.completedAt, 'receipt completedAt');
  if (planInput === undefined || evidence === undefined) {
    fail('final receipt validation requires the exact plan and export evidence');
  }
  const plan = validateRoutingCalibrationExportPlan(planInput);
  assertEvidenceMatchesPlan(plan, evidence);
  assertAttestationPair(
    receipt.preflight,
    plan.releaseDir,
    plan.runtimeSha,
    plan.artifactDigest,
    'receipt preflight',
  );
  assertAttestationPair(
    receipt.postflight,
    plan.releaseDir,
    plan.runtimeSha,
    plan.artifactDigest,
    'receipt postflight',
  );
  const expectedBindings = {
    role: plan.role,
    runtimeSha: plan.runtimeSha,
    artifactDigest: plan.artifactDigest,
    transactionId: plan.transactionId,
    planDigest: plan.planDigest,
    corpusIdentityDigest: plan.corpus.identityDigest,
    cacheRowsDigest: plan.cache.rowsDigest,
    acceptedSnapshotJsonSha256: plan.acceptedSnapshot.jsonSha256,
    corpusRows: evidence.corpusRows,
    cacheRows: evidence.cacheRows,
    cacheCoverage: evidence.cacheCoverage,
    cacheComplete: evidence.cacheComplete,
    acceptedSnapshotRows: evidence.acceptedSnapshotRows,
    outputPath: plan.output.path,
    outputSha256: evidence.outputSha256,
    outputBytes: evidence.outputBytes,
    outputMode: evidence.outputMode,
    integrity: evidence.integrity,
    foreignKeys: evidence.foreignKeys,
    providerCalls: evidence.providerCalls,
    providerCalled: evidence.providerCalled,
    externalCallPerformed: evidence.externalCallPerformed,
    normalization: plan.normalization,
    preflight: plan.preflight,
  };
  for (const [key, expected] of Object.entries(expectedBindings)) {
    if (canonicalJson(receipt[key]) !== canonicalJson(expected)) {
      fail(`routing-calibration export receipt ${key} differs from exact evidence`);
    }
  }
  if (receipt.postflight.selector !== plan.releaseDir
      || receipt.cacheCoverage !== receipt.cacheRows / receipt.corpusRows
      || receipt.cacheComplete !== (receipt.cacheRows === receipt.corpusRows)) {
    fail('routing-calibration export receipt postflight or coverage is inconsistent');
  }
  return receipt;
}

function readArg(name) {
  const exact = process.argv.indexOf(name);
  if (exact >= 0) return process.argv[exact + 1];
  const prefix = process.argv.find((argument) => argument.startsWith(`${name}=`));
  return prefix?.slice(name.length + 1);
}

function readPrivateJson(filename, label) {
  const { resolved } = safePrivateFile(filename, label);
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function loadRoutingRuntimeContracts(releaseDir) {
  const secret = process.env.CLASSIFY_SHADOW_HASH_SECRET;
  if (typeof secret !== 'string' || secret.length === 0) {
    fail('CLASSIFY_SHADOW_HASH_SECRET is required');
  }
  const absoluteRelease = fs.realpathSync(releaseDir);
  const require = createRequire(path.join(absoluteRelease, 'package.json'));
  const corpusModule = require(path.join(
    absoluteRelease,
    'dist/services/routing-corpus.js',
  ));
  const snapshotContract = require(path.join(
    absoluteRelease,
    'dist/services/routing-accuracy-snapshot-contract.js',
  ));
  if (typeof corpusModule.isCheckedInSyntheticRoutingCorpusItem !== 'function') {
    fail('installed approved synthetic corpus verifier is unavailable');
  }
  if (typeof corpusModule.getRoutingLabelCandidates !== 'function') {
    fail('installed governed routing-domain contract is unavailable');
  }
  if (typeof snapshotContract.parseAcceptedRoutingAccuracySnapshot !== 'function') {
    fail('installed canonical accepted-snapshot validator is unavailable');
  }
  const candidates = corpusModule.getRoutingLabelCandidates();
  const allowedCacheDomains = new Set([
    ...candidates.domains,
    ...candidates.specialLabels,
    // Historical Chat Core v2 aliases are normalized by routing-accuracy.
    'tasks',
    'training',
  ]);
  return {
    isApprovedSyntheticItem: (item) => (
      corpusModule.isCheckedInSyntheticRoutingCorpusItem(item, secret)
    ),
    parseAcceptedSnapshot: (snapshotJson) => (
      snapshotContract.parseAcceptedRoutingAccuracySnapshot(snapshotJson)
    ),
    isApprovedCacheDomain: (domain) => allowedCacheDomains.has(domain),
  };
}

function commonCliInput() {
  const releaseDir = readArg('--release-dir') ?? '';
  if (fs.realpathSync(process.cwd()) !== fs.realpathSync(releaseDir)) {
    fail('routing-calibration export helper cwd differs from the exact installed release');
  }
  const runtimeContracts = loadRoutingRuntimeContracts(releaseDir);
  return {
    dbPath: readArg('--db') ?? '',
    releaseDir,
    outputPath: readArg('--output-path') ?? '',
    runtimeSha: readArg('--runtime-sha') ?? '',
    artifactDigest: readArg('--artifact-digest') ?? '',
    transactionId: readArg('--transaction-id') ?? '',
    productionBaseDir: readArg('--production-base-dir') ?? '',
    exportRoot: readArg('--export-root') ?? '',
    ...runtimeContracts,
  };
}

async function main() {
  const command = process.argv[2];
  if (command === 'next-sequence') {
    const next = nextRoutingCalibrationExportPlanSequence({
      sequencePath: readArg('--sequence-file') ?? '',
      planRoot: readArg('--plan-root') ?? '',
      claimRoot: readArg('--claim-root') ?? '',
      exportRoot: readArg('--export-root') ?? '',
      receiptRoot: readArg('--receipt-root') ?? '',
    });
    process.stdout.write(`${next}\n`);
    return;
  }
  if (command === 'assert-resolved-state') {
    const result = assertRoutingCalibrationExportStateResolved({
      releaseDir: readArg('--release-dir') ?? '',
      planRoot: readArg('--plan-root') ?? '',
      claimRoot: readArg('--claim-root') ?? '',
      exportRoot: readArg('--export-root') ?? '',
      receiptRoot: readArg('--receipt-root') ?? '',
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === 'inspect') {
    const input = commonCliInput();
    const plan = inspectRoutingCalibrationExport({
      ...input,
      generatedAt: readArg('--generated-at') ?? '',
      expiresAt: readArg('--expires-at') ?? '',
      planSequence: Number(readArg('--plan-sequence')),
      operatorSha256: readArg('--operator-sha256') ?? '',
      helperSha256: readArg('--helper-sha256') ?? '',
      preflight: {
        selector: readArg('--selector') ?? '',
        health: readPrivateJson(
          readArg('--health-evidence-file') ?? '',
          'preflight health evidence',
        ),
        pm2: readPrivateJson(
          readArg('--pm2-evidence-file') ?? '',
          'preflight PM2 evidence',
        ),
      },
    });
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  if (command === 'apply') {
    const input = commonCliInput();
    const plan = readPrivateJson(readArg('--plan-file') ?? '', 'export plan');
    const evidence = exportRoutingCalibrationCorpus({
      ...input,
      plan,
      ownerAuthorized: process.env.NEXUS_RELEASE_OWNER_AUTHORIZED === '1',
      acknowledgedPlanDigest: readArg('--ack-plan') ?? '',
      partialOutputPath: readArg('--partial-output-path') ?? '',
    });
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    return;
  }
  if (command === 'partial-receipt') {
    const plan = readPrivateJson(readArg('--plan-file') ?? '', 'export plan');
    const evidenceFile = readArg('--evidence-file');
    const receipt = buildRoutingCalibrationExportPartialReceipt({
      plan,
      status: readArg('--status') ?? '',
      startedAt: readArg('--started-at') ?? '',
      evidence: evidenceFile
        ? readPrivateJson(evidenceFile, 'export evidence')
        : undefined,
    });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return;
  }
  if (command === 'final-receipt') {
    const plan = readPrivateJson(readArg('--plan-file') ?? '', 'export plan');
    const evidence = readPrivateJson(
      readArg('--evidence-file') ?? '',
      'export evidence',
    );
    const receipt = buildRoutingCalibrationExportReceipt({
      plan,
      evidence,
      completedAt: readArg('--completed-at') ?? '',
      postflight: {
        selector: readArg('--selector') ?? '',
        health: readPrivateJson(
          readArg('--health-evidence-file') ?? '',
          'postflight health evidence',
        ),
        pm2: readPrivateJson(
          readArg('--pm2-evidence-file') ?? '',
          'postflight PM2 evidence',
        ),
      },
    });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return;
  }
  if (command === 'verify') {
    const plan = readPrivateJson(readArg('--plan-file') ?? '', 'export plan');
    const evidence = readPrivateJson(
      readArg('--evidence-file') ?? '',
      'export evidence',
    );
    const observed = verifyRoutingCalibrationExport({
      plan,
      evidence,
      releaseDir: readArg('--release-dir') ?? '',
      outputPath: readArg('--output-path') ?? '',
      copiedEvidence: process.argv.includes('--copied-export'),
    });
    process.stdout.write(`${JSON.stringify(observed)}\n`);
    return;
  }
  if (command === 'verify-source') {
    const input = commonCliInput();
    const plan = readPrivateJson(readArg('--plan-file') ?? '', 'export plan');
    const observed = verifyRoutingCalibrationExportSource({ ...input, plan });
    process.stdout.write(`${JSON.stringify(observed)}\n`);
    return;
  }
  if (command === 'validate-plan') {
    const plan = validateRoutingCalibrationExportPlan(
      readPrivateJson(readArg('--plan-file') ?? '', 'export plan'),
    );
    process.stdout.write(`${plan.planDigest}\n`);
    return;
  }
  if (command === 'validate-partial') {
    const plan = readPrivateJson(readArg('--plan-file') ?? '', 'export plan');
    const receipt = validateRoutingCalibrationExportPartialReceipt(
      readPrivateJson(readArg('--receipt-file') ?? '', 'partial export receipt'),
      plan,
    );
    const requiredStatus = readArg('--require-status');
    if (requiredStatus !== undefined && receipt.status !== requiredStatus) {
      fail(`partial export receipt is ${receipt.status}, not required ${requiredStatus}`);
    }
    process.stdout.write(`${receipt.partialReceiptDigest}\n`);
    return;
  }
  if (command === 'validate-receipt') {
    const plan = validateRoutingCalibrationExportPlan(
      readPrivateJson(readArg('--plan-file') ?? '', 'export plan'),
    );
    const evidence = readPrivateJson(
      readArg('--evidence-file') ?? '',
      'export evidence',
    );
    const receipt = validateRoutingCalibrationExportReceipt(
      readPrivateJson(readArg('--receipt-file') ?? '', 'export receipt'),
      plan,
      evidence,
    );
    const observed = verifyRoutingCalibrationExport({
      plan,
      evidence,
      releaseDir: readArg('--release-dir') ?? '',
      outputPath: readArg('--output-path') ?? '',
      copiedEvidence: process.argv.includes('--copied-export'),
    });
    if (receipt.planDigest !== plan.planDigest
        || receipt.outputSha256 !== observed.outputSha256
        || receipt.outputBytes !== observed.outputBytes
        || receipt.corpusIdentityDigest !== plan.corpus.identityDigest
        || receipt.cacheRowsDigest !== plan.cache.rowsDigest) {
      fail('final receipt does not bind the exact plan and persisted export');
    }
    process.stdout.write(`${receipt.receiptDigest}\n`);
    return;
  }
  if (command === 'publish-private') {
    const result = publishPrivateEvidenceFile({
      sourcePath: readArg('--source') ?? '',
      destinationPath: readArg('--destination') ?? '',
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === 'recover-private-publication') {
    const result = recoverPrivateEvidencePublication({
      destinationPath: readArg('--destination') ?? '',
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  fail('unsupported routing-calibration export helper command');
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
