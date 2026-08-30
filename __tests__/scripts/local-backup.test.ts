import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const utility = resolve('scripts/local-backup.py');

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'nexus-local-backup-'));
  chmodSync(root, 0o700);
  const database = join(root, 'bot.db');
  execFileSync('python3', [
    '-c',
    [
      'import sqlite3,sys',
      'db=sqlite3.connect(sys.argv[1])',
      'db.execute("PRAGMA foreign_keys=ON")',
      'db.execute("CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL)")',
      'db.execute("INSERT INTO users(name) VALUES (?)", ("Felipe",))',
      'db.commit()',
      'db.close()',
    ].join(';'),
    database,
  ]);
  const backupRoot = join(root, 'backups');
  const identity = join(root, 'age-identity.txt');
  writeFileSync(identity, 'AGE-SECRET-KEY-TEST\n', { mode: 0o600 });
  chmodSync(identity, 0o600);
  const config = join(root, 'backup.env');
  writeFileSync(
    config,
    [
      `NEXUS_LOCAL_BACKUP_DATABASE_PATH=${database}`,
      `NEXUS_LOCAL_BACKUP_ROOT=${backupRoot}`,
      'NEXUS_LOCAL_BACKUP_AGE_RECIPIENT=age1testrecipient',
      `NEXUS_LOCAL_BACKUP_AGE_IDENTITY=${identity}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  chmodSync(config, 0o600);
  const fakeAge = join(root, 'age');
  writeFileSync(
    fakeAge,
    [
      '#!/bin/sh',
      'set -eu',
      'output=""',
      'input=""',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    --encrypt|--decrypt) shift ;;',
      '    --recipient|--identity) shift 2 ;;',
      '    --output) output="$2"; shift 2 ;;',
      '    *) input="$1"; shift ;;',
      '  esac',
      'done',
      'cp "$input" "$output"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  chmodSync(fakeAge, 0o755);
  return { root, database, backupRoot, identity, config, fakeAge };
}

function run(
  fixture: ReturnType<typeof createFixture>,
  ...args: string[]
) {
  return spawnSync(
    'python3',
    [utility, '--config', fixture.config, ...args],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        NEXUS_LOCAL_BACKUP_TEST_MODE: '1',
        NEXUS_LOCAL_BACKUP_TEST_TRUST_ANCHOR: fixture.root,
        NEXUS_LOCAL_BACKUP_AGE_BIN: fixture.fakeAge,
      },
    },
  );
}

describe('same-host Nexus backups', () => {
  it('anchors Linux fixtures at an explicit private directory and rejects escapes', () => {
    const fixture = createFixture();
    const probe = (anchor: string) => spawnSync('python3', [
      '-c',
      [
        'import importlib.util,os,pathlib,sys',
        'os.environ["NEXUS_LOCAL_BACKUP_TEST_MODE"]="1"',
        'os.environ["NEXUS_LOCAL_BACKUP_TEST_TRUST_ANCHOR"]=sys.argv[3]',
        'spec=importlib.util.spec_from_file_location("local_backup",sys.argv[1])',
        'module=importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(module)',
        'with module.bound_governed_directories(pathlib.Path(sys.argv[2])):',
        '  pass',
      ].join('\n'),
      utility,
      fixture.root,
      anchor,
    ], { encoding: 'utf8' });
    try {
      const anchored = probe(fixture.root);
      expect(anchored.status, anchored.stderr).toBe(0);

      const escaped = probe(fixture.backupRoot);
      expect(escaped.status).toBe(1);
      expect(escaped.stderr).toContain('backup directory escapes its trusted anchor');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('copies through one normal read-only SQLite step before integrity verification', () => {
    const snapshotProbe = execFileSync(
      'python3',
      [
        '-c',
        [
          'import importlib.util,json,sys,tempfile',
          'from pathlib import Path',
          'spec=importlib.util.spec_from_file_location("local_backup", sys.argv[1])',
          'module=importlib.util.module_from_spec(spec)',
          'spec.loader.exec_module(module)',
          'events=[]',
          'observed={}',
          'class Destination:',
          '    def __init__(self, path):',
          '        self.path=Path(path)',
          '    def commit(self):',
          '        events.append("commit")',
          '    def close(self):',
          '        events.append("close-destination")',
          'class Source:',
          '    def backup(self, destination, **kwargs):',
          '        observed["backupOptions"]=kwargs',
          '        events.append("backup")',
          '        destination.path.write_bytes(b"snapshot")',
          '    def execute(self, statement):',
          '        self.statement=statement',
          '        if statement == "PRAGMA schema_version":',
          '            observed["schemaStatement"]=statement',
          '            events.append("schema-version")',
          '        else:',
          '            observed["journalStatement"]=statement',
          '            events.append("journal-mode")',
          '        return self',
          '    def fetchone(self):',
          '        return ("delete",) if self.statement == "PRAGMA journal_mode" else (1,)',
          '    def close(self):',
          '        events.append("close-source")',
          'def connect(target, **kwargs):',
          '    if isinstance(target, str):',
          '        observed["sourceUri"]=target',
          '        observed["sourceOptions"]=kwargs',
          '        events.append("connect-source")',
          '        return Source()',
          '    events.append("connect-destination")',
          '    return Destination(target)',
          'def integrity(path):',
          '    events.append("integrity")',
          '    observed["destinationMode"]=oct(path.stat().st_mode & 0o777)',
          '    return {"integrityCheck":"ok","foreignKeyCheck":"ok"}',
          'module.sqlite3.connect=connect',
          'module.require_sqlite_source_descriptors=lambda source, binding, previous, journal: events.append("descriptor-proof")',
          'module.integrity=integrity',
          'with tempfile.TemporaryDirectory() as value:',
          '    root=Path(value)',
          '    source=root / "source.sqlite"',
          '    destination=root / "destination.sqlite"',
          '    source.write_bytes(b"source")',
          '    observed["result"]=module.snapshot(source, destination)',
          'observed["events"]=events',
          'print(json.dumps(observed, sort_keys=True))',
        ].join('\n'),
        utility,
      ],
      { encoding: 'utf8' },
    );

    const observed = JSON.parse(snapshotProbe);
    expect(observed.sourceUri).toMatch(/^file:.*\/source\.sqlite\?mode=ro$/);
    expect(observed.sourceUri).not.toContain('immutable=1');
    expect(observed.sourceOptions).toEqual({ timeout: 30, uri: true });
    expect(observed.schemaStatement).toBe('PRAGMA schema_version');
    expect(observed.journalStatement).toBe('PRAGMA journal_mode');
    expect(observed.backupOptions).toEqual({ pages: -1 });
    expect(observed.destinationMode).toBe('0o600');
    expect(observed.result).toEqual({
      integrityCheck: 'ok',
      foreignKeyCheck: 'ok',
    });
    expect(observed.events).toEqual([
      'connect-source',
      'schema-version',
      'journal-mode',
      'descriptor-proof',
      'connect-destination',
      'backup',
      'commit',
      'close-destination',
      'close-source',
      'integrity',
    ]);
  });

  it('rejects a real source-path ABA swap before copying any pages', () => {
    const abaProbe = execFileSync(
      'python3',
      [
        '-c',
        [
          'import importlib.util,json,os,sqlite3,sys,tempfile',
          'from pathlib import Path',
          'spec=importlib.util.spec_from_file_location("local_backup", sys.argv[1])',
          'module=importlib.util.module_from_spec(spec)',
          'spec.loader.exec_module(module)',
          'def create_database(path, value):',
          '    database=sqlite3.connect(path)',
          '    database.execute("CREATE TABLE proof(value INTEGER NOT NULL)")',
          '    database.execute("INSERT INTO proof(value) VALUES (?)", (value,))',
          '    database.commit()',
          '    database.close()',
          'with tempfile.TemporaryDirectory() as value:',
          '    root=Path(value)',
          '    source=root / "source.sqlite"',
          '    alternate=root / "alternate.sqlite"',
          '    parked=root / "source.parked"',
          '    destination=root / "destination.sqlite"',
          '    create_database(source, 1)',
          '    create_database(alternate, 2)',
          '    source.chmod(0o600)',
          '    alternate.chmod(0o600)',
          '    source_identity=[source.stat().st_dev,source.stat().st_ino]',
          '    original_connect=module.sqlite3.connect',
          '    observed={}',
          '    def connect(target, **kwargs):',
          '        if not isinstance(target, str):',
          '            return original_connect(target, **kwargs)',
          '        os.replace(source, parked)',
          '        os.replace(alternate, source)',
          '        try:',
          '            connection=original_connect(target, **kwargs)',
          '            observed["openedValue"]=connection.execute("SELECT value FROM proof").fetchone()[0]',
          '        finally:',
          '            os.replace(source, alternate)',
          '            os.replace(parked, source)',
          '        return connection',
          '    module.sqlite3.connect=connect',
          '    try:',
          '        module.snapshot(source, destination)',
          '    except SystemExit as error:',
          '        observed["error"]=str(error)',
          '    else:',
          '        raise AssertionError("ABA source swap unexpectedly passed")',
          '    finally:',
          '        module.sqlite3.connect=original_connect',
          '    source_connection=original_connect(source)',
          '    alternate_connection=original_connect(alternate)',
          '    observed["sourceValue"]=source_connection.execute("SELECT value FROM proof").fetchone()[0]',
          '    observed["alternateValue"]=alternate_connection.execute("SELECT value FROM proof").fetchone()[0]',
          '    source_connection.close()',
          '    alternate_connection.close()',
          '    observed["sourceIdentityRestored"]=[source.stat().st_dev,source.stat().st_ino] == source_identity',
          '    observed["destinationAbsent"]=not destination.exists()',
          'print(json.dumps(observed, sort_keys=True))',
        ].join('\n'),
        utility,
      ],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(abaProbe)).toEqual({
      alternateValue: 2,
      destinationAbsent: true,
      error: 'local backup: SQLite descriptor set is missing bound database',
      openedValue: 2,
      sourceIdentityRestored: true,
      sourceValue: 1,
    });
  });

  it('fails closed when Linux procfs descriptor inspection is unavailable', () => {
    const procfsProbe = execFileSync(
      'python3',
      [
        '-c',
        [
          'import importlib.util,json,sys',
          'spec=importlib.util.spec_from_file_location("local_backup", sys.argv[1])',
          'module=importlib.util.module_from_spec(spec)',
          'spec.loader.exec_module(module)',
          'observed=[]',
          'module.sys.platform="linux"',
          'def denied(path):',
          '    observed.append(str(path))',
          '    raise PermissionError("forced procfs denial")',
          'module.os.listdir=denied',
          'try:',
          '    module.process_descriptor_numbers()',
          'except SystemExit as error:',
          '    message=str(error)',
          'else:',
          '    raise AssertionError("Linux descriptor inspection unexpectedly passed")',
          'print(json.dumps({"directories":observed,"error":message}))',
        ].join('\n'),
        utility,
      ],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(procfsProbe)).toEqual({
      directories: ['/proc/self/fd'],
      error: 'local backup: cannot inspect process file descriptors',
    });
  });

  it('copies a real persistent-WAL database only after binding all three SQLite files', () => {
    const walProbe = execFileSync(
      'python3',
      [
        '-c',
        [
          'import importlib.util,json,os,sqlite3,stat,sys,tempfile',
          'from pathlib import Path',
          'spec=importlib.util.spec_from_file_location("local_backup", sys.argv[1])',
          'module=importlib.util.module_from_spec(spec)',
          'spec.loader.exec_module(module)',
          'def seed_persistent_wal(path, value):',
          '    child=os.fork()',
          '    if child == 0:',
          '        try:',
          '            database=sqlite3.connect(path)',
          '            mode=database.execute("PRAGMA journal_mode=WAL").fetchone()[0]',
          '            database.execute("PRAGMA wal_autocheckpoint=0")',
          '            database.execute("CREATE TABLE proof(value INTEGER NOT NULL)")',
          '            database.execute("INSERT INTO proof(value) VALUES (?)", (value,))',
          '            database.commit()',
          '            os._exit(0 if mode.lower() == "wal" else 3)',
          '        except BaseException:',
          '            os._exit(4)',
          '    _, status=os.waitpid(child, 0)',
          '    if os.waitstatus_to_exitcode(status) != 0:',
          '        raise AssertionError("persistent WAL producer failed")',
          'with tempfile.TemporaryDirectory() as value:',
          '    root=Path(value)',
          '    source=root / "source.sqlite"',
          '    destination=root / "destination.sqlite"',
          '    seed_persistent_wal(source, 17)',
          '    if not all(Path(f"{source}{suffix}").is_file() for suffix in ("-wal", "-shm")):',
          '        raise AssertionError("persistent WAL sidecars are missing")',
          '    wal=Path(f"{source}-wal")',
          '    shm=Path(f"{source}-shm")',
          '    def identity(path):',
          '        observed=os.stat(path)',
          '        return [observed.st_dev,observed.st_ino,observed.st_uid,observed.st_gid,stat.S_IMODE(observed.st_mode)]',
          '    main_before=identity(source)',
          '    wal_before=identity(wal)',
          '    shm_before=identity(shm)',
          '    wal_bytes_before=wal.read_bytes()',
          '    receipt=module.snapshot(source, destination)',
          '    restored=sqlite3.connect(destination)',
          '    restored_value=restored.execute("SELECT value FROM proof").fetchone()[0]',
          '    restored.close()',
          '    observed={',
          '        "integrity":receipt["integrityCheck"],',
          '        "foreignKeys":receipt["foreignKeyCheck"],',
          '        "mainIdentityStable":main_before == identity(source),',
          '        "sidecarsPresent":all(Path(f"{source}{suffix}").is_file() for suffix in ("-wal", "-shm")),',
          '        "shmIdentityStable":shm_before == identity(shm),',
          '        "value":restored_value,',
          '        "walBytesStable":wal_bytes_before == wal.read_bytes(),',
          '        "walIdentityStable":wal_before == identity(wal),',
          '    }',
          'print(json.dumps(observed, sort_keys=True))',
        ].join('\n'),
        utility,
      ],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(walProbe)).toEqual({
      foreignKeys: 'ok',
      integrity: 'ok',
      mainIdentityStable: true,
      sidecarsPresent: true,
      shmIdentityStable: true,
      value: 17,
      walBytesStable: true,
      walIdentityStable: true,
    });
  });

  it('rejects transient WAL/SHM substitution restored before pathname checks', () => {
    const walAbaProbe = execFileSync(
      'python3',
      [
        '-c',
        [
          'import importlib.util,json,os,shutil,sqlite3,sys,tempfile',
          'from pathlib import Path',
          'spec=importlib.util.spec_from_file_location("local_backup", sys.argv[1])',
          'module=importlib.util.module_from_spec(spec)',
          'spec.loader.exec_module(module)',
          'def seed_persistent_wal(path, value):',
          '    child=os.fork()',
          '    if child == 0:',
          '        try:',
          '            database=sqlite3.connect(path)',
          '            mode=database.execute("PRAGMA journal_mode=WAL").fetchone()[0]',
          '            database.execute("PRAGMA wal_autocheckpoint=0")',
          '            database.execute("UPDATE proof SET value=?", (value,))',
          '            database.commit()',
          '            os._exit(0 if mode.lower() == "wal" else 3)',
          '        except BaseException:',
          '            os._exit(4)',
          '    _, status=os.waitpid(child, 0)',
          '    if os.waitstatus_to_exitcode(status) != 0:',
          '        raise AssertionError("persistent WAL producer failed")',
          'def identities(path):',
          '    return {suffix:[os.stat(f"{path}{suffix}").st_dev,os.stat(f"{path}{suffix}").st_ino] for suffix in ("-wal", "-shm")}',
          'with tempfile.TemporaryDirectory() as value:',
          '    root=Path(value)',
          '    base=root / "base.sqlite"',
          '    source=root / "source.sqlite"',
          '    alternate=root / "alternate.sqlite"',
          '    destination=root / "destination.sqlite"',
          '    database=sqlite3.connect(base)',
          '    database.execute("CREATE TABLE proof(value INTEGER NOT NULL)")',
          '    database.execute("INSERT INTO proof(value) VALUES (0)")',
          '    database.commit()',
          '    database.close()',
          '    shutil.copy2(base, source)',
          '    shutil.copy2(base, alternate)',
          '    seed_persistent_wal(source, 1)',
          '    seed_persistent_wal(alternate, 2)',
          '    original_identities=identities(source)',
          '    original_connect=module.sqlite3.connect',
          '    observed={}',
          '    def connect(target, **kwargs):',
          '        if not isinstance(target, str):',
          '            return original_connect(target, **kwargs)',
          '        for suffix in ("-wal", "-shm"):',
          '            os.replace(Path(f"{source}{suffix}"), root / f"parked{suffix}")',
          '            os.replace(Path(f"{alternate}{suffix}"), Path(f"{source}{suffix}"))',
          '        try:',
          '            connection=original_connect(target, **kwargs)',
          '            observed["openedValue"]=connection.execute("SELECT value FROM proof").fetchone()[0]',
          '        finally:',
          '            for suffix in ("-wal", "-shm"):',
          '                os.replace(Path(f"{source}{suffix}"), Path(f"{alternate}{suffix}"))',
          '                os.replace(root / f"parked{suffix}", Path(f"{source}{suffix}"))',
          '        observed["pathsRestored"]=identities(source) == original_identities',
          '        return connection',
          '    module.sqlite3.connect=connect',
          '    try:',
          '        module.snapshot(source, destination)',
          '    except SystemExit as error:',
          '        observed["error"]=str(error)',
          '    else:',
          '        raise AssertionError("WAL sidecar substitution unexpectedly passed")',
          '    finally:',
          '        module.sqlite3.connect=original_connect',
          '    observed["destinationAbsent"]=not destination.exists()',
          '    observed["sourceIdentitiesRestored"]=identities(source) == original_identities',
          'print(json.dumps(observed, sort_keys=True))',
        ].join('\n'),
        utility,
      ],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(walAbaProbe)).toEqual({
      destinationAbsent: true,
      error: 'local backup: SQLite descriptor set is missing bound database-wal, database-shm',
      openedValue: 2,
      pathsRestored: true,
      sourceIdentitiesRestored: true,
    });
  });

  it('rejects WAL/SHM descriptors moved away while the connection remains open', () => {
    const movedWalProbe = execFileSync(
      'python3',
      [
        '-c',
        [
          'import importlib.util,json,os,sqlite3,sys,tempfile',
          'from pathlib import Path',
          'spec=importlib.util.spec_from_file_location("local_backup", sys.argv[1])',
          'module=importlib.util.module_from_spec(spec)',
          'spec.loader.exec_module(module)',
          'with tempfile.TemporaryDirectory() as value:',
          '    root=Path(value)',
          '    source=root / "source.sqlite"',
          '    destination=root / "destination.sqlite"',
          '    database=sqlite3.connect(source)',
          '    mode=database.execute("PRAGMA journal_mode=WAL").fetchone()[0]',
          '    database.execute("CREATE TABLE proof(value INTEGER NOT NULL)")',
          '    database.execute("INSERT INTO proof(value) VALUES (3)")',
          '    database.commit()',
          '    database.execute("PRAGMA wal_checkpoint(TRUNCATE)")',
          '    database.close()',
          '    if mode.lower() != "wal":',
          '        raise AssertionError("WAL mode is unavailable")',
          '    for suffix in ("-wal", "-shm"):',
          '        Path(f"{source}{suffix}").unlink(missing_ok=True)',
          '    original_connect=module.sqlite3.connect',
          '    observed={}',
          '    def connect(target, **kwargs):',
          '        if not isinstance(target, str):',
          '            return original_connect(target, **kwargs)',
          '        keeper=original_connect(source)',
          '        keeper.execute("BEGIN IMMEDIATE")',
          '        keeper.execute("ROLLBACK")',
          '        connection=original_connect(target, **kwargs)',
          '        observed["openedValue"]=connection.execute("SELECT value FROM proof").fetchone()[0]',
          '        for suffix in ("-wal", "-shm"):',
          '            os.replace(Path(f"{source}{suffix}"), root / f"moved{suffix}")',
          '        keeper.close()',
          '        observed["pathsAbsentDuringConnection"]=not any(Path(f"{source}{suffix}").exists() for suffix in ("-wal", "-shm"))',
          '        return connection',
          '    module.sqlite3.connect=connect',
          '    try:',
          '        module.snapshot(source, destination)',
          '    except SystemExit as error:',
          '        observed["error"]=str(error)',
          '    else:',
          '        raise AssertionError("moved-away WAL descriptors unexpectedly passed")',
          '    finally:',
          '        module.sqlite3.connect=original_connect',
          '        for suffix in ("-wal", "-shm"):',
          '            moved=root / f"moved{suffix}"',
          '            if moved.exists():',
          '                os.replace(moved, Path(f"{source}{suffix}"))',
          '    observed["destinationAbsent"]=not destination.exists()',
          'print(json.dumps(observed, sort_keys=True))',
        ].join('\n'),
        utility,
      ],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(movedWalProbe)).toEqual({
      destinationAbsent: true,
      error: 'local backup: SQLite WAL mode is missing bound database-wal',
      openedValue: 3,
      pathsAbsentDuringConnection: true,
    });
  });

  it('materializes SQLite sidecars, reconciles them before copying, and rechecks after close', () => {
    const sidecarProbe = execFileSync(
      'python3',
      [
        '-c',
        [
          'import importlib.util,json,os,stat,sys,tempfile',
          'from pathlib import Path',
          'spec=importlib.util.spec_from_file_location("local_backup", sys.argv[1])',
          'module=importlib.util.module_from_spec(spec)',
          'spec.loader.exec_module(module)',
          'events=[]',
          'observed={}',
          'class Destination:',
          '    def __init__(self, path):',
          '        self.path=Path(path)',
          '    def commit(self):',
          '        events.append("commit")',
          '    def close(self):',
          '        events.append("close-destination")',
          'class Source:',
          '    def __init__(self, path):',
          '        self.path=path',
          '    def execute(self, statement):',
          '        self.statement=statement',
          '        events.append("schema-version" if statement == "PRAGMA schema_version" else "journal-mode")',
          '        if statement == "PRAGMA schema_version":',
          '            source_mode=stat.S_IMODE(os.stat(self.path).st_mode)',
          '            for suffix in ("-wal", "-shm"):',
          '                sidecar=Path(f"{self.path}{suffix}")',
          '                sidecar.write_bytes(suffix.encode())',
          '                sidecar.chmod(source_mode)',
          '        return self',
          '    def fetchone(self):',
          '        return ("delete",) if self.statement == "PRAGMA journal_mode" else (1,)',
          '    def backup(self, destination, **kwargs):',
          '        observed["normalizedBeforeBackup"]=events.count("normalize") == 1',
          '        events.append("backup")',
          '        destination.path.write_bytes(b"snapshot")',
          '    def close(self):',
          '        events.append("close-source")',
          'def connect(target, **kwargs):',
          '    if isinstance(target, str):',
          '        events.append("connect-source")',
          '        return Source(Path(target.removeprefix("file:").removesuffix("?mode=ro")))',
          '    events.append("connect-destination")',
          '    return Destination(target)',
          'original_normalize=module.normalize_sqlite_sidecars',
          'def normalize(*args):',
          '    original_normalize(*args)',
          '    events.append("normalize")',
          'module.sqlite3.connect=connect',
          'module.require_sqlite_source_descriptors=lambda source, binding, previous, journal: events.append("descriptor-proof")',
          'module.normalize_sqlite_sidecars=normalize',
          'module.integrity=lambda path: events.append("integrity") or {"integrityCheck":"ok"}',
          'with tempfile.TemporaryDirectory() as value:',
          '    root=Path(value)',
          '    source=root / "source.sqlite"',
          '    destination=root / "destination.sqlite"',
          '    source.write_bytes(b"source")',
          '    source.chmod(0o600)',
          '    observed["result"]=module.snapshot(source, destination)',
          '    source_stat=os.stat(source)',
          '    observed["sidecars"]={}',
          '    for suffix in ("-wal", "-shm"):',
          '        sidecar_stat=os.stat(f"{source}{suffix}")',
          '        observed["sidecars"][suffix]=[',
          '            sidecar_stat.st_uid == source_stat.st_uid,',
          '            sidecar_stat.st_gid == source_stat.st_gid,',
          '            stat.S_IMODE(sidecar_stat.st_mode) == stat.S_IMODE(source_stat.st_mode),',
          '        ]',
          'observed["events"]=events',
          'print(json.dumps(observed, sort_keys=True))',
        ].join('\n'),
        utility,
      ],
      { encoding: 'utf8' },
    );
    const observed = JSON.parse(sidecarProbe);
    expect(observed.normalizedBeforeBackup).toBe(true);
    expect(observed.sidecars).toEqual({
      '-wal': [true, true, true],
      '-shm': [true, true, true],
    });
    expect(observed.events).toEqual([
      'connect-source',
      'schema-version',
      'journal-mode',
      'normalize',
      'descriptor-proof',
      'connect-destination',
      'backup',
      'commit',
      'close-destination',
      'close-source',
      'normalize',
      'integrity',
    ]);
  });

  it('repairs a backup-time sidecar identity after the copy fails', () => {
    const failureProbe = execFileSync(
      'python3',
      [
        '-c',
        [
          'import importlib.util,json,os,pwd,stat,sys,tempfile',
          'from pathlib import Path',
          'spec=importlib.util.spec_from_file_location("local_backup", sys.argv[1])',
          'module=importlib.util.module_from_spec(spec)',
          'spec.loader.exec_module(module)',
          'events=[]',
          'observed={}',
          'class Destination:',
          '    def __init__(self, path):',
          '        self.path=Path(path)',
          '    def commit(self):',
          '        events.append("commit")',
          '    def close(self):',
          '        events.append("close-destination")',
          'class Source:',
          '    def __init__(self, path):',
          '        self.path=path',
          '    def execute(self, statement):',
          '        self.statement=statement',
          '        events.append("schema-version" if statement == "PRAGMA schema_version" else "journal-mode")',
          '        return self',
          '    def fetchone(self):',
          '        return ("delete",) if self.statement == "PRAGMA journal_mode" else (1,)',
          '    def backup(self, destination, **kwargs):',
          '        events.append("backup")',
          '        source_mode=stat.S_IMODE(os.stat(self.path).st_mode)',
          '        for suffix in ("-wal", "-shm"):',
          '            sidecar=Path(f"{self.path}{suffix}")',
          '            sidecar.write_bytes(suffix.encode())',
          '            sidecar.chmod(source_mode)',
          '        observed["createdOwners"]=[os.stat(f"{self.path}{suffix}").st_uid for suffix in ("-wal", "-shm")]',
          '        raise RuntimeError("forced backup failure")',
          '    def close(self):',
          '        events.append("close-source")',
          'def connect(target, **kwargs):',
          '    if isinstance(target, str):',
          '        events.append("connect-source")',
          '        return Source(Path(target.removeprefix("file:").removesuffix("?mode=ro")))',
          '    events.append("connect-destination")',
          '    return Destination(target)',
          'original_normalize=module.normalize_sqlite_sidecars',
          'def normalize(*args):',
          '    original_normalize(*args)',
          '    events.append("normalize")',
          'module.sqlite3.connect=connect',
          'module.require_sqlite_source_descriptors=lambda source, binding, previous, journal: None',
          'module.normalize_sqlite_sidecars=normalize',
          'with tempfile.TemporaryDirectory() as value:',
          '    root=Path(value)',
          '    source=root / "source.sqlite"',
          '    source.write_bytes(b"source")',
          '    source.chmod(0o600)',
          '    candidates=[entry for entry in pwd.getpwall() if 0 < entry.pw_uid < 2**31 and entry.pw_gid >= 0]',
          '    root_repair=os.geteuid() == 0 and bool(candidates)',
          '    if root_repair:',
          '        os.chown(source, candidates[-1].pw_uid, candidates[-1].pw_gid)',
          '    source_stat_before=os.stat(source)',
          '    try:',
          '        module.snapshot(source, root / "destination.sqlite")',
          '    except RuntimeError as error:',
          '        observed_error=str(error)',
          '    else:',
          '        raise AssertionError("snapshot unexpectedly passed")',
          '    source_stat=os.stat(source)',
          '    sidecars=[]',
          '    for suffix in ("-wal", "-shm"):',
          '        sidecar_stat=os.stat(f"{source}{suffix}")',
          '        sidecars.append([',
          '            sidecar_stat.st_uid == source_stat.st_uid,',
          '            sidecar_stat.st_gid == source_stat.st_gid,',
          '            stat.S_IMODE(sidecar_stat.st_mode) == stat.S_IMODE(source_stat.st_mode),',
          '        ])',
          '    observed.update({"error":observed_error,"events":events,"sidecars":sidecars,"rootRepair":root_repair,"sourceUid":source_stat_before.st_uid})',
          'print(json.dumps(observed, sort_keys=True))',
        ].join('\n'),
        utility,
      ],
      { encoding: 'utf8' },
    );
    const observed = JSON.parse(failureProbe);
    expect(observed).toMatchObject({
      error: 'forced backup failure',
      events: [
        'connect-source',
        'schema-version',
        'journal-mode',
        'normalize',
        'connect-destination',
        'backup',
        'close-destination',
        'close-source',
        'normalize',
      ],
      sidecars: [[true, true, true], [true, true, true]],
    });
    if (observed.rootRepair) {
      expect(observed.sourceUid).not.toBe(0);
      expect(observed.createdOwners).toEqual([0, 0]);
    }
  });

  it('does not mutate stable source-owned sidecars in the normalization-only flow', () => {
    const stableProbe = execFileSync(
      'python3',
      [
        '-c',
        [
          'import importlib.util,json,os,stat,sys,tempfile',
          'from pathlib import Path',
          'spec=importlib.util.spec_from_file_location("local_backup", sys.argv[1])',
          'module=importlib.util.module_from_spec(spec)',
          'spec.loader.exec_module(module)',
          'class Cursor:',
          '    def fetchone(self):',
          '        return (1,)',
          'class Source:',
          '    def execute(self, statement):',
          '        return Cursor()',
          '    def backup(self, destination, **kwargs):',
          '        destination.path.write_bytes(b"snapshot")',
          '    def close(self):',
          '        pass',
          'class Destination:',
          '    def __init__(self, path):',
          '        self.path=Path(path)',
          '    def commit(self):',
          '        pass',
          '    def close(self):',
          '        pass',
          'module.sqlite3.connect=lambda target, **kwargs: Source() if isinstance(target, str) else Destination(target)',
          'module.require_sqlite_source_descriptors=lambda source, binding, previous, journal: None',
          'module.integrity=lambda path: {"integrityCheck":"ok"}',
          'def identity(path):',
          '    observed=os.stat(path)',
          '    return [observed.st_dev,observed.st_ino,observed.st_uid,observed.st_gid,stat.S_IMODE(observed.st_mode),observed.st_size,observed.st_mtime_ns,observed.st_ctime_ns]',
          'with tempfile.TemporaryDirectory() as value:',
          '    root=Path(value)',
          '    source=root / "source.sqlite"',
          '    source.write_bytes(b"source")',
          '    source.chmod(0o600)',
          '    sidecars=[]',
          '    for suffix in ("-wal", "-shm"):',
          '        sidecar=Path(f"{source}{suffix}")',
          '        sidecar.write_bytes(suffix.encode())',
          '        sidecar.chmod(0o600)',
          '        sidecars.append(sidecar)',
          '    before=[identity(path) for path in sidecars]',
          '    bytes_before=[path.read_bytes().hex() for path in sidecars]',
          '    module.snapshot(source, root / "destination.sqlite")',
          '    after=[identity(path) for path in sidecars]',
          '    bytes_after=[path.read_bytes().hex() for path in sidecars]',
          'print(json.dumps({"identityStable":before == after,"bytesStable":bytes_before == bytes_after}))',
        ].join('\n'),
        utility,
      ],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(stableProbe)).toEqual({
      identityStable: true,
      bytesStable: true,
    });
  });

  it('normalizes simulated root-created sidecars to the bound source metadata', () => {
    const normalizationProbe = execFileSync(
      'python3',
      [
        '-c',
        [
          'import importlib.util,json,sys',
          'from pathlib import Path',
          'spec=importlib.util.spec_from_file_location("local_backup", sys.argv[1])',
          'module=importlib.util.module_from_spec(spec)',
          'spec.loader.exec_module(module)',
          'source_identity=module.FileIdentity(1,100,10001,10001,0o600)',
          'states={',
          '    "-wal":module.FileIdentity(1,201,0,0,0o640),',
          '    "-shm":module.FileIdentity(1,202,0,27,0o600),',
          '}',
          'descriptors={"-wal":20,"-shm":21}',
          'suffixes={value:key for key,value in descriptors.items()}',
          'events=[]',
          'def inspect(path):',
          '    suffix="-wal" if str(path).endswith("-wal") else "-shm"',
          '    return descriptors[suffix],states[suffix]',
          'def fstat(descriptor):',
          '    return source_identity if descriptor == 10 else states[suffixes[descriptor]]',
          'def fchown(descriptor, uid, gid):',
          '    suffix=suffixes[descriptor]',
          '    states[suffix]=states[suffix]._replace(uid=uid,gid=gid)',
          '    events.append(["fchown",suffix,uid,gid])',
          'def fchmod(descriptor, mode):',
          '    suffix=suffixes[descriptor]',
          '    states[suffix]=states[suffix]._replace(mode=mode)',
          '    events.append(["fchmod",suffix,mode])',
          'def fsync(descriptor):',
          '    events.append(["fsync",suffixes[descriptor]])',
          'module.inspect_sqlite_sidecar=inspect',
          'module.require_bound_path=lambda *args: None',
          'module.file_identity=lambda value: value',
          'module.os.fstat=fstat',
          'module.os.fchown=fchown',
          'module.os.fchmod=fchmod',
          'module.os.fsync=fsync',
          'module.os.close=lambda descriptor: None',
          'module.os.geteuid=lambda: 0',
          'module.fsync_directory=lambda path: events.append(["fsync-directory",str(path)])',
          'module.normalize_sqlite_sidecars(',
          '    Path("/srv/data/source.sqlite"),',
          '    module.BoundSource(10,source_identity),',
          '    {"-wal":None,"-shm":None},',
          ')',
          'print(json.dumps({',
          '    "events":events,',
          '    "metadata":[list(states[suffix][2:]) for suffix in ("-wal","-shm")],',
          '}, sort_keys=True))',
        ].join('\n'),
        utility,
      ],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(normalizationProbe)).toEqual({
      events: [
        ['fchown', '-wal', 10001, 10001],
        ['fchmod', '-wal', 384],
        ['fsync', '-wal'],
        ['fsync-directory', '/srv/data'],
        ['fchown', '-shm', 10001, 10001],
        ['fchmod', '-shm', 384],
        ['fsync', '-shm'],
        ['fsync-directory', '/srv/data'],
      ],
      metadata: [
        [10001, 10001, 384],
        [10001, 10001, 384],
      ],
    });
  });

  it('rejects symlinked, hardlinked, and wrong-owner SQLite sidecars before connect', () => {
    const unsafeProbe = execFileSync(
      'python3',
      [
        '-c',
        [
          'import importlib.util,json,os,sys,tempfile',
          'from pathlib import Path',
          'spec=importlib.util.spec_from_file_location("local_backup", sys.argv[1])',
          'module=importlib.util.module_from_spec(spec)',
          'spec.loader.exec_module(module)',
          'def rejected(kind):',
          '    with tempfile.TemporaryDirectory() as value:',
          '        root=Path(value)',
          '        source=root / "source.sqlite"',
          '        source.write_bytes(b"source")',
          '        sidecar=Path(f"{source}-wal")',
          '        if kind == "symlink":',
          '            target=root / "target"',
          '            target.write_bytes(b"target")',
          '            sidecar.symlink_to(target)',
          '        else:',
          '            sidecar.write_bytes(b"wal")',
          '            sidecar.chmod(source.stat().st_mode & 0o777)',
          '            if kind == "hardlink":',
          '                os.link(sidecar, root / "second-link")',
          '        binding=module.bind_source_database(source)',
          '        try:',
          '            expected=binding.identity',
          '            if kind == "wrong-owner":',
          '                expected=expected._replace(uid=expected.uid + 1)',
          '            try:',
          '                module.prevalidate_sqlite_sidecars(source, expected)',
          '            except SystemExit as error:',
          '                return str(error)',
          '            raise AssertionError(f"{kind} unexpectedly passed")',
          '        finally:',
          '            os.close(binding.descriptor)',
          'result={kind:rejected(kind) for kind in ("symlink","hardlink","wrong-owner")}',
          'with tempfile.TemporaryDirectory() as value:',
          '    root=Path(value)',
          '    source=root / "source.sqlite"',
          '    source.write_bytes(b"source")',
          '    target=root / "target"',
          '    target.write_bytes(b"target")',
          '    Path(f"{source}-wal").symlink_to(target)',
          '    original_bind=module.bind_source_database',
          '    captured={}',
          '    def traced_bind(path):',
          '        binding=original_bind(path)',
          '        captured["descriptor"]=binding.descriptor',
          '        return binding',
          '    module.bind_source_database=traced_bind',
          '    try:',
          '        module.snapshot(source, root / "destination.sqlite")',
          '    except SystemExit:',
          '        pass',
          '    else:',
          '        raise AssertionError("unsafe snapshot unexpectedly passed")',
          '    try:',
          '        os.fstat(captured["descriptor"])',
          '    except OSError:',
          '        result["snapshotClosesBinding"]=True',
          '    else:',
          '        result["snapshotClosesBinding"]=False',
          'print(json.dumps(result, sort_keys=True))',
        ].join('\n'),
        utility,
      ],
      { encoding: 'utf8' },
    );
    const rejected = JSON.parse(unsafeProbe);
    expect(rejected.symlink).toMatch(/sidecar.*unsafe/i);
    expect(rejected.hardlink).toMatch(/single-link/i);
    expect(rejected['wrong-owner']).toMatch(/ownership or mode/i);
    expect(rejected.snapshotClosesBinding).toBe(true);
  });

  it('normalizes root-created WAL state and reopens it as the source UID when permitted', () => {
    const uidProbe = execFileSync(
      'python3',
      [
        '-c',
        [
          'import importlib.util,json,os,pwd,sqlite3,stat,sys,tempfile',
          'from pathlib import Path',
          'spec=importlib.util.spec_from_file_location("local_backup", sys.argv[1])',
          'module=importlib.util.module_from_spec(spec)',
          'spec.loader.exec_module(module)',
          'result={"status":"skipped","reason":"requires root and POSIX credential switching"}',
          'candidates=[entry for entry in pwd.getpwall() if 0 < entry.pw_uid < 2**31 and entry.pw_gid >= 0]',
          'if os.geteuid() == 0 and hasattr(os, "fork") and candidates:',
          '    target=candidates[-1]',
          '    with tempfile.TemporaryDirectory() as value:',
          '        root=Path(value)',
          '        source=root / "source.sqlite"',
          '        child=os.fork()',
          '        if child == 0:',
          '            try:',
          '                database=sqlite3.connect(source)',
          '                mode=database.execute("PRAGMA journal_mode=WAL").fetchone()[0]',
          '                database.execute("CREATE TABLE proof(value INTEGER NOT NULL)")',
          '                database.execute("INSERT INTO proof(value) VALUES (7)")',
          '                database.commit()',
          '                os._exit(0 if mode.lower() == "wal" else 3)',
          '            except BaseException:',
          '                os._exit(4)',
          '        _, producer_status=os.waitpid(child, 0)',
          '        if os.waitstatus_to_exitcode(producer_status) != 0 or not all(Path(f"{source}{suffix}").is_file() for suffix in ("-wal", "-shm")):',
          '            result={"status":"skipped","reason":"platform did not retain WAL sidecars"}',
          '        else:',
          '            os.chown(root, target.pw_uid, target.pw_gid)',
          '            root.chmod(0o700)',
          '            os.chown(source, target.pw_uid, target.pw_gid)',
          '            source.chmod(0o600)',
          '            binding=module.bind_source_database(source)',
          '            try:',
          '                module.normalize_sqlite_sidecars(source, binding, {"-wal":None,"-shm":None})',
          '            finally:',
          '                os.close(binding.descriptor)',
          '            metadata=[]',
          '            for suffix in ("-wal", "-shm"):',
          '                observed=os.stat(f"{source}{suffix}")',
          '                metadata.append([observed.st_uid,observed.st_gid,stat.S_IMODE(observed.st_mode)])',
          '            reader=os.fork()',
          '            if reader == 0:',
          '                try:',
          '                    os.setgroups([])',
          '                    os.setgid(target.pw_gid)',
          '                    os.setuid(target.pw_uid)',
          '                    database=sqlite3.connect(f"{source.as_uri()}?mode=ro", uri=True)',
          '                    value=database.execute("SELECT value FROM proof").fetchone()[0]',
          '                    database.close()',
          '                    os._exit(0 if value == 7 else 5)',
          '                except BaseException:',
          '                    os._exit(6)',
          '            _, reader_status=os.waitpid(reader, 0)',
          '            result={',
          '                "status":"passed" if os.waitstatus_to_exitcode(reader_status) == 0 else "failed",',
          '                "metadata":metadata,',
          '                "expected":[target.pw_uid,target.pw_gid,0o600],',
          '            }',
          'print(json.dumps(result, sort_keys=True))',
        ].join('\n'),
        utility,
      ],
      { encoding: 'utf8' },
    );
    const observed = JSON.parse(uidProbe);
    expect(['passed', 'skipped']).toContain(observed.status);
    if (observed.status === 'passed') {
      expect(observed.metadata).toEqual([observed.expected, observed.expected]);
    } else {
      expect(observed.reason).toMatch(/requires root|platform did not retain/);
    }
  });

  it('durably installs backup bytes and namespace entries before publishing evidence', () => {
    const durabilityProbe = execFileSync(
      'python3',
      [
        '-c',
        [
          'import importlib.util,json,sys,tempfile',
          'from pathlib import Path',
          'spec=importlib.util.spec_from_file_location("local_backup", sys.argv[1])',
          'module=importlib.util.module_from_spec(spec)',
          'spec.loader.exec_module(module)',
          'events=[]',
          'original_replace=module.os.replace',
          'with tempfile.TemporaryDirectory() as value:',
          '    root=Path(value)',
          '    temporary=root / ".artifact.tmp"',
          '    destination=root / "artifact"',
          '    temporary.write_bytes(b"durable recovery point")',
          '    module.fsync_regular_file=lambda path: events.append(f"file:{Path(path).name}")',
          '    module.fsync_directory=lambda path: events.append("directory:parent" if Path(path) == root else f"directory:{Path(path).name}")',
          '    def traced_replace(source, target):',
          '        events.append(f"replace:{Path(source).name}->{Path(target).name}")',
          '        original_replace(source, target)',
          '    module.os.replace=traced_replace',
          '    module.durable_replace(temporary, destination)',
          '    module.os.replace=original_replace',
          'print(json.dumps(events))',
        ].join('\n'),
        utility,
      ],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(durabilityProbe)).toEqual([
      'file:.artifact.tmp',
      'replace:.artifact.tmp->artifact',
      'file:artifact',
      'directory:parent',
    ]);

    const source = readFileSync(utility, 'utf8');
    const installPair = source.slice(
      source.indexOf('def install_pair('),
      source.indexOf('\ndef prune('),
    );
    expect(installPair.indexOf('durable_replace(temporary, destination)'))
      .toBeLessThan(installPair.indexOf('durable_replace(checksum_temporary, checksum_path)'));
    const backupFlow = source.slice(
      source.indexOf('def backup('),
      source.indexOf('\ndef newest_backup('),
    );
    expect(backupFlow.indexOf('install_pair('))
      .toBeLessThan(backupFlow.indexOf('write_json_atomic(state / "last-success.json"'));
  });

  it('creates encrypted tier points and verifies a plaintext-free restore', () => {
    const fixture = createFixture();
    try {
      const created = run(fixture, 'backup');
      expect(created.status, created.stderr).toBe(0);
      const receipt = JSON.parse(created.stdout);
      expect(receipt).toMatchObject({
        schema: 'nexus.local-backup.v1',
        status: 'passed',
        kind: 'backup',
        integrityCheck: 'ok',
        foreignKeyCheck: 'ok',
        retention: {
          hourly: 24,
          daily: 30,
          weekly: 4,
          'pre-promotion': 10,
        },
      });
      expect(new Date(receipt.startedAt).toISOString()).toBe(receipt.startedAt);
      expect(Date.parse(receipt.completedAt)).toBeGreaterThanOrEqual(Date.parse(receipt.startedAt));
      for (const tier of ['hourly', 'daily', 'weekly']) {
        const files = readdirSync(join(fixture.backupRoot, tier));
        expect(files.filter((file) => file.endsWith('.age'))).toHaveLength(1);
        expect(files.filter((file) => file.endsWith('.sha256'))).toHaveLength(1);
      }

      const verified = run(fixture, 'restore-verify');
      expect(verified.status, verified.stderr).toBe(0);
      const verificationReceipt = JSON.parse(verified.stdout);
      expect(verificationReceipt).toMatchObject({
        schema: 'nexus.local-backup-restore-verification.v1',
        status: 'passed',
        integrityCheck: 'ok',
        foreignKeyCheck: 'ok',
      });
      expect(new Date(verificationReceipt.verifiedAt).toISOString())
        .toBe(verificationReceipt.verifiedAt);
      expect(readdirSync(fixture.backupRoot)).not.toContain('restored.sqlite');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('creates a separate pre-promotion point and rejects checksum drift', () => {
    const fixture = createFixture();
    try {
      const created = run(fixture, 'pre-promotion');
      expect(created.status, created.stderr).toBe(0);
      const receipt = JSON.parse(created.stdout);
      const backup = receipt.installed['pre-promotion'] as string;
      writeFileSync(`${backup}.sha256`, `${'0'.repeat(64)}  ${backup.split('/').at(-1)}\n`);

      const verify = run(fixture, 'restore-verify', '--backup', backup);
      expect(verify.status).not.toBe(0);
      expect(verify.stderr).toContain('encrypted backup checksum is not canonical');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    ['missing', (checksum: string) => rmSync(checksum)],
    ['wrong basename', (checksum: string, artifact: string, digest: string) => {
      writeFileSync(checksum, `${digest}  wrong.sqlite.age\n`);
    }],
    ['trailing bytes', (checksum: string, artifact: string, digest: string) => {
      writeFileSync(checksum, `${digest}  ${artifact.split('/').at(-1)}\nextra\n`);
    }],
    ['invalid UTF-8', (checksum: string) => writeFileSync(checksum, Buffer.from([0xff, 0x0a]))],
    ['hardlink', (checksum: string) => linkSync(checksum, `${checksum}.second-link`)],
    ['unsafe mode', (checksum: string) => chmodSync(checksum, 0o640)],
  ])('rejects a %s checksum at both freshness and restore seams', (_label, mutate) => {
    const fixture = createFixture();
    try {
      const created = run(fixture, 'backup');
      expect(created.status, created.stderr).toBe(0);
      const receipt = JSON.parse(created.stdout);
      const artifact = receipt.installed.hourly as string;
      mutate(`${artifact}.sha256`, artifact, receipt.encryptedSha256 as string);

      const freshness = run(fixture, 'verify-freshness', '--max-age-hours', '26');
      expect(freshness.status).not.toBe(0);
      const restore = run(fixture, 'restore-verify', '--backup', artifact);
      expect(restore.status).not.toBe(0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked governed backup tier at freshness and restore seams', () => {
    const fixture = createFixture();
    try {
      const created = run(fixture, 'backup');
      expect(created.status, created.stderr).toBe(0);
      const artifact = JSON.parse(created.stdout).installed.hourly as string;
      const hourly = join(fixture.backupRoot, 'hourly');
      const parked = join(fixture.backupRoot, 'hourly-parked');
      renameSync(hourly, parked);
      symlinkSync(parked, hourly, 'dir');

      expect(run(fixture, 'verify-freshness', '--max-age-hours', '26').status).not.toBe(0);
      expect(run(fixture, 'restore-verify', '--backup', artifact).status).not.toBe(0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('decrypts only private descriptor copies after the governed artifact and identity are swapped', () => {
    const fixture = createFixture();
    try {
      const created = run(fixture, 'backup');
      expect(created.status, created.stderr).toBe(0);
      const artifact = JSON.parse(created.stdout).installed.hourly as string;
      const observed = join(fixture.root, 'decrypt-argv');
      writeFileSync(fixture.fakeAge, [
        '#!/bin/sh',
        'set -eu',
        `mv ${JSON.stringify(artifact)} ${JSON.stringify(`${artifact}.parked`)}`,
        `printf corrupt > ${JSON.stringify(artifact)}`,
        `chmod 600 ${JSON.stringify(artifact)}`,
        `mv ${JSON.stringify(fixture.identity)} ${JSON.stringify(`${fixture.identity}.parked`)}`,
        `printf invalid > ${JSON.stringify(fixture.identity)}`,
        `chmod 600 ${JSON.stringify(fixture.identity)}`,
        `printf '%s\\n' "$@" > ${JSON.stringify(observed)}`,
        'output=""',
        'input=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    --encrypt|--decrypt) shift ;;',
        '    --recipient|--identity) shift 2 ;;',
        '    --output) output="$2"; shift 2 ;;',
        '    *) input="$1"; shift ;;',
        '  esac',
        'done',
        'cp "$input" "$output"',
        '',
      ].join('\n'), { mode: 0o755 });
      chmodSync(fixture.fakeAge, 0o755);

      const restored = run(fixture, 'restore-verify', '--backup', artifact);
      expect(restored.status, restored.stderr).toBe(0);
      const argv = readFileSync(observed, 'utf8').trim().split('\n');
      const identityArgument = argv[argv.indexOf('--identity') + 1];
      const inputArgument = argv.at(-1)!;
      expect(identityArgument).toContain(`${fixture.backupRoot}/.restore-`);
      expect(inputArgument).toContain(`${fixture.backupRoot}/.restore-`);
      expect(identityArgument).not.toBe(fixture.identity);
      expect(inputArgument).not.toBe(artifact);
      expect(readFileSync(artifact, 'utf8')).toBe('corrupt');
      expect(readFileSync(fixture.identity, 'utf8')).toBe('invalid');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('durably creates the backup lock once and reuses the same governed inode', () => {
    const fixture = createFixture();
    try {
      const first = run(fixture, 'backup');
      expect(first.status, first.stderr).toBe(0);
      const lock = join(fixture.backupRoot, '.backup.lock');
      const initial = statSync(lock);
      execFileSync('/bin/sleep', ['1.1']);
      const second = run(fixture, 'backup');
      expect(second.status, second.stderr).toBe(0);
      const existing = statSync(lock);
      expect(existing.ino).toBe(initial.ino);
      expect(existing.size).toBe(0);
      expect(existing.nlink).toBe(1);
      expect(existing.mode & 0o777).toBe(0o600);
      const source = readFileSync(utility, 'utf8');
      expect(source).toContain('flags | os.O_CREAT | os.O_EXCL');
      expect(source).toContain('except FileExistsError:');
      expect(source).toContain('if created:\n                os.fsync(lock_descriptor)');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('uses a required integer boot-time clock in production and a cross-process test clock', () => {
    const probe = spawnSync('python3', [
      '-c',
      [
        'import importlib.util,os,sys',
        'os.environ.pop("NEXUS_LOCAL_BACKUP_TEST_MODE",None)',
        'spec=importlib.util.spec_from_file_location("local_backup",sys.argv[1])',
        'module=importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(module)',
        'observed=[]',
        'module.time.CLOCK_BOOTTIME=777',
        'module.time.clock_gettime_ns=lambda clock_id: observed.append(clock_id) or 123',
        'assert module.retry_clock_ns() == 123',
        'assert observed == [777]',
        'delattr(module.time,"CLOCK_BOOTTIME")',
        'try:',
        '  module.retry_clock_ns()',
        'except SystemExit as error:',
        '  assert "boot-time retry clock is unavailable" in str(error.code)',
        'else:',
        '  raise AssertionError("missing CLOCK_BOOTTIME was accepted")',
        'os.environ["NEXUS_LOCAL_BACKUP_TEST_MODE"]="1"',
        'module.time.time_ns=lambda:456',
        'assert module.retry_clock_ns() == 456',
      ].join('\n'),
      utility,
    ], { encoding: 'utf8' });
    expect(probe.status, probe.stderr).toBe(0);
  });

  it('persists immediate exit75 catch-up retries and clears them after the lock is available', async () => {
    const fixture = createFixture();
    const retryDirectory = join(fixture.root, 'retry-state');
    mkdirSync(retryDirectory, { mode: 0o700 });
    chmodSync(retryDirectory, 0o700);
    const scheduled = (...args: string[]) => spawnSync(
      'python3',
      [utility, '--config', fixture.config, ...args],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          NEXUS_LOCAL_BACKUP_TEST_MODE: '1',
          NEXUS_LOCAL_BACKUP_TEST_TRUST_ANCHOR: fixture.root,
          NEXUS_LOCAL_BACKUP_TEST_RETRY_DIRECTORY: retryDirectory,
          NEXUS_LOCAL_BACKUP_AGE_BIN: fixture.fakeAge,
        },
      },
    );
    try {
      const seeded = scheduled('backup');
      expect(seeded.status, seeded.stderr).toBe(0);
      const holder = spawn('python3', [
        '-c',
        [
          'import importlib.util, os, pathlib, sys, time',
          'os.environ["NEXUS_LOCAL_BACKUP_TEST_MODE"]="1"',
          'os.environ["NEXUS_LOCAL_BACKUP_TEST_TRUST_ANCHOR"]=str(pathlib.Path(sys.argv[2]).parent)',
          'spec=importlib.util.spec_from_file_location("local_backup",sys.argv[1])',
          'module=importlib.util.module_from_spec(spec)',
          'spec.loader.exec_module(module)',
          'with module.backup_lock(pathlib.Path(sys.argv[2])):',
          '  print("ready",flush=True)',
          '  time.sleep(10)',
        ].join('\n'),
        utility,
        fixture.backupRoot,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      await once(holder.stdout, 'data');

      const backupContended = scheduled('backup');
      const restoreContended = scheduled('restore-verify');
      expect(backupContended.status, backupContended.stderr).toBe(75);
      expect(restoreContended.status, restoreContended.stderr).toBe(75);
      expect(JSON.parse(readFileSync(join(retryDirectory, 'backup.json'), 'utf8')))
        .toMatchObject({ schema: 'nexus.local-backup-lock-retry.v1', attempts: 1 });
      expect(JSON.parse(readFileSync(join(retryDirectory, 'restore-verify.json'), 'utf8')))
        .toMatchObject({ schema: 'nexus.local-backup-lock-retry.v1', attempts: 1 });

      holder.kill('SIGTERM');
      await once(holder, 'exit');
      execFileSync('/bin/sleep', ['1.1']);
      const backupAfterRelease = scheduled('backup');
      expect(backupAfterRelease.status, backupAfterRelease.stderr).toBe(0);
      const restoreAfterRelease = scheduled('restore-verify');
      expect(restoreAfterRelease.status, restoreAfterRelease.stderr).toBe(0);
      expect(() => statSync(join(retryDirectory, 'backup.json'))).toThrow();
      expect(() => statSync(join(retryDirectory, 'restore-verify.json'))).toThrow();
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('caps catch-up contention at 45 attempts and converts exhaustion to ordinary failure', () => {
    const fixture = createFixture();
    const retryDirectory = join(fixture.root, 'retry-state');
    mkdirSync(retryDirectory, { mode: 0o700 });
    chmodSync(retryDirectory, 0o700);
    try {
      expect(run(fixture, 'backup').status).toBe(0);
      const probe = spawnSync('python3', [
        '-c',
        [
          'import importlib.util, json, os, pathlib, sys',
          'os.environ["NEXUS_LOCAL_BACKUP_TEST_MODE"]="1"',
          'os.environ["NEXUS_LOCAL_BACKUP_TEST_TRUST_ANCHOR"]=str(pathlib.Path(sys.argv[2]).parent)',
          'os.environ["NEXUS_LOCAL_BACKUP_TEST_RETRY_DIRECTORY"]=sys.argv[3]',
          'spec=importlib.util.spec_from_file_location("local_backup",sys.argv[1])',
          'module=importlib.util.module_from_spec(spec)',
          'spec.loader.exec_module(module)',
          'module.retry_clock_ns=lambda:1000',
          'def blocked(*_args): raise BlockingIOError()',
          'module.fcntl.flock=blocked',
          'root=pathlib.Path(sys.argv[2])',
          'for expected in range(1,46):',
          '  try:',
          '    with module.backup_lock(root,retry_source="backup"): pass',
          '  except SystemExit as error:',
          '    assert error.code == 75, error.code',
          '  state=json.loads((pathlib.Path(sys.argv[3])/"backup.json").read_text())',
          '  assert state["attempts"] == expected',
          'try:',
          '  with module.backup_lock(root,retry_source="backup"): pass',
          'except SystemExit as error:',
          '  assert error.code != 75',
          'else:',
          '  raise AssertionError("exhaustion unexpectedly acquired the lock")',
          'assert not (pathlib.Path(sys.argv[3])/"backup.json").exists()',
          'retry=pathlib.Path(sys.argv[3])/"backup.json"',
          'module.fcntl.flock=lambda *_args:None',
          'module.write_retry_state(retry,{"schema":module.LOCK_RETRY_SCHEMA,"source":"backup","startedBoottimeNs":1000,"attempts":1})',
          'module.retry_clock_ns=lambda:1000+module.LOCK_RETRY_WINDOW_NS',
          'entered=False',
          'try:',
          '  with module.backup_lock(root,retry_source="backup"): entered=True',
          'except SystemExit as error:',
          '  assert error.code != 75',
          'assert not entered and not retry.exists()',
          'module.retry_clock_ns=lambda:1000',
          'module.write_retry_state(retry,{"schema":module.LOCK_RETRY_SCHEMA,"source":"backup","startedBoottimeNs":1000,"attempts":45})',
          'entered=False',
          'try:',
          '  with module.backup_lock(root,retry_source="backup"): entered=True',
          'except SystemExit as error:',
          '  assert error.code != 75',
          'assert not entered and not retry.exists()',
        ].join('\n'),
        utility,
        fixture.backupRoot,
        retryDirectory,
      ], { encoding: 'utf8' });
      expect(probe.status, probe.stderr).toBe(0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects expired or capped cross-process retry state before acquiring a free lock', () => {
    const fixture = createFixture();
    const retryDirectory = join(fixture.root, 'retry-state');
    mkdirSync(retryDirectory, { mode: 0o700 });
    chmodSync(retryDirectory, 0o700);
    const retryState = join(retryDirectory, 'backup.json');
    const scheduledBackup = () => spawnSync(
      'python3',
      [utility, '--config', fixture.config, 'backup'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          NEXUS_LOCAL_BACKUP_TEST_MODE: '1',
          NEXUS_LOCAL_BACKUP_TEST_TRUST_ANCHOR: fixture.root,
          NEXUS_LOCAL_BACKUP_TEST_RETRY_DIRECTORY: retryDirectory,
          NEXUS_LOCAL_BACKUP_AGE_BIN: fixture.fakeAge,
        },
      },
    );
    const writeState = (startedBoottimeNs: bigint, attempts: number) => {
      writeFileSync(
        retryState,
        '{'
          + `"attempts":${attempts},`
          + '"schema":"nexus.local-backup-lock-retry.v1",'
          + '"source":"backup",'
          + `"startedBoottimeNs":${startedBoottimeNs}`
          + '}\n',
        { mode: 0o600 },
      );
      chmodSync(retryState, 0o600);
    };
    try {
      expect(run(fixture, 'backup').status).toBe(0);
      const wallNowNs = BigInt(Date.now()) * 1_000_000n;
      writeState(wallNowNs - (45n * 60n * 1_000_000_000n), 1);
      const expired = scheduledBackup();
      expect(expired.status, expired.stderr).toBe(1);
      expect(expired.stderr).toContain('retry deadline or attempt limit was exhausted');
      expect(() => statSync(retryState)).toThrow();

      writeState(wallNowNs - 1_000_000_000n, 45);
      const capped = scheduledBackup();
      expect(capped.status, capped.stderr).toBe(1);
      expect(capped.stderr).toContain('retry deadline or attempt limit was exhausted');
      expect(() => statSync(retryState)).toThrow();
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('verifies the hourly receipt when an existing daily point is retained', () => {
    const fixture = createFixture();
    try {
      const now = new Date();
      const dailyName = [
        'nexus-db-',
        now.getUTCFullYear(),
        String(now.getUTCMonth() + 1).padStart(2, '0'),
        String(now.getUTCDate()).padStart(2, '0'),
        '.sqlite.age',
      ].join('');
      const dailyDirectory = join(fixture.backupRoot, 'daily');
      mkdirSync(dailyDirectory, { recursive: true, mode: 0o700 });
      const daily = join(dailyDirectory, dailyName);
      writeFileSync(daily, 'retained-daily-point', { mode: 0o600 });
      writeFileSync(
        `${daily}.sha256`,
        `49969c8d90b57d48cb9c0dbc2fd7034ec79dc42ae253b7c2134a75ef4ed68036  ${dailyName}\n`,
        { mode: 0o600 },
      );

      const created = run(fixture, 'backup');
      expect(created.status, created.stderr).toBe(0);
      const receipt = JSON.parse(created.stdout);
      expect(receipt.installed.daily).toBe(daily);
      expect(receipt.installed.hourly).not.toBe(daily);

      const freshness = run(fixture, 'verify-freshness', '--max-age-hours', '26');
      expect(freshness.status, freshness.stderr).toBe(0);
      expect(JSON.parse(freshness.stdout)).toMatchObject({
        schema: 'nexus.local-backup-freshness.v1',
        status: 'passed',
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('prunes every local tier to its explicit count limit', () => {
    const fixture = createFixture();
    try {
      const seed = (tier: string, names: string[]) => {
        const directory = join(fixture.backupRoot, tier);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        for (const name of names) {
          writeFileSync(join(directory, name), 'encrypted', { mode: 0o600 });
          writeFileSync(
            join(directory, `${name}.sha256`),
            `954d1bb83d80bb6f6e746b28f0de3ec4c4ed980cfe67ed23a9159cd464ff339a  ${name}\n`,
            { mode: 0o600 },
          );
        }
      };
      seed(
        'hourly',
        Array.from(
          { length: 30 },
          (_, index) => `nexus-db-20260101T${String(index).padStart(2, '0')}0000Z.sqlite.age`,
        ),
      );
      seed(
        'daily',
        Array.from(
          { length: 35 },
          (_, index) => `nexus-db-202601${String(index + 1).padStart(2, '0')}.sqlite.age`,
        ),
      );
      seed(
        'weekly',
        Array.from(
          { length: 6 },
          (_, index) => `nexus-db-2025-W${String(index + 1).padStart(2, '0')}.sqlite.age`,
        ),
      );

      const created = run(fixture, 'backup');
      expect(created.status, created.stderr).toBe(0);
      const count = (tier: string) =>
        readdirSync(join(fixture.backupRoot, tier))
          .filter((file) => file.endsWith('.age')).length;
      expect(count('hourly')).toBe(24);
      expect(count('daily')).toBe(30);
      expect(count('weekly')).toBe(4);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('ships narrow inactive systemd assets for backup and restore verification', () => {
    const installer = readFileSync('scripts/local-backup-systemd-install.sh', 'utf8');
    const retryLauncher = readFileSync('scripts/local-backup-retry-launcher.sh', 'utf8');
    const sudoers = readFileSync('ops/local-backup/nexus-local-backup.sudoers', 'utf8');
    const prePromotion = readFileSync(
      'ops/local-backup/systemd/nexus-local-backup-pre-promotion.service',
      'utf8',
    );
    const timer = readFileSync(
      'ops/local-backup/systemd/nexus-local-backup.timer',
      'utf8',
    );
    const hourly = readFileSync(
      'ops/local-backup/systemd/nexus-local-backup.service',
      'utf8',
    );
    const restoreVerify = readFileSync(
      'ops/local-backup/systemd/nexus-local-backup-restore-verify.service',
      'utf8',
    );
    const verifyTimer = readFileSync(
      'ops/local-backup/systemd/nexus-local-backup-restore-verify.timer',
      'utf8',
    );
    const policy = JSON.parse(readFileSync('config/continuous-deployment.json', 'utf8'));
    const releaseBackup = readFileSync('scripts/lib/release-backup.mjs', 'utf8');
    const snapshotTimeoutSeconds = 18 * 60;

    expect(() => execFileSync('bash', ['-n', 'scripts/local-backup-systemd-install.sh']))
      .not.toThrow();
    expect(() => execFileSync('bash', ['-n', 'scripts/local-backup-retry-launcher.sh']))
      .not.toThrow();
    expect(installer).toContain(
      'validate_root_path_chain "$SOURCE_ROOT" "local backup source root"',
    );
    expect(installer).toContain(
      'validate_root_path_chain "$SOURCE_ROOT/$source" "local backup asset ($source)"',
    );
    expect(installer).toContain('[ -x /usr/bin/timeout ] && [ -x /usr/bin/sleep ]');
    expect(installer).toContain('validate_optional_directory_chain');
    expect(installer).toContain('validate_optional_installed_file');
    const installerPreflight = installer.indexOf(
      'validate_optional_installed_file "$destination"',
    );
    const producerInstall = installer.indexOf(
      'install -o root -g root -m 0755',
      installerPreflight,
    );
    expect(installerPreflight).toBeGreaterThanOrEqual(0);
    expect(producerInstall).toBeGreaterThan(installerPreflight);
    expect(installer).toContain('destination_ancestor_identity');
    expect(installer).toContain('DESTINATION_ANCESTORS_BEFORE');
    expect(installer).toContain('destination ancestors changed during byte proof');
    expect(installer).toContain('destination ancestors changed during systemd proof');
    expect(installer).toContain('durably_sync_installed_authority()');
    const durabilityCall = installer.lastIndexOf('\ndurably_sync_installed_authority \\');
    const durabilityIdentityRecheck = installer.indexOf(
      'destination files changed during durability proof',
      durabilityCall,
    );
    const daemonReload = installer.indexOf('systemctl daemon-reload', durabilityCall);
    expect(durabilityCall).toBeGreaterThan(producerInstall);
    expect(durabilityIdentityRecheck).toBeGreaterThan(durabilityCall);
    expect(daemonReload).toBeGreaterThan(durabilityIdentityRecheck);
    expect(installer.slice(0, daemonReload)).toContain('sync -f "$target"');
    expect(installer).toContain('cmp -s -- "$SOURCE_ROOT/scripts/local-backup.py"');
    expect(installer).toContain(
      'cmp -s -- "$SOURCE_ROOT/scripts/local-backup-retry-launcher.sh"',
    );
    expect(installer).toContain(
      'visudo -cf "$SOURCE_ROOT/ops/local-backup/nexus-local-backup.sudoers"',
    );
    expect(installer).toContain('installed local backup executable is unsafe');
    expect(installer).toContain('visudo -cf /etc/sudoers.d/nexus-local-backup');
    expect(installer).not.toContain('/srv/nexus-backups/sonarqube');
    expect(installer).not.toMatch(/systemctl\s+enable/);
    expect(sudoers).toContain(
      '/usr/bin/systemctl start nexus-local-backup-pre-promotion.service',
    );
    expect(sudoers).not.toContain('/usr/local/libexec/nexus-local-backup/local-backup.py');
    expect(prePromotion).toContain('local-backup.py pre-promotion');
    expect(prePromotion).toContain('TimeoutStartSec=18min');
    expect(prePromotion).not.toContain('RuntimeDirectoryPreserve=restart');
    expect(prePromotion).not.toContain('RestartForceExitStatus=75');
    expect(prePromotion).not.toContain('SuccessExitStatus=75');
    expect(hourly).toContain('TimeoutStartSec=67min');
    expect(restoreVerify).toContain('TimeoutStartSec=85min');
    expect(hourly).toContain('local-backup-retry-launcher.sh backup');
    expect(restoreVerify).toContain('local-backup-retry-launcher.sh restore-verify');
    expect(retryLauncher).toContain('readonly work_timeout=18m');
    expect(retryLauncher).toContain('readonly work_timeout=36m');
    expect(retryLauncher).toContain('if test "$status" -ne 75; then');
    expect(retryLauncher).toContain('"$sleep_bin" 60');
    expect(retryLauncher).not.toContain('--foreground');
    const prePromotionWritablePaths =
      'ReadWritePaths=/srv/nexus-backups/application '
      + '-/home/dominguez/telegram-hub-bot/data '
      + '-/var/lib/nexus-hub/production/data';
    const hourlyWritablePaths =
      'ReadWritePaths=/srv/nexus-backups/application '
      + '/var/lib/nexus-release/operational-alerts '
      + '-/home/dominguez/telegram-hub-bot/data '
      + '-/var/lib/nexus-hub/production/data';
    expect(prePromotion).toContain(prePromotionWritablePaths);
    expect(hourly).toContain(hourlyWritablePaths);
    expect(prePromotion).not.toContain('telegram-hub-bot-staging');
    expect(hourly).not.toContain('telegram-hub-bot-staging');
    expect(policy.timing.backupTimeoutSeconds).toBe(22 * 60);
    expect(snapshotTimeoutSeconds).toBeLessThan(policy.timing.backupTimeoutSeconds);
    expect(releaseBackup.indexOf('policy.timing.backupTimeoutSeconds'))
      .toBeLessThan(releaseBackup.indexOf("exec(systemctlBin, ['start', PRE_MIGRATION_BACKUP_UNIT]"));
    expect(releaseBackup).toContain(
      "exec(systemctlBin, ['start', PRE_MIGRATION_BACKUP_UNIT], { timeoutMs })",
    );
    expect(prePromotion).not.toContain('ConditionPathExists');
    expect(hourly).not.toContain('ConditionPathExists');
    expect(restoreVerify).not.toContain('ConditionPathExists');
    expect(timer).toContain('OnCalendar=hourly');
    expect(verifyTimer).toContain('OnCalendar=Sun *-*-* 04:15:00 UTC');
    expect(verifyTimer).toContain('AccuracySec=1m');
    expect(verifyTimer).not.toContain('RandomizedDelaySec');
    expect(hourly).not.toContain('RestartForceExitStatus');
    expect(restoreVerify).not.toContain('RestartForceExitStatus');
    expect(hourly).not.toContain('RuntimeDirectoryPreserve');
    expect(restoreVerify).not.toContain('RuntimeDirectoryPreserve');
    expect(hourly).not.toContain('RestartSec');
    expect(restoreVerify).not.toContain('RestartSec');
  });

  it('retries only exact lock contention inside one bounded oneshot activation', () => {
    const root = mkdtempSync(join(tmpdir(), 'nexus-local-backup-retry-launcher-'));
    chmodSync(root, 0o700);
    const launcher = join(root, 'launcher.sh');
    const producer = join(root, 'producer.sh');
    const timeout = join(root, 'timeout.sh');
    const sleep = join(root, 'sleep.sh');
    const plan = join(root, 'plan');
    const calls = join(root, 'calls');
    const timeouts = join(root, 'timeouts');
    const sleeps = join(root, 'sleeps');
    try {
      writeFileSync(producer, [
        '#!/bin/sh',
        `calls=${JSON.stringify(calls)}`,
        `plan=${JSON.stringify(plan)}`,
        'printf "%s\\n" "$1" >>"$calls"',
        'attempt="$(wc -l <"$calls" | tr -d " ")"',
        'status="$(sed -n "${attempt}p" "$plan")"',
        'exit "$status"',
        '',
      ].join('\n'), { mode: 0o700 });
      writeFileSync(timeout, [
        '#!/bin/sh',
        `printf '%s\\n' "$3" >>${JSON.stringify(timeouts)}`,
        'shift 3',
        'exec "$@"',
        '',
      ].join('\n'), { mode: 0o700 });
      writeFileSync(sleep, [
        '#!/bin/sh',
        `printf '%s\\n' "$1" >>${JSON.stringify(sleeps)}`,
        '',
      ].join('\n'), { mode: 0o700 });
      const source = readFileSync('scripts/local-backup-retry-launcher.sh', 'utf8')
        .replace('/usr/local/libexec/nexus-local-backup/local-backup.py', producer)
        .replace('/usr/bin/timeout', timeout)
        .replace('/usr/bin/sleep', sleep);
      writeFileSync(launcher, source, { mode: 0o700 });
      chmodSync(launcher, 0o700);

      writeFileSync(plan, '75\n75\n0\n', { mode: 0o600 });
      const recovered = spawnSync(launcher, ['backup'], { encoding: 'utf8' });
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(readFileSync(calls, 'utf8')).toBe('backup\nbackup\nbackup\n');
      expect(readFileSync(timeouts, 'utf8')).toBe('18m\n18m\n18m\n');
      expect(readFileSync(sleeps, 'utf8')).toBe('60\n60\n');

      writeFileSync(plan, '75\n42\n', { mode: 0o600 });
      writeFileSync(calls, '', { mode: 0o600 });
      writeFileSync(timeouts, '', { mode: 0o600 });
      writeFileSync(sleeps, '', { mode: 0o600 });
      const failed = spawnSync(launcher, ['restore-verify'], { encoding: 'utf8' });
      expect(failed.status, failed.stderr).toBe(42);
      expect(readFileSync(calls, 'utf8')).toBe('restore-verify\nrestore-verify\n');
      expect(readFileSync(timeouts, 'utf8')).toBe('36m\n36m\n');
      expect(readFileSync(sleeps, 'utf8')).toBe('60\n');

      expect(spawnSync(launcher, [], { encoding: 'utf8' }).status).toBe(64);
      expect(spawnSync(launcher, ['backup', 'extra'], { encoding: 'utf8' }).status).toBe(64);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bounds the complete producer process group on Linux', () => {
    if (process.platform !== 'linux') return;
    const root = mkdtempSync(join(tmpdir(), 'nexus-local-backup-timeout-group-'));
    chmodSync(root, 0o700);
    const launcher = join(root, 'launcher.sh');
    const producer = join(root, 'producer.sh');
    const childPidFile = join(root, 'child.pid');
    let childPid = 0;
    try {
      writeFileSync(producer, [
        '#!/bin/sh',
        "trap '' TERM",
        '(',
        "  trap '' TERM",
        '  while :; do /bin/sleep 1; done',
        ') &',
        `printf '%s\\n' "$!" >${JSON.stringify(childPidFile)}`,
        'wait',
        '',
      ].join('\n'), { mode: 0o700 });
      const source = readFileSync('scripts/local-backup-retry-launcher.sh', 'utf8')
        .replace('/usr/local/libexec/nexus-local-backup/local-backup.py', producer)
        .replace('readonly work_timeout=18m', 'readonly work_timeout=1s')
        .replace('--kill-after=3m', '--kill-after=1s');
      writeFileSync(launcher, source, { mode: 0o700 });
      chmodSync(launcher, 0o700);
      const execution = spawnSync(launcher, ['backup'], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(execution.error).toBeUndefined();
      expect(execution.status).not.toBe(0);
      childPid = Number(readFileSync(childPidFile, 'utf8').trim());
      expect(Number.isSafeInteger(childPid) && childPid > 1).toBe(true);
      let alive = true;
      for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
        try {
          process.kill(childPid, 0);
          execFileSync('/bin/sleep', ['0.1']);
        } catch (error: any) {
          if (error?.code === 'ESRCH') alive = false;
          else throw error;
        }
      }
      expect(alive).toBe(false);
    } finally {
      if (childPid > 1) {
        try { process.kill(childPid, 'SIGKILL'); } catch { /* already gone */ }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('loads the scheduled oneshot units under the Linux systemd verifier', () => {
    if (process.platform !== 'linux') return;
    const root = mkdtempSync(join(tmpdir(), 'nexus-local-backup-systemd-verify-'));
    chmodSync(root, 0o700);
    const units = [
      'nexus-local-backup.service',
      'nexus-local-backup-restore-verify.service',
    ];
    try {
      const paths = units.map((unit) => {
        const source = readFileSync(join('ops/local-backup/systemd', unit), 'utf8')
          .replace(/^ExecStart=.*$/mu, 'ExecStart=/bin/true')
          .replace(/^ExecStopPost=.*$/mu, 'ExecStopPost=/bin/true');
        const destination = join(root, unit);
        writeFileSync(destination, source, { mode: 0o600 });
        return destination;
      });
      const verified = spawnSync('/usr/bin/systemd-analyze', ['verify', ...paths], {
        encoding: 'utf8',
      });
      expect(verified.error).toBeUndefined();
      expect(verified.status, `${verified.stdout}\n${verified.stderr}`).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses unsafe pre-existing installer targets before copy', () => {
    const installer = readFileSync('scripts/local-backup-systemd-install.sh', 'utf8');
    const start = installer.indexOf('validate_optional_installed_file() {');
    const end = installer.indexOf('\n\npath_chain_identity()', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const helper = installer.slice(start, end);
    const root = mkdtempSync(join(tmpdir(), 'nexus-backup-installer-target-'));
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    const statShim = process.platform === 'darwin'
      ? "stat() { /usr/bin/stat -f '%u:%g:%Lp:%l' -- \"${!#}\"; }\n"
      : '';
    const validate = (target: string, mode = '644', expectedUid = uid) => spawnSync(
      'bash',
      ['-c', `${statShim}${helper}\nvalidate_optional_installed_file "$1" "$2" "$3" "$4"`,
        'installer-preflight', target, mode, String(expectedUid), String(gid)],
      { encoding: 'utf8' },
    );
    try {
      const safe = join(root, 'safe');
      writeFileSync(safe, 'safe\n', { mode: 0o644 });
      chmodSync(safe, 0o644);
      expect(validate(safe).status).toBe(0);

      const symbolic = join(root, 'symbolic');
      symlinkSync(safe, symbolic);
      expect(validate(symbolic).status).not.toBe(0);

      const hardlinked = join(root, 'hardlinked');
      linkSync(safe, hardlinked);
      expect(validate(safe).status).not.toBe(0);
      rmSync(hardlinked);

      expect(validate(safe, '644', uid + 1).status).not.toBe(0);
      chmodSync(safe, 0o600);
      expect(validate(safe).status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not retain AWS, object-store, or long-lived credential interfaces', () => {
    // The Sonar backup and restore-drill scripts were part of this surface until
    // SonarQube was decommissioned on 2026-08-07; they no longer exist, so the
    // credential-free assertion now covers the remaining backup tooling plus the
    // continuous-deployment poller environment template.
    const files = [
      'scripts/local-backup.py',
      'scripts/local-backup-retry-launcher.sh',
      'scripts/local-backup-systemd-install.sh',
      'ops/local-backup/backup.env.example',
      'ops/nexus-release/poller.env.example',
    ];
    const source = files.map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(source).not.toMatch(
      /AWS_|s3api|Roles Anywhere|CloudFormation|MINIO_|access[_-]?key|secret[_-]?access/i,
    );
  });
});
