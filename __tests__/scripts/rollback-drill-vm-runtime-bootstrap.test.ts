import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const helper = resolve("scripts/rollback-drill-vm-runtime-manifest.py");
const builder = readFileSync(
  "scripts/build-rollback-drill-vm-runtime-bundle.sh",
  "utf8",
);
const guestControl = readFileSync(
  "scripts/rollback-drill-vm-runtime-control.sh",
  "utf8",
);
const hostSealer = readFileSync(
  "scripts/rollback-drill-vm-runtime-readiness-seal.sh",
  "utf8",
);
const pm2Integrity =
  "sha512-wX1FiFkzuT2H/UUEA8QNXDAA9MMHDsK/3UHj6Dkd5U7kxyigKDA5gyDw78yc" +
  "TQZAuGCLWyUX5FiXEuVQWafukA==";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "nexus-runtime-bootstrap-")),
  );
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hostKey(index: number): { publicKey: string; fingerprint: string } {
  const body = Buffer.from(`nexus-test-host-key-${index}`);
  return {
    publicKey: `ssh-ed25519 ${body.toString("base64")}`,
    fingerprint: `SHA256:${createHash("sha256")
      .update(body)
      .digest("base64")
      .replace(/=+$/u, "")}`,
  };
}

function provisionReceipt() {
  const imageSha = "b".repeat(64);
  const guestHostKeys = [1, 2, 3].map((slot) => hostKey(slot));
  const clientKeySha = "c".repeat(64);
  const hostKeyShas = guestHostKeys.map((key) => sha256(key.publicKey));
  const ports = [22_991, 22_992, 22_993];
  const hypervisor = {
    manager: "qemu-systemd",
    qemuBinary: "/usr/bin/qemu-system-x86_64",
    qemuSha256: "4".repeat(64),
    qemuVersion: "QEMU emulator version 8.2.2",
    qemuPackage: "qemu-system-x86",
    qemuPackageVersion: "1:8.2.2+ds-0ubuntu1.7",
    qemuPackageArchitecture: "amd64",
    runnerPath: "/usr/local/libexec/nexus-rollback-drill-vm/run",
    runnerSha256: "5".repeat(64),
    hostPreflightPath:
      "/usr/local/libexec/nexus-rollback-drill-vm/host-preflight",
    hostPreflightSha256: "6".repeat(64),
    runtimeManifestPath:
      "/usr/local/libexec/nexus-rollback-drill-vm/runtime-manifest",
    runtimeManifestSha256: "7".repeat(64),
    runtimeControlSourcePath:
      "/usr/local/libexec/nexus-rollback-drill-vm/runtime-control-guest",
    runtimeControlSha256: "8".repeat(64),
    runtimeReadinessPath:
      "/usr/local/libexec/nexus-rollback-drill-vm/runtime-readiness",
    runtimeReadinessSha256: "9".repeat(64),
    runtimeRecoveryUnitSourcePath:
      "/usr/local/libexec/nexus-rollback-drill-vm/runtime-recovery.service",
    runtimeRecoveryUnitSha256: "d".repeat(64),
    sharedMutexPath: "/run/lock/nexus-release-sonar.lock",
    guestAdmissionLockPath: "/run/nexus-rollback-drill-vm/admission.lock",
    hostAvailableMemoryFloorGiB: 25,
    hostLoad15CeilingExclusive: 6,
    unitTemplate: "nexus-rollback-drill-vm@.service",
    unitPath: "/etc/systemd/system/nexus-rollback-drill-vm@.service",
    unitSha256: "e".repeat(64),
    vcpus: 4,
    memoryMiB: 14_336,
    memorySwapMaxMiB: 512,
    diskBytes: 100 * 1024 * 1024 * 1024,
    networkMode: "qemu-user-restrict",
    loopbackHost: "127.0.0.1",
    singleActiveGuest: true,
    bridgeAttached: false,
    tapAttached: false,
    sharedFilesystemAttached: false,
    hostBlockDeviceAttached: false,
    productionDataAttached: false,
  };
  const setMaterial =
    "schema=nexus.rollback-drill-vm-provision.v2\n" +
    `image=${imageSha}\n` +
    `key=${clientKeySha}\n` +
    `hostKeys=${hostKeyShas.join(",")}\n` +
    `ports=${ports.join(",")}\n` +
    `runner=${hypervisor.runnerSha256}\n` +
    `hostPreflight=${hypervisor.hostPreflightSha256}\n` +
    `runtimeManifest=${hypervisor.runtimeManifestSha256}\n` +
    `runtimeControl=${hypervisor.runtimeControlSha256}\n` +
    `runtimeReadiness=${hypervisor.runtimeReadinessSha256}\n` +
    `runtimeRecoveryUnit=${hypervisor.runtimeRecoveryUnitSha256}\n` +
    `unit=${hypervisor.unitSha256}\n` +
    `qemu=${hypervisor.qemuSha256}\n` +
    `qemuVersion=${hypervisor.qemuVersion}\n` +
    `qemuPackage=${hypervisor.qemuPackage}\n` +
    `qemuPackageVersion=${hypervisor.qemuPackageVersion}\n` +
    `qemuPackageArchitecture=${hypervisor.qemuPackageArchitecture}\n`;
  const setId = sha256(setMaterial);
  const guests = [1, 2, 3].map((slot) => {
    const name = `guest-${slot}`;
    return {
      name,
      port: ports[slot - 1],
      unit: `nexus-rollback-drill-vm@${name}.service`,
      uuid: `00000000-0000-4000-8000-00000000000${slot}`,
      mac: `52:54:00:00:00:0${slot}`,
      instanceId: `nexus-rollback-drill-${name}-${setId.slice(0, 16)}`,
      overlayPath: `/var/lib/nexus-rollback-drill-vm/sets/${setId}/${name}/root.qcow2`,
      overlayInitialSha256: String(slot).repeat(64),
      seedPath: `/var/lib/nexus-rollback-drill-vm/sets/${setId}/${name}/seed.img`,
      seedSha256: String(slot + 3).repeat(64),
      hostPublicKey: guestHostKeys[slot - 1].publicKey,
      hostPublicKeySha256: hostKeyShas[slot - 1],
      hostKeyFingerprint: guestHostKeys[slot - 1].fingerprint,
    };
  });
  return {
    schema: "nexus.rollback-drill-vm-provision.v2",
    setId,
    image: {
      filename: "noble-server-cloudimg-amd64.img",
      sha256: imageSha,
      basePath: `/var/lib/nexus-rollback-drill-vm/base/${imageSha}.qcow2`,
    },
    sshPublicKeySha256: clientKeySha,
    guestSshHostPublicKeySha256s: hostKeyShas,
    ports,
    setDirectory: `/var/lib/nexus-rollback-drill-vm/sets/${setId}`,
    runtimeReadiness: {
      status: "ssh_only_bootstrap_required",
      drillReady: false,
      requirements: [
        "node-22.23.1",
        "python-3.12.x",
        "pm2-6.0.14-root-closure-at-/opt/nexus-release/pm2/6.0.14-via-/usr/local/bin/pm2",
        "digest-bound-offline-toolchain-evidence",
      ],
    },
    hypervisor,
    guests,
    createdAt: "2026-07-24T00:00:00Z",
  };
}

function runHelper(args: string[]) {
  return spawnSync("python3", [helper, ...args], {
    encoding: "utf8",
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function extractShellFunction(source: string, name: string): string {
  const marker = `${name}() {`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing shell function: ${name}`);
  const tail = source.slice(start);
  const close = /^}$/m.exec(tail);
  if (!close) throw new Error(`unterminated shell function: ${name}`);
  return tail.slice(0, close.index + close[0].length);
}

function runtimeControlContract() {
  const loaded = spawnSync(
    "python3",
    [
      "-c",
      [
        "import importlib.util,json,sys",
        "spec=importlib.util.spec_from_file_location('runtime_manifest',sys.argv[1])",
        "module=importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(module)",
        "print(json.dumps({'files':module.CONTROL_FILES,'bootstrap':module.BOOTSTRAP_FILES,'generated':module.GENERATED_CONTROL_FILES,'services':module.CONTROL_SERVICE_STATES}))",
      ].join(";"),
      helper,
    ],
    { encoding: "utf8" },
  );
  if (loaded.status !== 0) throw new Error(loaded.stderr);
  return JSON.parse(loaded.stdout);
}

function structuralManifest(publicKey: Buffer) {
  const digest = (value: string) => value.repeat(64);
  const contract = runtimeControlContract();
  const controlFiles = contract.files.map(
    ([source, destination, owner, mode]: [string, string, string, number]) => ({
    source,
    destination,
    owner,
    mode,
    size: 1,
    sha256: digest("1"),
  }));
  const bootstrapFiles = contract.bootstrap.map(
    ([source, destination, owner, mode]: [string, string, string, number]) => ({
    source,
    destination,
    owner,
    mode,
    size: 1,
    sha256: digest("2"),
  }));
  const generatedFiles = contract.generated.map(
    ([destination, owner, mode]: [string, string, number]) => ({
      destination,
      owner,
      mode,
    }),
  );
  const serviceStates = contract.services.map(
    ([unit, loadState, unitFileState]: [string, string, string]) => ({
      unit,
      loadState,
      unitFileState,
    }),
  );
  const publicKeySha256 = sha256(publicKey);
  return {
    schema: "nexus.rollback-drill-vm-runtime-bundle.v1",
    target: {
      os: {
        id: "ubuntu",
        versionId: "24.04",
        architecture: "x86_64",
        baseImageSha256: digest("3"),
      },
      node: {
        version: "v22.23.1",
        archivePath: "payload/node-v22.23.1-linux-x64.tar.xz",
        archiveRoot: "node-v22.23.1-linux-x64",
        npmVersion: "10.9.8",
        binarySha256: digest("f"),
        contentTreeSha256: digest("d"),
        installRoot:
          "/opt/nexus-rollback-drill-vm/runtime/node-v22.23.1-linux-x64",
        binaryPath: "/usr/bin/node",
        links: {
          "/usr/bin/corepack":
            "/opt/nexus-rollback-drill-vm/runtime/" +
            "node-v22.23.1-linux-x64/bin/corepack",
          "/usr/bin/npm":
            "/opt/nexus-rollback-drill-vm/runtime/" +
            "node-v22.23.1-linux-x64/bin/npm",
          "/usr/bin/npx":
            "/opt/nexus-rollback-drill-vm/runtime/" +
            "node-v22.23.1-linux-x64/bin/npx",
        },
      },
      python: {
        version: "Python 3.12.3",
        binaryPath: "/usr/bin/python3.12",
        binarySha256: digest("4"),
        packageName: "python3.12-minimal",
        packageVersion: "3.12.3-1ubuntu0.8",
        packageArchitecture: "amd64",
        source: "canonical-ubuntu-noble-base-image",
      },
      pm2: {
        version: "6.0.14",
        prefixPath: "payload/pm2-closure",
        sourceArchivePath: "payload/pm2-root-closure.tar.gz",
        sourceArchiveSha256: digest("0"),
        lockPath: "provenance/pm2/package-lock.json",
        binaryPath: "/usr/local/bin/pm2",
        installRoot: "/opt/nexus-release/pm2/6.0.14",
        binarySha256: digest("9"),
        entrypointPath:
          "/opt/nexus-release/pm2/6.0.14/node_modules/pm2/bin/pm2",
        entrypointSha256: digest("8"),
        attestationPath:
          "/var/lib/nexus-release-promotion/pm2-root-install.v1.json",
        contentTreeSha256: digest("e"),
        closureDigest: digest("1"),
        payloadDigest: digest("2"),
        fileCount: 123,
        packageLockSha256: digest("c"),
      },
      control: {
        version: "nexus-release-promotion-control.v3",
        sourceCommit: "5".repeat(40),
        archivePath: "payload/control-source.tar.gz",
        archiveSha256: digest("6"),
        bootstrapFiles,
        files: controlFiles,
        generatedFiles,
        serviceStates,
      },
    },
    provenance: {
      node: {
        verification: "gpgv-validsig",
        signerFingerprint: "890C08DB8579162FEE0DF9DB8BEAB4DFCF555EF4",
        checksumsPath: "provenance/node/SHASUMS256.txt",
        checksumsSha256: digest("7"),
        signaturePath: "provenance/node/SHASUMS256.txt.sig",
        signatureSha256: digest("8"),
        keyringPath: "provenance/node/node-release-keyring.gpg",
        keyringSha256:
          "6030d4e0cd53330acf2ab68acd455b7ca98bb5d5975376f0b7c0892308ba2d57",
        keyringSourceRepository: "https://github.com/nodejs/release-keys",
        keyringSourceCommit: "b28073028e6d6855cfb53bf7fa0137599c01f967",
      },
      python: {
        verification: "provisioned-guest-ssh-host-key-signature",
        namespace: "nexus-rollback-drill-vm-python-provenance",
        provenancePath: "provenance/python/base-image-python.json",
        provenanceSha256: digest("9"),
        signaturePath: "provenance/python/base-image-python.json.sig",
        signatureSha256: digest("a"),
        provisionReceiptSha256: digest("b"),
        guest: "guest-1",
        hostKeyFingerprint: hostKey(1).fingerprint,
        hostPublicKeySha256: sha256(hostKey(1).publicKey),
      },
      pm2: {
        lockPath: "provenance/pm2/package-lock.json",
        lockSha256: digest("c"),
        lockfileVersion: 3,
        packageCount: 1,
        pm2Integrity,
        registryOrigin: "https://registry.npmjs.org",
        allPackagesIntegrityBound: true,
      },
    },
    signing: {
      algorithm: "ed25519",
      publicKeyPath: "manifest-owner-public-key.pem",
      publicKeySha256,
    },
    files: [
      {
        path: "manifest-owner-public-key.pem",
        type: "file",
        mode: 0o600,
        size: publicKey.length,
        sha256: publicKeySha256,
      },
    ],
  };
}

describe("offline rollback-drill VM runtime bootstrap", () => {
  it("selects one exact guest from the immutable SSH-only provision receipt", () => {
    const root = temporaryRoot();
    const receiptPath = join(root, "active.json");
    const receipt = provisionReceipt();
    writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
    const receiptSha = sha256(readFileSync(receiptPath));

    const selected = runHelper([
      "provision",
      "--provision-receipt",
      receiptPath,
      "--expected-provision-sha256",
      receiptSha,
      "--guest",
      "guest-2",
    ]);

    expect(selected.status, `${selected.stdout}${selected.stderr}`).toBe(0);
    expect(JSON.parse(selected.stdout)).toMatchObject({
      setId: receipt.setId,
      guest: "guest-2",
      baseImageSha256: receipt.image.sha256,
      uuid: receipt.guests[1].uuid,
      instanceId: receipt.guests[1].instanceId,
      hostKeyFingerprint: receipt.guests[1].hostKeyFingerprint,
      hostPublicKeySha256: sha256(receipt.guests[1].hostPublicKey),
      overlayInitialSha256: receipt.guests[1].overlayInitialSha256,
      provisionReceiptSha256: receiptSha,
    });
  });

  it("fails closed when the provision runtime boundary or reviewed digest drifts", () => {
    const root = temporaryRoot();
    const receiptPath = join(root, "active.json");
    const receipt = provisionReceipt();
    receipt.runtimeReadiness.drillReady = true;
    writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });

    const driftedBoundary = runHelper([
      "provision",
      "--provision-receipt",
      receiptPath,
      "--expected-provision-sha256",
      sha256(readFileSync(receiptPath)),
      "--guest",
      "guest-1",
    ]);
    expect(driftedBoundary.status).not.toBe(0);
    expect(driftedBoundary.stderr).toContain(
      "provision receipt runtime boundary is invalid",
    );

    receipt.runtimeReadiness.drillReady = false;
    writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
    const digestDrift = runHelper([
      "provision",
      "--provision-receipt",
      receiptPath,
      "--expected-provision-sha256",
      "f".repeat(64),
      "--guest",
      "guest-1",
    ]);
    expect(digestDrift.status).not.toBe(0);
    expect(digestDrift.stderr).toContain("provision receipt digest differs");
  });

  it("root-stages only the exact provision receipt and rejects a symlink source", () => {
    const root = temporaryRoot();
    const source = join(root, "active.json");
    const targetParent = join(root, "protected-provision");
    mkdirSync(targetParent, { mode: 0o700 });
    writeFileSync(source, JSON.stringify(provisionReceipt()), { mode: 0o600 });
    const expected = sha256(readFileSync(source));

    const staged = runHelper([
      "stage-provision",
      "--source",
      source,
      "--target-parent",
      targetParent,
      "--expected-provision-sha256",
      expected,
    ]);
    expect(staged.status, `${staged.stdout}${staged.stderr}`).toBe(0);
    const result = JSON.parse(staged.stdout);
    expect(result).toMatchObject({
      provisionReceiptSha256: expected,
      alreadyPresent: false,
    });
    expect(readFileSync(result.provisionReceipt)).toEqual(readFileSync(source));
    expect(statSync(result.provisionReceipt).mode & 0o777).toBe(0o600);

    const repeated = runHelper([
      "stage-provision",
      "--source",
      source,
      "--target-parent",
      targetParent,
      "--expected-provision-sha256",
      expected,
    ]);
    expect(repeated.status, `${repeated.stdout}${repeated.stderr}`).toBe(0);
    expect(JSON.parse(repeated.stdout).alreadyPresent).toBe(true);

    const linked = join(root, "active-link.json");
    symlinkSync(source, linked);
    const rejected = runHelper([
      "stage-provision",
      "--source",
      linked,
      "--target-parent",
      targetParent,
      "--expected-provision-sha256",
      expected,
    ]);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("without following links");
  });

  it("verifies the owner signature before materializing uploaded bundle files", () => {
    const root = temporaryRoot();
    const source = join(root, "uploaded-bundle");
    const targetParent = join(root, "protected-bundles");
    mkdirSync(source, { mode: 0o700 });
    mkdirSync(targetParent, { mode: 0o700 });
    const privateKey = join(root, "owner-private.pem");
    const publicKeyPath = join(source, "manifest-owner-public-key.pem");
    const generated = spawnSync(
      "openssl",
      ["genpkey", "-algorithm", "ED25519", "-out", privateKey],
      { encoding: "utf8" },
    );
    expect(generated.status, generated.stderr).toBe(0);
    const exported = spawnSync(
      "openssl",
      ["pkey", "-in", privateKey, "-pubout", "-out", publicKeyPath],
      { encoding: "utf8" },
    );
    expect(exported.status, exported.stderr).toBe(0);
    chmodSync(publicKeyPath, 0o600);
    const publicKey = readFileSync(publicKeyPath);
    const manifestPath = join(source, "manifest.json");
    const signaturePath = join(source, "manifest.sig");
    writeFileSync(manifestPath, canonicalJson(structuralManifest(publicKey)), {
      mode: 0o600,
    });
    const signed = spawnSync(
      "openssl",
      [
        "pkeyutl",
        "-sign",
        "-inkey",
        privateKey,
        "-rawin",
        "-in",
        manifestPath,
        "-out",
        signaturePath,
      ],
      { encoding: "utf8" },
    );
    expect(signed.status, signed.stderr).toBe(0);
    const manifestSha = sha256(readFileSync(manifestPath));
    const publicKeySha = sha256(publicKey);
    const correctlySigned = runHelper([
      "stage-bundle",
      "--source-root",
      source,
      "--target-parent",
      targetParent,
      "--expected-manifest-sha256",
      manifestSha,
      "--expected-public-key-sha256",
      publicKeySha,
    ]);
    expect(correctlySigned.status).not.toBe(0);
    expect(correctlySigned.stderr).toContain(
      "runtime bundle is missing a required input",
    );
    expect(existsSync(join(targetParent, manifestSha))).toBe(false);

    writeFileSync(signaturePath, Buffer.alloc(64), { mode: 0o600 });
    const badSignature = runHelper([
      "stage-bundle",
      "--source-root",
      source,
      "--target-parent",
      targetParent,
      "--expected-manifest-sha256",
      manifestSha,
      "--expected-public-key-sha256",
      publicKeySha,
    ]);
    expect(badSignature.status).not.toBe(0);
    expect(badSignature.stderr).toContain(
      "runtime bundle owner signature is invalid",
    );
    expect(existsSync(join(targetParent, manifestSha))).toBe(false);
  });

  it("binds Noble Python identity to the exact guest, image, dpkg evidence, and host key", () => {
    const root = temporaryRoot();
    const receiptPath = join(root, "active.json");
    const provenancePath = join(root, "python.json");
    const receipt = provisionReceipt();
    writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
    const receiptSha = sha256(readFileSync(receiptPath));
    const guest = receipt.guests[0];
    const provenance = {
      schema: "nexus.rollback-drill-vm-python-provenance.v1",
      status: "observed_from_provisioned_base_image",
      setId: receipt.setId,
      guest: "guest-1",
      capturedAt: "2026-07-24T00:00:00Z",
      provisionReceiptSha256: receiptSha,
      baseImageSha256: receipt.image.sha256,
      machine: {
        uuid: guest.uuid,
        instanceId: guest.instanceId,
        sshHostKeyFingerprint: guest.hostKeyFingerprint,
        sshHostPublicKeySha256: sha256(guest.hostPublicKey),
      },
      os: { id: "ubuntu", versionId: "24.04", architecture: "x86_64" },
      python: {
        version: "Python 3.12.3",
        binaryPath: "/usr/bin/python3.12",
        binarySha256: "d".repeat(64),
        packageName: "python3.12-minimal",
        packageVersion: "3.12.3-1ubuntu0.8",
        packageArchitecture: "amd64",
        dpkgVerified: true,
      },
      networkInstallAttempted: false,
    };
    writeFileSync(provenancePath, JSON.stringify(provenance), { mode: 0o600 });

    const validated = runHelper([
      "validate-python-provenance",
      "--provision-receipt",
      receiptPath,
      "--expected-provision-sha256",
      receiptSha,
      "--guest",
      "guest-1",
      "--provenance",
      provenancePath,
    ]);
    expect(validated.status, `${validated.stdout}${validated.stderr}`).toBe(0);
    expect(JSON.parse(validated.stdout).python).toEqual(provenance.python);

    provenance.machine.uuid = receipt.guests[1].uuid;
    writeFileSync(provenancePath, JSON.stringify(provenance), { mode: 0o600 });
    const crossGuest = runHelper([
      "validate-python-provenance",
      "--provision-receipt",
      receiptPath,
      "--expected-provision-sha256",
      receiptSha,
      "--guest",
      "guest-1",
      "--provenance",
      provenancePath,
    ]);
    expect(crossGuest.status).not.toBe(0);
    expect(crossGuest.stderr).toContain(
      "machine identity differs from provision",
    );
  });

  it("validates the final readiness receipt against stopped-overlay and guest evidence", () => {
    const root = temporaryRoot();
    const receiptPath = join(root, "active.json");
    const measurementPath = join(root, "measurement.json");
    const measurementSignaturePath = join(root, "measurement.sig");
    const authorizationPath = join(root, "authorization.json");
    const authorizationSignaturePath = join(root, "authorization.sig");
    const readinessPath = join(root, "readiness.json");
    const manifestPath = join(root, "manifest.json");
    const receipt = provisionReceipt();
    writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
    const provisionSha = sha256(readFileSync(receiptPath));
    const guest = receipt.guests[0];
    const manifest = structuralManifest(Buffer.from("test-owner-public-key"));
    manifest.target.os.baseImageSha256 = receipt.image.sha256;
    manifest.provenance.python.provisionReceiptSha256 = provisionSha;
    manifest.provenance.python.guest = "guest-1";
    manifest.provenance.python.hostKeyFingerprint = guest.hostKeyFingerprint;
    manifest.provenance.python.hostPublicKeySha256 = sha256(
      guest.hostPublicKey,
    );
    writeFileSync(manifestPath, canonicalJson(manifest), { mode: 0o600 });
    const manifestSha = sha256(readFileSync(manifestPath));
    const runtime = {
      node: {
        version: manifest.target.node.version,
        path: manifest.target.node.binaryPath,
        sha256: manifest.target.node.binarySha256,
        treeSha256: manifest.target.node.contentTreeSha256,
        owner: "root:root",
        mode: "755",
        linkCount: 1,
      },
      python: {
        version: manifest.target.python.version,
        path: manifest.target.python.binaryPath,
        sha256: manifest.target.python.binarySha256,
        packageName: manifest.target.python.packageName,
        packageVersion: manifest.target.python.packageVersion,
        packageArchitecture: manifest.target.python.packageArchitecture,
      },
      pm2: {
        version: manifest.target.pm2.version,
        path: manifest.target.pm2.binaryPath,
        sha256: manifest.target.pm2.binarySha256,
        entrypointPath: manifest.target.pm2.entrypointPath,
        entrypointSha256: manifest.target.pm2.entrypointSha256,
        attestationPath: manifest.target.pm2.attestationPath,
        attestationSha256: "7".repeat(64),
        treeSha256: manifest.target.pm2.contentTreeSha256,
        owner: "root:root",
        mode: "755",
      },
    };
    const control = {
      version: manifest.target.control.version,
      sourceCommit: manifest.target.control.sourceCommit,
      files: manifest.target.control.files.map((identity) => ({
        path: identity.destination,
        size: identity.size,
        sha256: identity.sha256,
        owner: identity.owner,
        mode: identity.mode.toString(8),
      })),
      generatedFiles: manifest.target.control.generatedFiles.map((identity) => ({
        path: identity.destination,
        size: 1,
        sha256: "6".repeat(64),
        owner: identity.owner,
        mode: identity.mode.toString(8),
      })),
      serviceStates: manifest.target.control.serviceStates.map((identity) => {
        const loadState = identity.loadState === "not-found-or-loaded"
          || identity.loadState === "masked-or-not-found"
          ? "not-found"
          : identity.loadState;
        const unitFileState = identity.unitFileState === "masked-or-not-found"
          ? "not-found"
          : identity.unitFileState === "disabled-or-enabled"
            ? "disabled"
            : identity.unitFileState === "disabled-or-static"
              ? "static"
              : identity.unitFileState;
        return {
          unit: identity.unit,
          loadState,
          activeState: loadState === "not-found" ? "not-found" : "inactive",
          unitFileState,
          fragmentPath: loadState === "not-found"
            ? ""
            : `/etc/systemd/system/${identity.unit}`,
          dropInPaths: [],
          effectiveSha256: "5".repeat(64),
          needDaemonReload: false,
        };
      }),
      assertIdle: true,
      runtimeRecovery: {
        unit: "nexus-rollback-drill-vm-runtime-recovery.service",
        path:
          "/etc/systemd/system/" +
          "nexus-rollback-drill-vm-runtime-recovery.service",
        sha256: receipt.hypervisor.runtimeRecoveryUnitSha256,
        loadState: "loaded",
        activeState: "active",
        unitFileState: "enabled",
        fragmentPath:
          "/etc/systemd/system/" +
          "nexus-rollback-drill-vm-runtime-recovery.service",
        dropInPaths: [],
        needDaemonReload: false,
        execStart: {
          path: "/usr/local/sbin/" + "nexus-rollback-drill-vm-runtime-control",
          argv: [
            "/usr/local/sbin/" + "nexus-rollback-drill-vm-runtime-control",
            "recover-install",
          ],
        },
      },
    };
    const pm2DryHealth = {
      status: "passed",
      isolatedHome: true,
      daemonStopped: true,
      processCount: 0,
    };
    const challenge = "0".repeat(64);
    const measurement = {
      schema: "nexus.rollback-drill-vm-runtime-measurement.v1",
      status: "guest_checks_passed",
      drillReady: false,
      pendingHostOverlaySeal: true,
      setId: receipt.setId,
      guest: "guest-1",
      capturedAt: "2026-07-24T00:00:00Z",
      provisionReceiptSha256: provisionSha,
      bundleManifestSha256: manifestSha,
      challenge,
      machine: {
        uuid: guest.uuid,
        instanceId: guest.instanceId,
        sshHostKeyFingerprint: guest.hostKeyFingerprint,
        sshHostPublicKeySha256: sha256(guest.hostPublicKey),
      },
      runtime,
      control,
      pm2DryHealth,
      networkInstallAttempted: false,
    };
    writeFileSync(measurementPath, JSON.stringify(measurement), {
      mode: 0o600,
    });
    writeFileSync(measurementSignaturePath, Buffer.alloc(64, 7), {
      mode: 0o600,
    });
    const authorization = {
      schema: "nexus.rollback-drill-vm-runtime-authorization.v1",
      authorizationId: "1".repeat(64),
      issuedAt: "2026-07-24T00:00:00Z",
      expiresAt: "2026-07-24T12:00:00Z",
      controllerBootIdSha256: "3".repeat(64),
      issuedMonotonicSeconds: 100_000,
      expiresMonotonicSeconds: 143_200,
      operation: "collect-runtime-readiness",
      drill: "failed-health-check",
      setId: receipt.setId,
      guest: "guest-1",
      port: guest.port,
      provisionReceiptSha256: provisionSha,
      bundleManifestSha256: manifestSha,
      guestSshHostPublicKeySha256: sha256(guest.hostPublicKey),
      ownerPublicKeySha256: "2".repeat(64),
    };
    writeFileSync(authorizationPath, canonicalJson(authorization), {
      mode: 0o600,
    });
    writeFileSync(authorizationSignaturePath, Buffer.alloc(64, 8), {
      mode: 0o600,
    });
    const readiness = {
      schema: "nexus.rollback-drill-vm-runtime-readiness.v2",
      status: "ready",
      drillReady: true,
      sealedAt: "2026-07-24T00:01:00Z",
      setId: receipt.setId,
      guest: "guest-1",
      port: guest.port,
      provisionReceiptSha256: provisionSha,
      bundleManifestSha256: manifestSha,
      ownerAuthorization: {
        authorizationId: authorization.authorizationId,
        drill: authorization.drill,
        issuedAt: authorization.issuedAt,
        expiresAt: authorization.expiresAt,
        controllerBootIdSha256:
          authorization.controllerBootIdSha256,
        issuedMonotonicSeconds:
          authorization.issuedMonotonicSeconds,
        expiresMonotonicSeconds:
          authorization.expiresMonotonicSeconds,
        sha256: sha256(readFileSync(authorizationPath)),
        signatureSha256: sha256(readFileSync(authorizationSignaturePath)),
        ownerPublicKeySha256: authorization.ownerPublicKeySha256,
      },
      guestMeasurement: {
        sha256: sha256(readFileSync(measurementPath)),
        signatureSha256: sha256(readFileSync(measurementSignaturePath)),
        challenge,
        namespace: "nexus-rollback-drill-vm-runtime-measurement",
      },
      machine: {
        uuid: guest.uuid,
        instanceId: guest.instanceId,
        mac: guest.mac,
        sshHostKeyFingerprint: guest.hostKeyFingerprint,
        sshHostPublicKeySha256: sha256(guest.hostPublicKey),
      },
      qemu: {
        unit: guest.unit,
        supervisorPid: 101,
        supervisorStartTime: "1001",
        supervisorCmdlineSha256: "3".repeat(64),
        pid: 102,
        startTime: "1002",
        executable: receipt.hypervisor.qemuBinary,
        executableSha256: receipt.hypervisor.qemuSha256,
        cmdlineSha256: "4".repeat(64),
        loopbackPortSocketInode: "9001",
      },
      stoppedGuestProof: {
        unit: guest.unit,
        systemdState: "active-handoff-wait",
        admissionLockHeld: true,
        activeLockHolder: "runner-supervisor",
        sharedReleaseSonarLockHolder: "runner-supervisor",
        holderPid: 101,
        holderStartTime: "1001",
        handoffNonce: "5".repeat(64),
        qemuExited: true,
        overlayProcessAbsent: true,
      },
      overlay: {
        path: guest.overlayPath,
        initialSha256: guest.overlayInitialSha256,
        currentSha256: "f".repeat(64),
        size: 4096,
        device: 10,
        inode: 11,
        mtimeNs: 12,
        ctimeNs: 13,
        stableDescriptor: true,
      },
      runtime,
      control,
      pm2DryHealth,
      networkInstallAttempted: false,
    };
    writeFileSync(readinessPath, JSON.stringify(readiness), { mode: 0o600 });

    const valid = runHelper([
      "validate-readiness",
      "--provision-receipt",
      receiptPath,
      "--expected-provision-sha256",
      provisionSha,
      "--guest",
      "guest-1",
      "--measurement",
      measurementPath,
      "--measurement-signature",
      measurementSignaturePath,
      "--authorization",
      authorizationPath,
      "--authorization-signature",
      authorizationSignaturePath,
      "--readiness",
      readinessPath,
      "--manifest",
      manifestPath,
      "--expected-manifest-sha256",
      manifestSha,
    ]);
    expect(valid.status, `${valid.stdout}${valid.stderr}`).toBe(0);
    expect(JSON.parse(valid.stdout)).toMatchObject({
      drillReady: true,
      overlayCurrentSha256: readiness.overlay.currentSha256,
    });

    const compromisedMeasurement = structuredClone(measurement);
    compromisedMeasurement.control.runtimeRecovery.dropInPaths = [
      "/etc/systemd/system/nexus-rollback-drill-vm-runtime-recovery.service.d/override.conf",
    ];
    writeFileSync(measurementPath, JSON.stringify(compromisedMeasurement), {
      mode: 0o600,
    });
    const compromisedRecovery = runHelper([
      "validate-measurement",
      "--provision-receipt",
      receiptPath,
      "--expected-provision-sha256",
      provisionSha,
      "--guest",
      "guest-1",
      "--measurement",
      measurementPath,
      "--manifest",
      manifestPath,
      "--expected-manifest-sha256",
      manifestSha,
      "--challenge",
      challenge,
    ]);
    expect(compromisedRecovery.status).not.toBe(0);
    expect(compromisedRecovery.stderr).toContain(
      "guest runtime recovery unit is outside the provisioned policy",
    );
    writeFileSync(measurementPath, JSON.stringify(measurement), {
      mode: 0o600,
    });

    readiness.stoppedGuestProof.admissionLockHeld = false;
    writeFileSync(readinessPath, JSON.stringify(readiness), { mode: 0o600 });
    const unsafe = runHelper([
      "validate-readiness",
      "--provision-receipt",
      receiptPath,
      "--expected-provision-sha256",
      provisionSha,
      "--guest",
      "guest-1",
      "--measurement",
      measurementPath,
      "--measurement-signature",
      measurementSignaturePath,
      "--authorization",
      authorizationPath,
      "--authorization-signature",
      authorizationSignaturePath,
      "--readiness",
      readinessPath,
      "--manifest",
      manifestPath,
      "--expected-manifest-sha256",
      manifestSha,
    ]);
    expect(unsafe.status).not.toBe(0);
    expect(unsafe.stderr).toContain("stopped-guest proof is invalid");
  });

  it("atomically checkpoints collection journals without corrupting the prior state on failure", () => {
    const root = temporaryRoot();
    const journal = join(root, "collection.json");
    const original = {
      schema: "nexus.rollback-drill-vm-runtime-collection-journal.v1",
      status: "measured",
      retained: "exact-transaction-identity",
    };
    const checkpoint = extractShellFunction(
      hostSealer,
      "checkpoint_journal_status",
    );
    const runCheckpoint = (status: string) =>
      spawnSync(
        "bash",
        ["-c", `${checkpoint}\ncheckpoint_journal_status "$JOURNAL" "$STATUS"`],
        {
          encoding: "utf8",
          env: { ...process.env, JOURNAL: journal, STATUS: status },
        },
      );

    writeFileSync(journal, JSON.stringify(original), { mode: 0o600 });
    const completed = runCheckpoint("qemu_exited");
    expect(completed.status, completed.stderr).toBe(0);
    expect(JSON.parse(readFileSync(journal, "utf8"))).toEqual({
      ...original,
      status: "qemu_exited",
    });
    expect(readdirSync(root).some((name) => name.includes(".checkpoint"))).toBe(
      false,
    );

    writeFileSync(journal, JSON.stringify(original), { mode: 0o600 });
    const staleCheckpoint = join(root, ".collection.json.checkpoint");
    writeFileSync(staleCheckpoint, '{"partial":true}', { mode: 0o600 });
    const resumed = runCheckpoint("qemu_exited");
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(existsSync(staleCheckpoint)).toBe(false);
    expect(JSON.parse(readFileSync(journal, "utf8")).status).toBe(
      "qemu_exited",
    );

    writeFileSync(journal, JSON.stringify(original), { mode: 0o600 });
    chmodSync(root, 0o500);
    const interrupted = runCheckpoint("readiness_published");
    chmodSync(root, 0o700);
    expect(interrupted.status).not.toBe(0);
    expect(JSON.parse(readFileSync(journal, "utf8"))).toEqual(original);

    const invalid = runCheckpoint("owner_supplied_status");
    expect(invalid.status).not.toBe(0);
    expect(JSON.parse(readFileSync(journal, "utf8"))).toEqual(original);
  });

  it("classifies recoverable evidence-pair crash points and rejects unsafe partials", () => {
    const root = temporaryRoot();
    const evidence = join(root, "python.json");
    const signature = join(root, "python.json.sig");
    const expectedGroup = spawnSync("id", ["-gn"], {
      encoding: "utf8",
    }).stdout.trim();
    const expectedUid = String(process.getuid?.() ?? 0);
    const pairState = extractShellFunction(guestControl, "evidence_pair_state");
    const inspect = () =>
      spawnSync(
        "bash",
        [
          "-c",
          `${pairState}\nevidence_pair_state "$EVIDENCE" "$SIGNATURE" "$EXPECTED_GROUP" "$EXPECTED_UID"`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            EVIDENCE: evidence,
            SIGNATURE: signature,
            EXPECTED_GROUP: expectedGroup,
            EXPECTED_UID: expectedUid,
          },
        },
      );

    expect(inspect().stdout.trim()).toBe("absent");

    writeFileSync(evidence, '{"partial":true}', { mode: 0o600 });
    expect(inspect().stdout.trim()).toBe("clear");

    chmodSync(evidence, 0o640);
    expect(inspect().stdout.trim()).toBe("clear");

    writeFileSync(signature, "signature", { mode: 0o600 });
    expect(inspect().stdout.trim()).toBe("clear");

    chmodSync(signature, 0o640);
    expect(inspect().stdout.trim()).toBe("complete");

    chmodSync(evidence, 0o666);
    const unsafe = inspect();
    expect(unsafe.status).not.toBe(0);
    expect(unsafe.stderr).toContain(
      "runtime evidence partial has an unsafe intermediate identity",
    );
  });

  it("keeps one no-follow overlay descriptor open across the complete stable hash", () => {
    const stable = extractShellFunction(
      hostSealer,
      "stable_overlay_measurement",
    );
    const opened = stable.indexOf("descriptor=os.open(");
    const noFollow = stable.indexOf('getattr(os,"O_NOFOLLOW",0)', opened);
    const before = stable.indexOf("before=os.fstat(descriptor)", noFollow);
    const hashLoop = stable.indexOf("while True:", before);
    const after = stable.indexOf("after=os.fstat(descriptor)", hashLoop);
    const pathAfter = stable.indexOf(
      "path_after=os.stat(overlay,follow_symlinks=False)",
      after,
    );
    const closed = stable.lastIndexOf("os.close(descriptor)");

    expect(opened).toBeGreaterThan(-1);
    expect(noFollow).toBeGreaterThan(opened);
    expect(before).toBeGreaterThan(noFollow);
    expect(hashLoop).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(hashLoop);
    expect(pathAfter).toBeGreaterThan(after);
    expect(closed).toBeGreaterThan(pathAfter);
    expect(stable.match(/descriptor=os\.open\(\n overlay,/gu)).toHaveLength(1);
    expect(stable).toContain(
      "value.st_dev,value.st_ino,value.st_size,value.st_mtime_ns,value.st_ctime_ns",
    );
    expect(stable).toContain(
      "prove_overlay_fd_absent(before.st_dev,before.st_ino,descriptor)",
    );
    expect(stable).toContain(
      "prove_overlay_fd_absent(after.st_dev,after.st_ino,descriptor)",
    );
    expect(stable).toContain(
      "mapped_device=(int(major_text,16),int(minor_text,16))",
    );
  });

  it.runIf(process.platform === "linux")(
    "rejects a stopped overlay while another descriptor still holds its inode",
    () => {
      const root = temporaryRoot();
      const stable = extractShellFunction(
        hostSealer,
        "stable_overlay_measurement",
      );
      const user = spawnSync("id", ["-un"], {
        encoding: "utf8",
      }).stdout.trim();
      const harness = String.raw`
set -euo pipefail
${stable}
OVERLAY_PATH="$TEST_ROOT/root.qcow2"
SHARED_MUTEX="$TEST_ROOT/shared.lock"
ACTIVE_LOCK="$TEST_ROOT/active.lock"
ADMISSION_LOCK="$TEST_ROOT/admission.lock"
truncate -s 8388608 "$OVERLAY_PATH"
chmod 0600 "$OVERLAY_PATH"
: >"$SHARED_MUTEX"
: >"$ACTIVE_LOCK"
: >"$ADMISSION_LOCK"
exec 6<>"$SHARED_MUTEX"
exec 7<>"$ADMISSION_LOCK"
exec 8<>"$ACTIVE_LOCK"
exec 9<"$OVERLAY_PATH"
holder_start="$(python3 - "$$" <<'PY'
import pathlib,sys
body=pathlib.Path(f"/proc/{sys.argv[1]}/stat").read_text()
print(body[body.rfind(") ")+2:].split()[19])
PY
)"
stable_overlay_measurement \
  "$TEST_ROOT/result.json" recovery "$$" "$holder_start" 4194303 "$EXPECTED_USER"
`;
      const held = spawnSync("bash", ["-c", harness], {
        encoding: "utf8",
        env: { ...process.env, TEST_ROOT: root, EXPECTED_USER: user },
      });
      expect(held.status).not.toBe(0);
      expect(held.stderr).toContain("still holds the selected overlay inode");
    },
  );

  it.runIf(process.platform === "linux")(
    "rejects a stopped overlay that remains mmap-backed after its descriptor closes",
    () => {
      const root = temporaryRoot();
      const stable = extractShellFunction(
        hostSealer,
        "stable_overlay_measurement",
      );
      const user = spawnSync("id", ["-un"], {
        encoding: "utf8",
      }).stdout.trim();
      const harness = String.raw`
set -euo pipefail
${stable}
OVERLAY_PATH="$TEST_ROOT/root.qcow2"
SHARED_MUTEX="$TEST_ROOT/shared.lock"
ACTIVE_LOCK="$TEST_ROOT/active.lock"
ADMISSION_LOCK="$TEST_ROOT/admission.lock"
truncate -s 8388608 "$OVERLAY_PATH"
chmod 0600 "$OVERLAY_PATH"
: >"$SHARED_MUTEX"
: >"$ACTIVE_LOCK"
: >"$ADMISSION_LOCK"
exec 6<>"$SHARED_MUTEX"
exec 7<>"$ADMISSION_LOCK"
exec 8<>"$ACTIVE_LOCK"
TEST_OVERLAY="$OVERLAY_PATH" TEST_READY="$TEST_ROOT/mapped" python3 -c '
import ctypes,os,time
path=os.environ["TEST_OVERLAY"]
descriptor=os.open(path,os.O_RDWR)
size=os.fstat(descriptor).st_size
libc=ctypes.CDLL(None,use_errno=True)
libc.mmap.restype=ctypes.c_void_p
address=libc.mmap(None,size,3,1,descriptor,0)
if address==ctypes.c_void_p(-1).value:
    raise OSError(ctypes.get_errno(),"mmap failed")
os.close(descriptor)
open(os.environ["TEST_READY"],"x").close()
while True:
    time.sleep(1)
' &
mapper=$!
for _ in $(seq 1 100); do
  [ -e "$TEST_ROOT/mapped" ] && break
  sleep 0.01
done
[ -e "$TEST_ROOT/mapped" ]
holder_start="$(python3 - "$$" <<'PY'
import pathlib,sys
body=pathlib.Path(f"/proc/{sys.argv[1]}/stat").read_text()
print(body[body.rfind(") ")+2:].split()[19])
PY
)"
set +e
stable_overlay_measurement \
  "$TEST_ROOT/result.json" recovery "$$" "$holder_start" 4194303 "$EXPECTED_USER"
status=$?
set -e
kill "$mapper" 2>/dev/null || true
wait "$mapper" 2>/dev/null || true
exit "$status"
`;
      const mapped = spawnSync("bash", ["-c", harness], {
        encoding: "utf8",
        timeout: 15_000,
        env: { ...process.env, TEST_ROOT: root, EXPECTED_USER: user },
      });
      expect(mapped.status).not.toBe(0);
      expect(mapped.stderr).toContain("still maps the selected overlay inode");
    },
  );

  it.runIf(process.platform === "linux")(
    "detects ctime-only overlay mutation while hashing the held descriptor",
    () => {
      const root = temporaryRoot();
      const stable = extractShellFunction(
        hostSealer,
        "stable_overlay_measurement",
      );
      const user = spawnSync("id", ["-un"], {
        encoding: "utf8",
      }).stdout.trim();
      const harness = String.raw`
set -euo pipefail
${stable}
OVERLAY_PATH="$TEST_ROOT/root.qcow2"
SHARED_MUTEX="$TEST_ROOT/shared.lock"
ACTIVE_LOCK="$TEST_ROOT/active.lock"
ADMISSION_LOCK="$TEST_ROOT/admission.lock"
truncate -s 268435456 "$OVERLAY_PATH"
chmod 0600 "$OVERLAY_PATH"
: >"$SHARED_MUTEX"
: >"$ACTIVE_LOCK"
: >"$ADMISSION_LOCK"
exec 6<>"$SHARED_MUTEX"
exec 7<>"$ADMISSION_LOCK"
exec 8<>"$ACTIVE_LOCK"
holder_start="$(python3 - "$$" <<'PY'
import pathlib,sys
body=pathlib.Path(f"/proc/{sys.argv[1]}/stat").read_text()
print(body[body.rfind(") ")+2:].split()[19])
PY
)"
original_mtime="$(python3 - "$OVERLAY_PATH" <<'PY'
import os,sys
print(os.stat(sys.argv[1]).st_mtime_ns)
PY
)"
TEST_OVERLAY="$OVERLAY_PATH" TEST_MTIME_NS="$original_mtime" python3 -c '
import os,time
path=os.environ["TEST_OVERLAY"]
mtime=int(os.environ["TEST_MTIME_NS"])
while True:
    value=os.stat(path)
    os.utime(path,ns=(value.st_atime_ns,mtime))
    time.sleep(0.001)
' &
mutator=$!
set +e
stable_overlay_measurement \
  "$TEST_ROOT/result.json" recovery "$$" "$holder_start" 4194303 "$EXPECTED_USER"
status=$?
set -e
kill "$mutator" 2>/dev/null || true
wait "$mutator" 2>/dev/null || true
exit "$status"
`;
      const mutated = spawnSync("bash", ["-c", harness], {
        encoding: "utf8",
        timeout: 15_000,
        env: { ...process.env, TEST_ROOT: root, EXPECTED_USER: user },
      });
      expect(mutated.status).not.toBe(0);
      expect(mutated.stderr).toContain(
        "overlay changed while hashing the held no-follow descriptor",
      );
    },
  );

  it("accepts a real lock-v3 shape without package name fields and rejects SRI drift", () => {
    const root = temporaryRoot();
    const prefix = join(root, "prefix");
    const packageRoot = join(prefix, "node_modules/pm2");
    mkdirSync(join(packageRoot, "bin"), { recursive: true, mode: 0o755 });
    mkdirSync(join(packageRoot, "lib/templates/sample-apps/http-server"), {
      recursive: true,
      mode: 0o755,
    });
    for (const directory of [
      prefix,
      join(prefix, "node_modules"),
      packageRoot,
      join(packageRoot, "bin"),
      join(packageRoot, "lib"),
      join(packageRoot, "lib/templates"),
      join(packageRoot, "lib/templates/sample-apps"),
      join(packageRoot, "lib/templates/sample-apps/http-server"),
    ]) {
      chmodSync(directory, 0o755);
    }
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "pm2", version: "6.0.14" }),
      { mode: 0o644 },
    );
    writeFileSync(join(packageRoot, "bin/pm2"), "#!/usr/bin/env node\n", {
      mode: 0o755,
    });
    writeFileSync(
      join(packageRoot, "lib/templates/sample-apps/http-server/package.json"),
      JSON.stringify({ name: "pm2-sample-app", version: "1.0.0" }),
      { mode: 0o644 },
    );
    const lockPath = join(root, "package-lock.json");
    const lock = {
      name: "nexus-pm2-runtime-bundle",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { dependencies: { pm2: "6.0.14" } },
        "node_modules/pm2": {
          version: "6.0.14",
          resolved: "https://registry.npmjs.org/pm2/-/pm2-6.0.14.tgz",
          integrity: pm2Integrity,
        },
      },
    };
    writeFileSync(lockPath, JSON.stringify(lock), { mode: 0o600 });
    writeFileSync(
      join(prefix, "package.json"),
      JSON.stringify({
        name: "nexus-pm2-runtime-bundle",
        version: "1.0.0",
        private: true,
        dependencies: { pm2: "6.0.14" },
      }),
      { mode: 0o644 },
    );
    writeFileSync(join(prefix, "package-lock.json"), JSON.stringify(lock), {
      mode: 0o644,
    });
    const payloadFiles = [
      "node_modules/pm2/bin/pm2",
      "node_modules/pm2/lib/templates/sample-apps/http-server/package.json",
      "node_modules/pm2/package.json",
      "package-lock.json",
      "package.json",
    ].map((relative) => {
      const absolute = join(prefix, relative);
      const body = readFileSync(absolute);
      return {
        path: relative,
        size: body.length,
        mode: statSync(absolute).mode & 0o7777,
        sha256: sha256(body),
      };
    });
    const payloadDigest = sha256(
      canonicalJson({
        schema: "nexus.pm2-root-closure-payload.v1",
        files: payloadFiles,
      }),
    );
    writeFileSync(
      join(prefix, "closure-manifest.json"),
      `${JSON.stringify(
        {
          schema: "nexus.pm2-root-closure-manifest.v1",
          pm2Version: "6.0.14",
          nodeVersion: "v22.23.1",
          npmVersion: "10.9.8",
          packageLockSha256: sha256(JSON.stringify(lock)),
          packageLockPackages: [
            {
              path: "node_modules/pm2",
              version: "6.0.14",
              resolved:
                "https://registry.npmjs.org/pm2/-/pm2-6.0.14.tgz",
              integrity: pm2Integrity,
            },
          ],
          installedPackages: [
            { path: "node_modules/pm2", version: "6.0.14" },
          ],
          payloadDigest,
          fileCount: payloadFiles.length,
          files: payloadFiles,
        },
        null,
        2,
      )}\n`,
      { mode: 0o644 },
    );

    const valid = runHelper([
      "validate-pm2",
      "--prefix",
      prefix,
      "--lock",
      lockPath,
    ]);
    expect(valid.status, `${valid.stdout}${valid.stderr}`).toBe(0);
    expect(JSON.parse(valid.stdout)).toMatchObject({
      version: "6.0.14",
      packageCount: 1,
      integrity: pm2Integrity,
      payloadDigest,
      fileCount: payloadFiles.length + 1,
    });

    lock.packages["node_modules/pm2"].integrity =
      `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
    writeFileSync(lockPath, JSON.stringify(lock), { mode: 0o600 });
    const drift = runHelper([
      "validate-pm2",
      "--prefix",
      prefix,
      "--lock",
      lockPath,
    ]);
    expect(drift.status).not.toBe(0);
    expect(drift.stderr).toContain("does not bind exactly pm2 6.0.14");
  });

  it(
    "uses the same 50,000-member PM2 archive boundary at build and guest admission",
    { timeout: 30_000 },
    () => {
      const root = temporaryRoot();
      const atLimit = join(root, "at-limit.tar.gz");
      const overLimit = join(root, "over-limit.tar.gz");
      const placeholderLock = join(root, "placeholder-lock.json");
      writeFileSync(placeholderLock, "{}\n", { mode: 0o600 });
      const created = spawnSync(
        "python3",
        [
          "-c",
          [
            "import pathlib,sys,tarfile",
            "def build(output,count):",
            " with tarfile.open(output,'w:gz') as archive:",
            "  for index in range(count):",
            "   name='pm2-closure' if index==0 else f'pm2-closure/d{index:05d}'",
            "   entry=tarfile.TarInfo(name);entry.type=tarfile.DIRTYPE;entry.mode=0o755",
            "   archive.addfile(entry)",
            "build(sys.argv[1],50000)",
            "build(sys.argv[2],50001)",
          ].join("\n"),
          atLimit,
          overLimit,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(created.status, created.stderr).toBe(0);

      const acceptedBoundary = runHelper([
        "validate-pm2-archive",
        "--archive",
        atLimit,
        "--lock",
        placeholderLock,
      ]);
      expect(acceptedBoundary.status).not.toBe(0);
      expect(acceptedBoundary.stderr).toContain(
        "PM2 closure archive is missing a required payload",
      );
      expect(acceptedBoundary.stderr).not.toContain(
        "member count is invalid",
      );

      const rejectedBoundary = runHelper([
        "validate-pm2-archive",
        "--archive",
        overLimit,
        "--lock",
        placeholderLock,
      ]);
      expect(rejectedBoundary.status).not.toBe(0);
      expect(rejectedBoundary.stderr).toContain(
        "PM2 closure archive member count is invalid",
      );
      expect(readFileSync(helper, "utf8")).toContain(
        "entry_count > MAX_FILE_COUNT",
      );
      expect(guestControl).toContain("len(members)>50000");
    },
  );

  it("requires a regular Node binary while accepting governed nested links", () => {
    const root = temporaryRoot();
    const nodeTarget = join(root, "node-v22.23.1-linux-x64");
    const linkRoot = join(root, "usr-bin");
    mkdirSync(join(nodeTarget, "bin"), { recursive: true, mode: 0o700 });
    mkdirSync(join(nodeTarget, "lib/node_modules/npm/bin"), {
      recursive: true,
      mode: 0o700,
    });
    mkdirSync(join(nodeTarget, "lib/node_modules/corepack/dist"), {
      recursive: true,
      mode: 0o700,
    });
    mkdirSync(linkRoot, { mode: 0o700 });
    for (const path of [
      join(nodeTarget, "bin/node"),
      join(nodeTarget, "lib/node_modules/npm/bin/npm-cli.js"),
      join(nodeTarget, "lib/node_modules/npm/bin/npx-cli.js"),
      join(nodeTarget, "lib/node_modules/corepack/dist/corepack.js"),
    ]) {
      writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    symlinkSync(
      "../lib/node_modules/npm/bin/npm-cli.js",
      join(nodeTarget, "bin/npm"),
    );
    symlinkSync(
      "../lib/node_modules/npm/bin/npx-cli.js",
      join(nodeTarget, "bin/npx"),
    );
    symlinkSync(
      "../lib/node_modules/corepack/dist/corepack.js",
      join(nodeTarget, "bin/corepack"),
    );
    writeFileSync(join(linkRoot, "node"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    for (const binary of ["npm", "npx", "corepack"]) {
      symlinkSync(join(nodeTarget, "bin", binary), join(linkRoot, binary));
    }

    const valid = runHelper([
      "validate-node-entrypoints",
      "--node-target",
      nodeTarget,
      "--link-root",
      linkRoot,
    ]);
    expect(valid.status, `${valid.stdout}${valid.stderr}`).toBe(0);
    const validated = JSON.parse(valid.stdout);
    expect(validated).toMatchObject({
      version: "v22.23.1",
      npmVersion: "10.9.8",
    });
    expect(validated.entrypoints[0]).toMatchObject({
      name: "node",
      kind: "regular-file",
      entrypoint: join(linkRoot, "node"),
    });

    const outside = join(root, "outside-npm");
    writeFileSync(outside, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    rmSync(join(nodeTarget, "bin/npm"));
    symlinkSync(outside, join(nodeTarget, "bin/npm"));
    const escaped = runHelper([
      "validate-node-entrypoints",
      "--node-target",
      nodeTarget,
      "--link-root",
      linkRoot,
    ]);
    expect(escaped.status).not.toBe(0);
    expect(escaped.stderr).toContain("entrypoint escapes its runtime");
  });

  it("recovers only an unlinked regular Node file and permits removal of a partial next file", () => {
    const root = temporaryRoot();
    const source = join(root, "source-node");
    const candidate = join(root, "candidate-node");
    const validator = extractShellFunction(
      guestControl,
      "validate_recovery_regular_node",
    );
    const run = (allowPartial: boolean) =>
      spawnSync(
        "bash",
        [
          "-c",
          [
            "set -euo pipefail",
            'die() { printf "%s\\n" "$*" >&2; exit 1; }',
            validator,
            "validate_recovery_regular_node " +
              '"$CANDIDATE" "$SOURCE" "$ALLOW_PARTIAL" "$EXPECTED_UID"',
          ].join("\n"),
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CANDIDATE: candidate,
            SOURCE: source,
            ALLOW_PARTIAL: allowPartial ? "true" : "false",
            EXPECTED_UID: String(process.getuid?.() ?? 0),
          },
        },
      );
    writeFileSync(source, "exact-node-runtime\n", { mode: 0o755 });
    writeFileSync(candidate, "exact-node-runtime\n", { mode: 0o755 });
    expect(run(false).status).toBe(0);

    writeFileSync(candidate, "partial\n", { mode: 0o755 });
    expect(run(false).status).not.toBe(0);
    expect(run(true).status).toBe(0);

    rmSync(candidate);
    linkSync(source, candidate);
    expect(run(false).status).not.toBe(0);
    expect(statSync(candidate).nlink).toBe(2);
  });

  it("does not publish readiness when the installed v3 PM2 assertion fails", () => {
    const root = temporaryRoot();
    const control = join(root, "promotion-control");
    const log = join(root, "control.log");
    const marker = join(root, "readiness-published");
    writeFileSync(
      control,
      [
        "#!/usr/bin/env bash",
        'printf "%s\\n" "$1" >>"$CONTROL_LOG"',
        'if [ "$1" = assert-root-pm2-ready ]; then exit 75; fi',
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const assertion = extractShellFunction(
      guestControl,
      "assert_promotion_runtime_ready",
    );
    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          "set -euo pipefail",
          'die() { printf "%s\\n" "$*" >&2; exit 1; }',
          assertion,
          "assert_promotion_runtime_ready",
          'printf "ready\\n" >"$READINESS_MARKER"',
        ].join("\n"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CONTROL_BIN: control,
          CONTROL_LOG: log,
          READINESS_MARKER: marker,
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "installed v3 promotion control rejected the root PM2 closure",
    );
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(log, "utf8").trim()).toBe("assert-root-pm2-ready");
  });

  it("resolves Node archive hard links from the archive root and rejects escapes", () => {
    const root = temporaryRoot();
    const exercise = (linkTarget: string) => {
      const archive = join(root, `${sha256(linkTarget)}.tar.xz`);
      return spawnSync(
        "python3",
        [
          "-c",
          [
            "import importlib.util,io,json,sys,tarfile",
            "helper,archive,target=sys.argv[1:]",
            'spec=importlib.util.spec_from_file_location("runtime_manifest",helper)',
            "module=importlib.util.module_from_spec(spec)",
            "spec.loader.exec_module(module)",
            'root="node-v22.23.1-linux-x64"',
            'with tarfile.open(archive,"w:xz") as handle:',
            " directory=tarfile.TarInfo(root);directory.type=tarfile.DIRTYPE;directory.mode=0o755;handle.addfile(directory)",
            ' binary=tarfile.TarInfo(root+"/bin/node");binary.size=2;binary.mode=0o755;handle.addfile(binary,io.BytesIO(b"ok"))',
            ' linked=tarfile.TarInfo(root+"/bin/node-copy");linked.type=tarfile.LNKTYPE;linked.linkname=target;linked.mode=0o755;handle.addfile(linked)',
            "print(json.dumps(module.node_archive_runtime_identity(module.Path(archive))))",
          ].join("\n"),
          helper,
          archive,
          linkTarget,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, TMPDIR: root },
        },
      );
    };

    const accepted = exercise("node-v22.23.1-linux-x64/bin/node");
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(JSON.parse(accepted.stdout)).toMatchObject({
      binarySha256: sha256("ok"),
    });

    const escaped = exercise("../../outside");
    expect(escaped.status).not.toBe(0);
    expect(escaped.stderr).toContain(
      "Node archive link escapes its exact root",
    );
  });

  it("pins upstream identities and constructs the full PM2 closure without lifecycle scripts", () => {
    expect(readFileSync(helper, "utf8")).toContain(
      "890C08DB8579162FEE0DF9DB8BEAB4DFCF555EF4",
    );
    expect(readFileSync(helper, "utf8")).toContain(
      "b28073028e6d6855cfb53bf7fa0137599c01f967",
    );
    expect(readFileSync(helper, "utf8")).toContain(
      "6030d4e0cd53330acf2ab68acd455b7ca98bb5d5975376f0b7c0892308ba2d57",
    );
    expect(readFileSync(helper, "utf8")).toContain(
      "9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578",
    );
    expect(builder).toContain("npm ci");
    expect(builder).toContain("--offline");
    expect(builder).toContain("--ignore-scripts");
    expect(builder).toContain("npm_config_offline=true");
    expect(builder).toContain("npm_config_ignore_scripts=true");
    expect(builder).toContain('lifecycleScriptsExecuted":false');
    expect(builder).toContain("refs/remotes/origin/main^{commit}");
    expect(builder).toContain("owner private key must be an Ed25519 key");
    expect(builder).toContain(
      "requires the npm 10.9.8 shipped by Node v22.23.1",
    );
    expect(builder).toContain(
      "output parent must not be accessible by group or world",
    );
    expect(builder).not.toMatch(/\b(?:curl|wget)\b/);
    expect(builder).toContain("--prefix=source/");
    expect(builder).toContain("payload/control-source.tar.gz");
    expect(builder).toContain("payload/pm2-root-closure.tar.gz");
    expect(builder).toContain("nexus.pm2-root-closure-manifest.v1");
    expect(builder).toContain('if (name === ".bin") continue');
    expect(builder).toContain("manifest-owner-public-key.pem");
  });

  it("binds the protected source commit in the Git archive PAX header", () => {
    const commit = spawnSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    });
    expect(commit.status, commit.stderr).toBe(0);
    const archive = spawnSync("git", ["archive", "--format=tar", "HEAD"], {
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(archive.status, archive.stderr.toString()).toBe(0);
    const inspected = spawnSync(
      "python3",
      [
        "-c",
        [
          "import io,sys,tarfile",
          "body=sys.stdin.buffer.read()",
          'archive=tarfile.open(fileobj=io.BytesIO(body),mode="r:")',
          'print(archive.pax_headers.get("comment",""))',
        ].join(";"),
      ],
      {
        input: archive.stdout,
        encoding: "utf8",
      },
    );
    expect(inspected.status, inspected.stderr).toBe(0);
    expect(inspected.stdout.trim()).toBe(commit.stdout.trim());
  });

  it("keeps guest installation sequential, journaled, offline, and pending host seal", () => {
    expect(guestControl).toContain("stage-provision");
    expect(guestControl).toContain("stage-bundle");
    expect(guestControl).toContain(
      "/var/lib/nexus-rollback-drill-vm/toolchain-bundles",
    );
    expect(readFileSync(helper, "utf8")).toContain("O_NOFOLLOW");
    expect(readFileSync(helper, "utf8")).toContain("copy_signed_regular");
    expect(guestControl).toContain(
      "nexus.rollback-drill-vm-runtime-install-journal.v1",
    );
    expect(guestControl).toContain("rollback_install");
    expect(guestControl).toContain("node_target_touched=false");
    expect(guestControl).toContain("touched_links=()");
    expect(guestControl).toContain("elif ! $journal_armed");
    expect(guestControl).toContain(
      'if [ -n "$node_extract_parent" ]; then rm -rf',
    );
    expect(guestControl).toContain('for binary in "${touched_links[@]}"');
    expect(guestControl).toContain("runtime rollback was incomplete");
    expect(guestControl).toContain('filter="data"');
    expect(guestControl).toContain("remote-promotion-systemd-install.sh");
    expect(guestControl).toContain("manifest-owner-public-key.pem");
    expect(guestControl).toContain('PM2_TARGET="$PM2_PARENT/6.0.14"');
    expect(guestControl).toContain('PM2_LAUNCHER="/usr/local/bin/pm2"');
    expect(guestControl).toContain(
      'PM2_ATTESTATION="$PROMOTION_STATE_ROOT/pm2-root-install.v1.json"',
    );
    expect(guestControl).toContain(
      '"$BUNDLE_ROOT/payload/pm2-root-closure.tar.gz"',
    );
    expect(guestControl).toContain('root="pm2-closure"');
    expect(guestControl).not.toContain(
      'cp -a -- "$BUNDLE_ROOT/payload/pm2-closure"',
    );
    expect(guestControl).toContain(
      'CONTROL_SOURCE_ARCHIVE="$BOOTSTRAP_ROOT/source.tar.gz"',
    );
    expect(guestControl).toContain(
      'CONTROL_SOURCE_ROOT="$BOOTSTRAP_ROOT/source"',
    );
    expect(guestControl).toContain(
      "installed PM2 prefix contains an unexpected owner",
    );
    expect(guestControl).toContain(
      'install -o root -g root -m 0755 "$NODE_TARGET/bin/node" "$next"',
    );
    expect(guestControl).toContain("assert-root-pm2-ready");
    expect(guestControl).toContain('fsync_path "$STATE_ROOT"');
    expect(guestControl).toContain('fsync-tree --root "$node_stage"');
    expect(guestControl).toContain('fsync-tree --root "$pm2_stage"');
    expect(guestControl).toContain("recover-install");
    expect(guestControl).toContain("verify_runtime_recovery");
    expect(guestControl).toContain(
      "guest runtime recovery unit differs from the provision receipt",
    );
    expect(guestControl).toContain("--property=FragmentPath");
    expect(guestControl).toContain("--property=DropInPaths");
    expect(guestControl).toContain("--property=NeedDaemonReload");
    expect(guestControl).toContain("--property=ExecStart");
    expect(guestControl).toContain(
      "guest runtime recovery unit has unreviewed drop-ins",
    );
    expect(guestControl).toContain(
      "guest runtime recovery effective ExecStart drifted",
    );
    expect(guestControl).toContain('"runtimeRecovery":{');
    expect(guestControl).toContain("PM2 isolated dry-health ping failed");
    expect(guestControl).toContain('"pendingHostOverlaySeal":True');
    expect(guestControl).toContain('networkInstallAttempted":False');
    expect(guestControl).not.toMatch(/\battest\b/);
    expect(readFileSync(helper, "utf8")).not.toContain("validate-attestation");
    expect(guestControl).not.toMatch(
      /\b(?:apt|apt-get|curl|wget|npm\s+(?:install|ci)|pip\s+install)\b/,
    );
    expect(guestControl).not.toMatch(/systemctl\s+(?:start|restart)\b/);
  });

  it("collects readiness from one live nonce-bound guest and a stable stopped overlay", () => {
    expect(hostSealer).toContain("flock -n 9");
    expect(hostSealer).toContain(
      "pin-owner-key <public-key.pem> <expected-sha256>",
    );
    expect(hostSealer).toContain("register-bundle");
    expect(hostSealer).toContain("collect-runtime-readiness");
    expect(hostSealer).toContain("-F /dev/null");
    expect(hostSealer).toContain("ClearAllForwardings=yes");
    expect(hostSealer).toContain("ProxyCommand=none");
    expect(hostSealer).toContain("StrictHostKeyChecking=yes");
    expect(hostSealer).toContain("measure");
    expect(hostSealer).toContain('kill -USR1 "$supervisor_pid"');
    expect(hostSealer).toContain("O_NOFOLLOW");
    expect(hostSealer).toContain("changed during root copy");
    expect(hostSealer).toContain("ssh-keygen -Y verify");
    expect(hostSealer).toContain("validate-readiness");
    expect(hostSealer).toContain(
      "process {process.name} still holds the selected overlay inode",
    );
    expect(hostSealer).toContain(
      "process {process.name} still maps the selected overlay inode",
    );
    expect(hostSealer).toContain("value.st_ctime_ns");
    expect(hostSealer).toContain("os.O_CREAT|os.O_EXCL");
    expect(hostSealer).toContain("os.rename(stage,path)");
    expect(hostSealer).toContain("fsync(directory)");
    expect(hostSealer).toContain('"drillReady":True');
    expect(hostSealer).toContain('"initialSha256":overlay_initial');
    expect(hostSealer).toContain('"currentSha256":overlay_current');
    expect(hostSealer).toContain(
      "runtime readiness receipt is immutable and already exists",
    );
    expect(hostSealer).not.toContain("<guest-attestation>");
    expect(hostSealer).not.toContain("STAGED_ATTESTATION");
    expect(hostSealer).not.toMatch(/systemctl\s+(?:start|restart|enable)\b/);
    expect(hostSealer).not.toMatch(/(?:mv|install|cp)[^\n]*\$ACTIVE_RECEIPT/);
  });

  it("resumes every immutable-readiness publication boundary before accepting success", () => {
    expect(hostSealer).toContain(
      "$EVIDENCE_PARENT/$SET_ID/$guest/$preliminary_auth_id/journal.json",
    );
    const receiptBranchStart = hostSealer.indexOf(
      'if [ -e "$readiness" ] || [ -L "$readiness" ]; then',
    );
    const liveCollectionStart = hostSealer.indexOf(
      'validate_lock_path "$ADMISSION_LOCK"',
      receiptBranchStart,
    );
    const receiptBranch = hostSealer.slice(
      receiptBranchStart,
      liveCollectionStart,
    );
    const missingFinal = receiptBranch.indexOf(
      'if [ ! -e "$evidence_target" ] && [ ! -L "$evidence_target" ]; then',
    );
    const pendingValidation = receiptBranch.indexOf(
      "pending published readiness journal is invalid",
      missingFinal,
    );
    const qemuExitedRecovery = receiptBranch.indexOf(
      'if [ "$pending_status" = qemu_exited ]; then',
      pendingValidation,
    );
    const checkpoint = receiptBranch.indexOf(
      'checkpoint_journal_status "$journal" readiness_published',
      qemuExitedRecovery,
    );
    const evidenceMove = receiptBranch.indexOf(
      'mv -T -- "$pending" "$evidence_target"',
      checkpoint,
    );
    const sourceParentFsync = receiptBranch.indexOf(
      'fsync_path "$PENDING_PARENT"',
      evidenceMove,
    );
    const stateRootFsync = receiptBranch.indexOf(
      'fsync_path "$STATE_ROOT"',
      sourceParentFsync,
    );
    const finalValidation = receiptBranch.indexOf(
      'validate_root_chain "$evidence_target"',
      evidenceMove,
    );
    const requestCleanup = receiptBranch.indexOf(
      'durable_remove "$request"',
      finalValidation,
    );

    expect(receiptBranchStart).toBeGreaterThan(-1);
    expect(liveCollectionStart).toBeGreaterThan(receiptBranchStart);
    expect(missingFinal).toBeGreaterThan(-1);
    expect(pendingValidation).toBeGreaterThan(missingFinal);
    expect(qemuExitedRecovery).toBeGreaterThan(pendingValidation);
    expect(checkpoint).toBeGreaterThan(qemuExitedRecovery);
    expect(evidenceMove).toBeGreaterThan(checkpoint);
    expect(sourceParentFsync).toBeGreaterThan(evidenceMove);
    expect(stateRootFsync).toBeGreaterThan(sourceParentFsync);
    expect(finalValidation).toBeGreaterThan(evidenceMove);
    expect(requestCleanup).toBeGreaterThan(finalValidation);
    expect(receiptBranch).toContain(
      'value["status"] not in {"qemu_exited","readiness_published"}',
    );
    expect(receiptBranch).toContain(
      "published readiness has both pending and final evidence",
    );
  });

  it("fsyncs every persistent collection ancestor and both sides of the evidence rename", () => {
    const topLevelInstall = hostSealer.indexOf(
      'install -d -o root -g root -m 0700 "$PENDING_PARENT" "$EVIDENCE_PARENT"',
    );
    const topPendingFsync = hostSealer.indexOf(
      'fsync_path "$PENDING_PARENT"',
      topLevelInstall,
    );
    const topEvidenceFsync = hostSealer.indexOf(
      'fsync_path "$EVIDENCE_PARENT"',
      topPendingFsync,
    );
    const topStateFsync = hostSealer.indexOf(
      'fsync_path "$STATE_ROOT"',
      topEvidenceFsync,
    );
    const readinessInstall = hostSealer.lastIndexOf(
      'install -d -o root -g nexus-drill-vm -m 0750 "$READINESS_PARENT" "$readiness_dir"',
    );
    const readinessLeafFsync = hostSealer.indexOf(
      'fsync_path "$readiness_dir"',
      readinessInstall,
    );
    const readinessParentFsync = hostSealer.indexOf(
      'fsync_path "$READINESS_PARENT"',
      readinessLeafFsync,
    );
    const readinessStateFsync = hostSealer.indexOf(
      'fsync_path "$STATE_ROOT"',
      readinessParentFsync,
    );
    const evidenceInstall = hostSealer.lastIndexOf(
      'install -d -o root -g root -m 0700 \\\n    "$EVIDENCE_PARENT/$SET_ID" "$evidence_dir"',
    );
    const evidenceLeafPreFsync = hostSealer.indexOf(
      'fsync_path "$evidence_dir"',
      evidenceInstall,
    );
    const evidenceSetPreFsync = hostSealer.indexOf(
      'fsync_path "$EVIDENCE_PARENT/$SET_ID"',
      evidenceLeafPreFsync,
    );
    const evidenceParentPreFsync = hostSealer.indexOf(
      'fsync_path "$EVIDENCE_PARENT"',
      evidenceSetPreFsync,
    );
    const evidenceStatePreFsync = hostSealer.indexOf(
      'fsync_path "$STATE_ROOT"',
      evidenceParentPreFsync,
    );
    const evidenceMove = hostSealer.indexOf(
      'mv -T -- "$pending" "$evidence_target"',
      evidenceStatePreFsync,
    );
    const evidenceLeafPostFsync = hostSealer.indexOf(
      'fsync_path "$evidence_dir"',
      evidenceMove,
    );
    const evidenceSetPostFsync = hostSealer.indexOf(
      'fsync_path "$EVIDENCE_PARENT/$SET_ID"',
      evidenceLeafPostFsync,
    );
    const evidenceParentPostFsync = hostSealer.indexOf(
      'fsync_path "$EVIDENCE_PARENT"',
      evidenceSetPostFsync,
    );
    const pendingPostFsync = hostSealer.indexOf(
      'fsync_path "$PENDING_PARENT"',
      evidenceParentPostFsync,
    );
    const statePostFsync = hostSealer.indexOf(
      'fsync_path "$STATE_ROOT"',
      pendingPostFsync,
    );
    const requestRemoval = hostSealer.indexOf(
      'durable_remove "$request"',
      statePostFsync,
    );

    expect(topLevelInstall).toBeGreaterThan(-1);
    expect(topPendingFsync).toBeGreaterThan(topLevelInstall);
    expect(topEvidenceFsync).toBeGreaterThan(topPendingFsync);
    expect(topStateFsync).toBeGreaterThan(topEvidenceFsync);
    expect(readinessInstall).toBeGreaterThan(topStateFsync);
    expect(readinessLeafFsync).toBeGreaterThan(readinessInstall);
    expect(readinessParentFsync).toBeGreaterThan(readinessLeafFsync);
    expect(readinessStateFsync).toBeGreaterThan(readinessParentFsync);
    expect(evidenceInstall).toBeGreaterThan(readinessStateFsync);
    expect(evidenceLeafPreFsync).toBeGreaterThan(evidenceInstall);
    expect(evidenceSetPreFsync).toBeGreaterThan(evidenceLeafPreFsync);
    expect(evidenceParentPreFsync).toBeGreaterThan(evidenceSetPreFsync);
    expect(evidenceStatePreFsync).toBeGreaterThan(evidenceParentPreFsync);
    expect(evidenceMove).toBeGreaterThan(evidenceStatePreFsync);
    expect(evidenceLeafPostFsync).toBeGreaterThan(evidenceMove);
    expect(evidenceSetPostFsync).toBeGreaterThan(evidenceLeafPostFsync);
    expect(evidenceParentPostFsync).toBeGreaterThan(evidenceSetPostFsync);
    expect(pendingPostFsync).toBeGreaterThan(evidenceParentPostFsync);
    expect(statePostFsync).toBeGreaterThan(pendingPostFsync);
    expect(requestRemoval).toBeGreaterThan(statePostFsync);
  });

  it("requires every privileged runtime asset to be executable and non-writable by group/world", () => {
    for (const path of [
      "scripts/build-rollback-drill-vm-runtime-bundle.sh",
      "scripts/rollback-drill-vm-runtime-control.sh",
      "scripts/rollback-drill-vm-runtime-manifest.py",
      "scripts/rollback-drill-vm-runtime-readiness-seal.sh",
    ]) {
      const mode = statSync(path).mode & 0o777;
      expect(mode & 0o022, `${path} is group/world writable`).toBe(0);
      expect(mode & 0o100, `${path} is not owner executable`).not.toBe(0);
    }
  });
});
