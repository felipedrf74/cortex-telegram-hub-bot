import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const controller = path.resolve(
  'scripts/application-dr-cloudformation-activate.py',
);
const templatePath = path.resolve('ops/application-dr/aws-s3-stack.yaml');
const systemPython = [
  process.env.CONTENT_ENGINE_PYTHON,
  '/opt/homebrew/bin/python3',
  '/usr/bin/python3',
].find((candidate): candidate is string => (
  typeof candidate === 'string' && fs.existsSync(candidate)
));

type Transition = 'roles-anywhere' | 'lifecycle';

interface Parameter {
  ParameterKey: string;
  ParameterValue: string;
}

interface Fixture {
  root: string;
  transition: Transition;
  aws: string;
  state: string;
  commandLog: string;
  reviewReceipt: string;
  evidence: string;
  journal: string;
  crlEvidence?: string;
  probeEvidence?: string;
  commonArgs: string[];
}

function digest(body: Buffer | string): string {
  return crypto.createHash('sha256').update(body).digest('hex');
}

function writeTrusted(file: string, body: string, mode: number): void {
  fs.writeFileSync(file, body, { mode });
  fs.chmodSync(file, mode);
}

function normalizedParameters(values: Record<string, string>): Parameter[] {
  return Object.keys(values)
    .sort()
    .map((key) => ({
      ParameterKey: key,
      ParameterValue: values[key],
    }));
}

function parameterDigest(parameters: Parameter[]): string {
  return digest(JSON.stringify(parameters));
}

function outputList(values: Record<string, string>) {
  return Object.entries(values).map(([OutputKey, OutputValue]) => ({
    OutputKey,
    OutputValue,
  }));
}

function lifecycleRules(prefix: string, enabled: boolean) {
  const status = enabled ? 'Enabled' : 'Disabled';
  return [
    {
      ID: 'GovernedNamespaceHygiene',
      Prefix: `${prefix}/`,
      Status: 'Enabled',
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
      ExpiredObjectDeleteMarker: true,
    },
    ...[
      ['DatabaseHourlyWriteOnceRetention', 'database/hourly', 3],
      ['DatabaseDailyWriteOnceRetention', 'database/daily', 9],
      ['DatabaseWeeklyWriteOnceRetention', 'database/weekly', 36],
      ['DatabaseMonthlyWriteOnceRetention', 'database/monthly', 191],
      ['ReleaseWriteOnceRetention', 'releases', 92],
    ].map(([ID, suffix, days]) => ({
      ID,
      Prefix: `${prefix}/${suffix}/`,
      Status: status,
      Expiration: { Days: days },
      NoncurrentVersionExpiration: { NoncurrentDays: 1 },
    })),
  ];
}

function makeFixture(
  transition: Transition,
  options: {
    extraChange?: boolean;
    driftOnSecondDescribe?: boolean;
    finalControlMismatch?: boolean;
    finalStackControlMismatch?: boolean;
    alarmInitiallyOk?: boolean;
    failDescribeAfterExecuteOnce?: boolean;
    failExecuteResponseOnce?: boolean;
    rollbackOnExecute?: boolean;
    stackLevelDrift?:
      | 'deployment'
      | 'execution-role'
      | 'import'
      | 'notification'
      | 'rollback'
      | 'tags';
  } = {},
): Fixture {
  if (!systemPython) throw new Error('Python 3 is required');
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-dr-cfn-activation-')),
  );
  fs.chmodSync(root, 0o700);
  const tools = path.join(root, 'tools');
  const versioned = path.join(tools, 'aws-cli-v2');
  const configDir = path.join(root, 'config');
  const privateDir = path.join(root, 'private');
  const evidenceDir = path.join(root, 'evidence');
  for (const directory of [
    tools,
    versioned,
    configDir,
    privateDir,
    evidenceDir,
  ]) {
    fs.mkdirSync(directory, { mode: 0o700 });
  }

  const account = '123456789012';
  const region = 'eu-west-1';
  const stackId = `arn:aws:cloudformation:${region}:${account}:stack/NexusApplicationDr/11111111-1111-1111-1111-111111111111`;
  const changeSetId = `arn:aws:cloudformation:${region}:${account}:changeSet/activate-application-dr/22222222-2222-2222-2222-222222222222`;
  const trustAnchorId = '33333333-3333-3333-3333-333333333333';
  const crlId = '44444444-4444-4444-4444-444444444444';
  const backupProfileId = '55555555-5555-5555-5555-555555555555';
  const restoreProfileId = '66666666-6666-6666-6666-666666666666';
  const trustAnchorArn = `arn:aws:rolesanywhere:${region}:${account}:trust-anchor/${trustAnchorId}`;
  const backupProfileArn = `arn:aws:rolesanywhere:${region}:${account}:profile/${backupProfileId}`;
  const restoreProfileArn = `arn:aws:rolesanywhere:${region}:${account}:profile/${restoreProfileId}`;
  const backupRoleArn = `arn:aws:iam::${account}:role/nexus/application-dr/BackupRole`;
  const restoreRoleArn = `arn:aws:iam::${account}:role/nexus/application-dr/RestoreRole`;
  const rollbackAlarmArn = `arn:aws:cloudwatch:${region}:${account}:alarm:NexusApplicationDr-roles-anywhere-activation-rollback`;
  const bucket = 'nexus-application-dr-fixture';
  const prefix = 'nexus-hub/application';
  const bootstrapReceipt = path.join(privateDir, 'bootstrap-receipt.json');
  const bootstrapBody = '{"schema":"fixture-bootstrap","status":"passed"}\n';
  writeTrusted(bootstrapReceipt, bootstrapBody, 0o600);
  const bootstrapSha = digest(bootstrapBody);

  const currentValues = {
    CertificateRevocationListSha256: 'a'.repeat(64),
    LifecycleActivation: 'DISABLED',
    LifecycleBootstrapReceiptSha256: '',
    PrincipalProvisioningMode: 'IAM_ROLES_ANYWHERE',
    RolesAnywhereActivation: transition === 'roles-anywhere'
      ? 'DISABLED'
      : 'ENABLED',
  };
  const desiredValues = {
    ...currentValues,
    RolesAnywhereActivation: 'ENABLED',
    LifecycleActivation: transition === 'lifecycle'
      ? 'ENABLED'
      : 'DISABLED',
    LifecycleBootstrapReceiptSha256: transition === 'lifecycle'
      ? bootstrapSha
      : '',
  };
  const currentParameters = normalizedParameters(currentValues);
  const desiredParameters = normalizedParameters(desiredValues);
  const commonOutputs = {
    BucketName: bucket,
    DrPrefix: prefix,
    BackupPrincipalArn: backupRoleArn,
    RestorePrincipalArn: restoreRoleArn,
    RolesAnywhereTrustAnchorArn: trustAnchorArn,
    RolesAnywhereCrlId: crlId,
    BackupRolesAnywhereProfileArn: backupProfileArn,
    RestoreRolesAnywhereProfileArn: restoreProfileArn,
    RolesAnywhereActivationRollbackAlarmArn: rollbackAlarmArn,
  };
  const currentOutputs = {
    ...commonOutputs,
    RolesAnywhereActivation: currentValues.RolesAnywhereActivation,
    LifecycleActivation: currentValues.LifecycleActivation,
    LifecycleBootstrapReceiptSha256:
      currentValues.LifecycleBootstrapReceiptSha256,
  };
  const finalOutputs = {
    ...commonOutputs,
    RolesAnywhereActivation: desiredValues.RolesAnywhereActivation,
    LifecycleActivation: desiredValues.LifecycleActivation,
    LifecycleBootstrapReceiptSha256:
      desiredValues.LifecycleBootstrapReceiptSha256,
  };
  const activationRollbackConfiguration = {
    RollbackTriggers: [{
      Arn: rollbackAlarmArn,
      Type: 'AWS::CloudWatch::Alarm',
    }],
    MonitoringTimeInMinutes: 30,
  };
  const currentControls = {
    NotificationARNs: [],
    RollbackConfiguration: transition === 'lifecycle'
      ? activationRollbackConfiguration
      : {},
    Tags: null,
    DisableRollback: false,
    EnableTerminationProtection: true,
  };
  const expectedFinalControls = {
    ...currentControls,
    RollbackConfiguration: transition === 'roles-anywhere'
      ? activationRollbackConfiguration
      : {
        RollbackTriggers: [],
        MonitoringTimeInMinutes: 0,
      },
  };
  const finalControls = options.finalStackControlMismatch
    ? {
      ...expectedFinalControls,
      NotificationARNs: [
        `arn:aws:sns:${region}:${account}:unexpected-activation-events`,
      ],
    }
    : expectedFinalControls;
  const changeResources = transition === 'roles-anywhere'
    ? [
      ['RolesAnywhereTrustAnchor', 'AWS::RolesAnywhere::TrustAnchor'],
      ['RolesAnywhereCertificateRevocationList', 'AWS::RolesAnywhere::CRL'],
      ['BackupRolesAnywhereProfile', 'AWS::RolesAnywhere::Profile'],
      ['RestoreRolesAnywhereProfile', 'AWS::RolesAnywhere::Profile'],
    ]
    : [['DisasterRecoveryBucket', 'AWS::S3::Bucket']];
  if (options.extraChange) {
    changeResources.push([
      'DisasterRecoveryBucketPolicy',
      'AWS::S3::BucketPolicy',
    ]);
  }
  const changeSet: Record<string, unknown> = {
    StackId: stackId,
    ChangeSetId: changeSetId,
    ChangeSetType: 'UPDATE',
    Status: 'CREATE_COMPLETE',
    ExecutionStatus: 'AVAILABLE',
    IncludeNestedStacks: false,
    Capabilities: ['CAPABILITY_IAM'],
    NotificationARNs: [],
    RollbackConfiguration: transition === 'roles-anywhere'
      ? activationRollbackConfiguration
      : {
        RollbackTriggers: [],
        MonitoringTimeInMinutes: 0,
      },
    Tags: null,
    DeploymentConfig: {
      Mode: 'STANDARD',
      DisableRollback: false,
    },
    Parameters: desiredParameters,
    Changes: changeResources.map(([LogicalResourceId, ResourceType]) => ({
      ResourceChange: {
        Action: 'Modify',
        LogicalResourceId,
        ResourceType,
        Replacement: 'False',
        Scope: ['Properties'],
      },
    })),
    CreationTime: '2026-07-25T12:00:00Z',
  };
  if (options.stackLevelDrift === 'notification') {
    changeSet.NotificationARNs = [
      `arn:aws:sns:${region}:${account}:unexpected-activation-events`,
    ];
  } else if (options.stackLevelDrift === 'rollback') {
    changeSet.RollbackConfiguration = {
      RollbackTriggers: [{
        Arn: `arn:aws:cloudwatch:${region}:${account}:alarm:unexpected`,
        Type: 'AWS::CloudWatch::Alarm',
      }],
      MonitoringTimeInMinutes: 5,
    };
  } else if (options.stackLevelDrift === 'tags') {
    changeSet.Tags = [{ Key: 'Unexpected', Value: 'activation-drift' }];
  } else if (options.stackLevelDrift === 'execution-role') {
    changeSet.RoleARN = `arn:aws:iam::${account}:role/UnexpectedActivationRole`;
  } else if (options.stackLevelDrift === 'import') {
    changeSet.ImportExistingResources = true;
  } else if (options.stackLevelDrift === 'deployment') {
    changeSet.DeploymentConfig = {
      Mode: 'EXPRESS',
      DisableRollback: true,
    };
  }
  const reviewedChangeSet = path.join(
    privateDir,
    'reviewed-change-set.json',
  );
  const reviewedBody = `${JSON.stringify(changeSet, null, 2)}\n`;
  writeTrusted(reviewedChangeSet, reviewedBody, 0o600);
  const template = fs.readFileSync(templatePath, 'utf8');
  const templateSha = digest(template);
  const data = {
    template,
    stackId,
    changeSet,
    currentStack: {
      Stacks: [{
        StackId: stackId,
        StackStatus: transition === 'roles-anywhere'
          ? 'CREATE_COMPLETE'
          : 'UPDATE_COMPLETE',
        Parameters: currentParameters,
        Outputs: outputList(currentOutputs),
        ...currentControls,
      }],
    },
    finalStack: {
      Stacks: [{
        StackId: stackId,
        StackStatus: 'UPDATE_COMPLETE',
        Parameters: desiredParameters,
        Outputs: outputList(finalOutputs),
        ...finalControls,
      }],
    },
    identity: {
      trustAnchorId,
      trustAnchorArn,
      crlId,
      backupProfileId,
      backupProfileArn,
      restoreProfileId,
      restoreProfileArn,
      backupRoleArn,
      restoreRoleArn,
    },
    bucket,
    lifecycleDisabled: lifecycleRules(prefix, false),
    lifecycleEnabled: lifecycleRules(prefix, true),
  };
  const dataFile = path.join(privateDir, 'fake-data.json');
  writeTrusted(dataFile, `${JSON.stringify(data)}\n`, 0o600);
  const state = path.join(privateDir, 'fake-state.json');
  writeTrusted(state, `${JSON.stringify({
    phase: 'current',
    describeCount: 0,
    driftOnSecondDescribe: options.driftOnSecondDescribe ?? false,
    finalControlMismatch: options.finalControlMismatch ?? false,
    alarmState: options.alarmInitiallyOk ? 'OK' : 'ALARM',
    failDescribeAfterExecuteOnce:
      options.failDescribeAfterExecuteOnce ?? false,
    failedDescribeAfterExecute: false,
    failExecuteResponseOnce: options.failExecuteResponseOnce ?? false,
    failedExecuteResponse: false,
    rollbackOnExecute: options.rollbackOnExecute ?? false,
  })}\n`, 0o600);
  const commandLog = path.join(privateDir, 'commands.jsonl');
  const realAws = path.join(versioned, 'aws');
  const fakeSource = `#!${systemPython}
import json
import os
from pathlib import Path
import sys

data_path = Path(${JSON.stringify(dataFile)})
state_path = Path(${JSON.stringify(state)})
log_path = Path(${JSON.stringify(commandLog)})
data = json.loads(data_path.read_text())
state = json.loads(state_path.read_text())
arguments = sys.argv[1:]
unsafe = [
    key for key in (
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_ENDPOINT_URL",
        "AWS_ENDPOINT_URL_CLOUDFORMATION",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "AWS_CA_BUNDLE",
        "PYTHONPATH",
        "DYLD_LIBRARY_PATH",
    )
    if key in os.environ
]
with log_path.open("a", encoding="utf-8") as target:
    target.write(json.dumps({
        "arguments": arguments,
        "unsafeEnvironment": unsafe,
        "configuredEndpointIgnored":
            os.environ.get("AWS_IGNORE_CONFIGURED_ENDPOINT_URLS"),
        "profile": os.environ.get("AWS_PROFILE"),
    }, sort_keys=True) + "\\n")
if unsafe or os.environ.get("AWS_IGNORE_CONFIGURED_ENDPOINT_URLS") != "true":
    raise SystemExit(88)

def persist():
    state_path.write_text(json.dumps(state) + "\\n")

def emit(value):
    print(json.dumps(value, separators=(",", ":"), sort_keys=True))

command = arguments[:3]
if command[:2] == ["cloudformation", "describe-stacks"]:
    if (
        state["phase"] == "final"
        and state["failDescribeAfterExecuteOnce"]
        and not state["failedDescribeAfterExecute"]
    ):
        state["failedDescribeAfterExecute"] = True
        persist()
        raise SystemExit(71)
    state["describeCount"] += 1
    selected = data["finalStack"] if state["phase"] == "final" else data["currentStack"]
    selected = json.loads(json.dumps(selected))
    if state["phase"] == "rollback":
        selected["Stacks"][0]["StackStatus"] = "UPDATE_ROLLBACK_COMPLETE"
    if (
        state["phase"] == "current"
        and state["driftOnSecondDescribe"]
        and state["describeCount"] >= 2
    ):
        for parameter in selected["Stacks"][0]["Parameters"]:
            if parameter["ParameterKey"] == "LifecycleActivation":
                parameter["ParameterValue"] = "ENABLED"
    persist()
    emit(selected)
elif command[:2] == ["cloudformation", "get-template"]:
    emit({"TemplateBody": data["template"]})
elif command[:2] == ["cloudformation", "describe-change-set"]:
    selected = json.loads(json.dumps(data["changeSet"]))
    if state["phase"] in {"final", "rollback"}:
        selected["ExecutionStatus"] = "EXECUTE_COMPLETE"
    emit(selected)
elif command[:2] == ["cloudformation", "execute-change-set"]:
    state["phase"] = "rollback" if state["rollbackOnExecute"] else "final"
    persist()
    if (
        state["failExecuteResponseOnce"]
        and not state["failedExecuteResponse"]
    ):
        state["failedExecuteResponse"] = True
        persist()
        raise SystemExit(72)
elif command == ["cloudformation", "wait", "stack-update-complete"]:
    if state["phase"] != "final":
        raise SystemExit(65)
elif command[:2] == ["rolesanywhere", "get-trust-anchor"]:
    enabled = (
        data["currentStack"]["Stacks"][0]["Outputs"][
            next(
                index for index, item
                in enumerate(data["currentStack"]["Stacks"][0]["Outputs"])
                if item["OutputKey"] == "RolesAnywhereActivation"
            )
        ]["OutputValue"] == "ENABLED"
    )
    if state["phase"] == "final":
        enabled = not state["finalControlMismatch"]
    emit({"trustAnchor": {
        "trustAnchorId": data["identity"]["trustAnchorId"],
        "trustAnchorArn": data["identity"]["trustAnchorArn"],
        "enabled": enabled,
    }})
elif command[:2] == ["rolesanywhere", "get-crl"]:
    enabled = (
        data["currentStack"]["Stacks"][0]["Outputs"][
            next(
                index for index, item
                in enumerate(data["currentStack"]["Stacks"][0]["Outputs"])
                if item["OutputKey"] == "RolesAnywhereActivation"
            )
        ]["OutputValue"] == "ENABLED"
    )
    if state["phase"] == "final":
        enabled = not state["finalControlMismatch"]
    emit({"crl": {
        "crlId": data["identity"]["crlId"],
        "trustAnchorArn": data["identity"]["trustAnchorArn"],
        "enabled": enabled,
    }})
elif command[:2] == ["rolesanywhere", "get-profile"]:
    profile_id = arguments[arguments.index("--profile-id") + 1]
    backup = profile_id == data["identity"]["backupProfileId"]
    enabled = (
        data["currentStack"]["Stacks"][0]["Outputs"][
            next(
                index for index, item
                in enumerate(data["currentStack"]["Stacks"][0]["Outputs"])
                if item["OutputKey"] == "RolesAnywhereActivation"
            )
        ]["OutputValue"] == "ENABLED"
    )
    if state["phase"] == "final":
        enabled = not state["finalControlMismatch"]
    emit({"profile": {
        "profileId": profile_id,
        "profileArn": (
            data["identity"]["backupProfileArn"]
            if backup else data["identity"]["restoreProfileArn"]
        ),
        "enabled": enabled,
        "roleArns": [(
            data["identity"]["backupRoleArn"]
            if backup else data["identity"]["restoreRoleArn"]
        )],
        "acceptRoleSessionName": False,
        "durationSeconds": 900,
    }})
elif command[:2] == ["s3api", "get-bucket-lifecycle-configuration"]:
    enabled = (
        state["phase"] == "final"
        and data["finalStack"]["Stacks"][0]["Outputs"][
            next(
                index for index, item
                in enumerate(data["finalStack"]["Stacks"][0]["Outputs"])
                if item["OutputKey"] == "LifecycleActivation"
            )
        ]["OutputValue"] == "ENABLED"
    )
    emit({"Rules": (
        data["lifecycleEnabled"] if enabled else data["lifecycleDisabled"]
    )})
elif command[:2] == ["cloudwatch", "describe-alarms"]:
    emit({"MetricAlarms": [{
        "AlarmArn": ${JSON.stringify(rollbackAlarmArn)},
        "AlarmName": "NexusApplicationDr-roles-anywhere-activation-rollback",
        "ComparisonOperator": "LessThanThreshold",
        "DatapointsToAlarm": 24,
        "Dimensions": [{"Name": "StackName", "Value": "NexusApplicationDr"}],
        "EvaluationPeriods": 24,
        "MetricName": "ActivationLease",
        "Namespace": "Nexus/ApplicationDR",
        "Period": 30,
        "Statistic": "Minimum",
        "Threshold": 1,
        "TreatMissingData": "breaching",
        "Unit": "Count",
        "StateValue": state["alarmState"],
    }]})
elif command[:2] == ["cloudwatch", "put-metric-data"]:
    state["alarmState"] = "OK"
    persist()
else:
    print("unexpected fake AWS CLI command", file=sys.stderr)
    raise SystemExit(64)
`;
  writeTrusted(realAws, fakeSource, 0o700);
  const aws = path.join(tools, 'aws');
  fs.symlinkSync('aws-cli-v2/aws', aws);

  const awsConfig = path.join(configDir, 'aws-config');
  writeTrusted(
    awsConfig,
    '[profile nexus-application-dr-activation]\n'
      + `region = ${region}\n`
      + 'credential_process = /reviewed/short-lived-boundary\n',
    0o600,
  );
  const reviewReceipt = path.join(evidenceDir, 'activation-review.json');
  const evidence = path.join(evidenceDir, 'activation-result.json');
  const journal = path.join(evidenceDir, 'activation-journal.json');
  const crlEvidence = path.join(evidenceDir, 'activation-crl.json');
  const probeEvidence = path.join(evidenceDir, 'activation-probe.json');
  const commonArgs = [
    controller,
    '--transition', transition,
    '--stack-id', stackId,
    '--change-set-id', changeSetId,
    '--reviewed-change-set', reviewedChangeSet,
    '--reviewed-change-set-sha256', digest(reviewedBody),
    '--expected-template-sha256', templateSha,
    '--expected-current-parameters-sha256',
    parameterDigest(currentParameters),
    '--region', region,
    '--aws-bin', aws,
    '--aws-config', awsConfig,
    '--aws-profile', 'nexus-application-dr-activation',
    '--review-receipt', reviewReceipt,
    '--journal', journal,
    '--expected-owner-uid', String(process.getuid?.() ?? 0),
    '--trust-boundary', root,
    '--command-timeout-seconds', '10',
    '--wait-timeout-seconds', '60',
  ];
  if (transition === 'lifecycle') {
    commonArgs.push(
      '--bootstrap-receipt', bootstrapReceipt,
      '--bootstrap-receipt-sha256', bootstrapSha,
    );
  } else {
    const crlVerifier = path.join(versioned, 'post-enable-crl-verifier');
    const crlVerifierSource = `#!${systemPython}
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
import sys

expected_aws = ${JSON.stringify(realAws)}
resolved_aws = shutil.which("aws")
if resolved_aws is None or os.path.realpath(resolved_aws) != expected_aws:
    raise SystemExit("post-enable CRL verifier cannot resolve the reviewed AWS CLI")

arguments = dict(zip(sys.argv[2::2], sys.argv[3::2]))
evidence = {
    "schema": "nexus.application-dr-crl-live-verification.v1",
    "verifiedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "region": arguments["--region"],
    "trustAnchorArn": arguments["--trust-anchor-arn"],
    "trustAnchorEnabled": True,
    "backupProfileArn": arguments["--backup-profile-arn"],
    "backupProfileEnabled": True,
    "restoreProfileArn": arguments["--restore-profile-arn"],
    "restoreProfileEnabled": True,
    "crlId": arguments["--crl-id"],
    "crlEnabled": True,
    "exactBytesVerified": True,
    "digestTagVerified": True,
}
output = Path(arguments["--evidence-out"])
output.write_text(json.dumps(evidence, separators=(",", ":"), sort_keys=True) + "\\n")
output.chmod(0o600)
print(json.dumps({
    "ok": True,
    "crlEnabled": True,
    "exactBytesVerified": True,
}, separators=(",", ":"), sort_keys=True))
`;
    writeTrusted(crlVerifier, crlVerifierSource, 0o700);
    const crlArgsPath = path.join(privateDir, 'crl-verifier-arguments.json');
    const crlArgs = [
      'verify',
      '--region', region,
      '--trust-anchor-arn', trustAnchorArn,
      '--backup-profile-arn', backupProfileArn,
      '--restore-profile-arn', restoreProfileArn,
      '--crl-id', crlId,
      '--name', 'NexusApplicationDr-crl',
      '--expected-enabled', 'true',
      '--issuer-cn', 'nexus-application-dr-ca',
      '--ca-certificate', path.join(privateDir, 'ca.pem'),
      '--crl', path.join(privateDir, 'revocation.crl'),
      '--parameter-evidence', path.join(privateDir, 'crl-parameters.json'),
      '--aws-profile', 'nexus-application-dr-activation',
      '--evidence-out', crlEvidence,
    ];
    const crlArgsBody = `${JSON.stringify(crlArgs)}\n`;
    writeTrusted(crlArgsPath, crlArgsBody, 0o600);
    const probe = path.join(versioned, 'post-enable-probe');
    const probeSource = `#!${systemPython}
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
import sys

arguments = dict(zip(sys.argv[1::2], sys.argv[2::2]))
def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()
evidence = {
    "schemaVersion": "NexusApplicationDrRolesAnywhereProbeV1",
    "status": "passed",
    "observedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "region": arguments["--region"],
    "identityBinding": {
        "expectedRoleArnSha256": digest(arguments["--expected-role-arn"]),
        "trustAnchorArnSha256": digest(arguments["--expected-trust-anchor-arn"]),
        "profileArnSha256": digest(arguments["--expected-profile-arn"]),
    },
    "positive": {"prefixListAuthorized": True},
    "revoked": {
        "credentialIssuanceDenied": True,
        "localCrlRevocationVerified": True,
    },
    "credentialsPersisted": False,
    "longLivedCredentialsAccepted": False,
}
body = json.dumps(evidence, separators=(",", ":"), sort_keys=True) + "\\n"
output = Path(arguments["--output"])
output.write_text(body)
output.chmod(0o600)
print(json.dumps({
    "ok": True,
    "schemaVersion": evidence["schemaVersion"],
    "status": "passed",
    "evidenceSha256": hashlib.sha256(body.encode()).hexdigest(),
}, separators=(",", ":"), sort_keys=True))
`;
    writeTrusted(probe, probeSource, 0o700);
    const probeArgsPath = path.join(privateDir, 'probe-arguments.json');
    const probeArgs = [
      '--positive-config', path.join(privateDir, 'positive-config'),
      '--positive-profile', 'positive',
      '--revoked-config', path.join(privateDir, 'revoked-config'),
      '--revoked-profile', 'revoked',
      '--region', region,
      '--expected-role-arn', backupRoleArn,
      '--expected-trust-anchor-arn', trustAnchorArn,
      '--expected-profile-arn', backupProfileArn,
      '--expected-bucket', bucket,
      '--expected-prefix', prefix,
      '--expected-positive-certificate-sha256', 'b'.repeat(64),
      '--expected-revoked-certificate-sha256', 'c'.repeat(64),
      '--ca-certificate', path.join(privateDir, 'ca.pem'),
      '--crl', path.join(privateDir, 'revocation.crl'),
      '--live-crl-evidence', crlEvidence,
      '--aws-bin', realAws,
      '--openssl-bin', path.join(versioned, 'openssl'),
      '--python-bin', systemPython,
      '--boundary-helper', path.join(versioned, 'boundary-helper'),
      '--signing-helper', path.join(versioned, 'signing-helper'),
      '--signing-helper-sha256', 'd'.repeat(64),
      '--output', probeEvidence,
      '--expected-owner-uid', String(process.getuid?.() ?? 0),
      '--trust-boundary', root,
    ];
    const probeArgsBody = `${JSON.stringify(probeArgs)}\n`;
    writeTrusted(probeArgsPath, probeArgsBody, 0o600);
    commonArgs.push(
      '--post-enable-crl-verifier-bin', crlVerifier,
      '--post-enable-crl-verifier-bin-sha256', digest(crlVerifierSource),
      '--post-enable-crl-verifier-arguments', crlArgsPath,
      '--post-enable-crl-verifier-arguments-sha256', digest(crlArgsBody),
      '--post-enable-crl-evidence', crlEvidence,
      '--post-enable-probe-bin', probe,
      '--post-enable-probe-bin-sha256', digest(probeSource),
      '--post-enable-probe-arguments', probeArgsPath,
      '--post-enable-probe-arguments-sha256', digest(probeArgsBody),
      '--post-enable-probe-evidence', probeEvidence,
      '--poll-interval-seconds', '1',
      '--alarm-prime-timeout-seconds', '60',
    );
  }
  return {
    root,
    transition,
    aws,
    state,
    commandLog,
    reviewReceipt,
    evidence,
    journal,
    crlEvidence: transition === 'roles-anywhere' ? crlEvidence : undefined,
    probeEvidence: transition === 'roles-anywhere'
      ? probeEvidence
      : undefined,
    commonArgs,
  };
}

function runController(
  fixture: Fixture,
  operation: 'inspect' | 'execute' | 'recover-or-finalize',
  reviewDigest?: string,
) {
  if (!systemPython) throw new Error('Python 3 is required');
  const args = [
    ...fixture.commonArgs,
    '--operation', operation,
  ];
  if (operation !== 'inspect') {
    args.push(
      '--review-receipt-sha256', reviewDigest ?? '',
      '--evidence-out', fixture.evidence,
    );
    if (operation === 'execute') args.push('--execute-reviewed-change-set');
  }
  return spawnSync(systemPython, args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      AWS_ACCESS_KEY_ID: 'must-not-reach-child',
      AWS_SECRET_ACCESS_KEY: 'must-not-reach-child',
      AWS_ENDPOINT_URL: 'https://attacker.invalid',
      AWS_ENDPOINT_URL_CLOUDFORMATION: 'https://attacker.invalid',
      HTTPS_PROXY: 'https://attacker.invalid',
      AWS_CA_BUNDLE: '/attacker/ca.pem',
      PYTHONPATH: '/attacker/python',
      DYLD_LIBRARY_PATH: '/attacker/library',
    },
  });
}

function commands(fixture: Fixture) {
  if (!fs.existsSync(fixture.commandLog)) return [];
  return fs.readFileSync(fixture.commandLog, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe.runIf(systemPython !== undefined)(
  'application DR CloudFormation activation controller',
  () => {
    it('separates review from execution and activates exact disabled Roles Anywhere resources', () => {
      const fixture = makeFixture('roles-anywhere');
      try {
        expect(fs.lstatSync(fixture.aws).isSymbolicLink()).toBe(true);
        const inspected = runController(fixture, 'inspect');
        expect(
          inspected.status,
          `${inspected.stdout}\n${inspected.stderr}`,
        ).toBe(0);
        expect(JSON.parse(inspected.stdout)).toMatchObject({
          ok: true,
          operation: 'inspect',
        });
        const review = JSON.parse(
          fs.readFileSync(fixture.reviewReceipt, 'utf8'),
        );
        expect(review.activationControl).toMatchObject({
          alarmWindowSeconds: 720,
          maxAwsCommandSeconds: 30,
          maxValidatedAwsCallsBetweenRenewals: 7,
          maxValidatedAwsChunkSeconds: 210,
          maxExternalVerifierChunkSeconds: 300,
          minimumSafetyMarginSeconds: 420,
        });
        expect(
          review.activationControl.alarmWindowSeconds
          - Math.max(
            review.activationControl.maxValidatedAwsChunkSeconds,
            review.activationControl.maxExternalVerifierChunkSeconds,
          ),
        ).toBeGreaterThanOrEqual(120);
        expect(fs.statSync(fixture.reviewReceipt).mode & 0o777).toBe(0o600);
        expect(JSON.parse(fs.readFileSync(fixture.state, 'utf8')).phase)
          .toBe('current');
        expect(commands(fixture).some((entry) => (
          entry.arguments[0] === 'cloudformation'
          && entry.arguments[1] === 'execute-change-set'
        ))).toBe(false);

        const reviewDigest = digest(fs.readFileSync(fixture.reviewReceipt));
        const executed = runController(fixture, 'execute', reviewDigest);
        expect(
          executed.status,
          `${executed.stdout}\n${executed.stderr}`,
        ).toBe(0);
        expect(JSON.parse(executed.stdout)).toMatchObject({
          ok: true,
          operation: 'execute',
        });
        expect(JSON.parse(fs.readFileSync(fixture.evidence, 'utf8')))
          .toMatchObject({
            status: 'passed',
            transition: 'roles-anywhere',
            reviewReceiptSha256: reviewDigest,
            credentialsPersisted: false,
            rawAwsResponsesPersisted: false,
          });
        expect(JSON.parse(fs.readFileSync(fixture.state, 'utf8')).phase)
          .toBe('final');
        const commandNames = commands(fixture).map((entry) => (
          `${entry.arguments[0]} ${entry.arguments[1]}`
        ));
        expect(commandNames.indexOf('cloudwatch put-metric-data')).toBeLessThan(
          commandNames.indexOf('cloudformation execute-change-set'),
        );
        expect(JSON.parse(fs.readFileSync(fixture.journal!, 'utf8')).phase)
          .toBe('passed');
        for (const entry of commands(fixture)) {
          expect(entry.unsafeEnvironment).toEqual([]);
          expect(entry.configuredEndpointIgnored).toBe('true');
          expect(entry.profile).toBe('nexus-application-dr-activation');
        }
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('runs the independent lifecycle transition only with the exact bootstrap receipt', () => {
      const fixture = makeFixture('lifecycle');
      try {
        const inspected = runController(fixture, 'inspect');
        expect(
          inspected.status,
          `${inspected.stdout}\n${inspected.stderr}`,
        ).toBe(0);
        const receipt = JSON.parse(
          fs.readFileSync(fixture.reviewReceipt, 'utf8'),
        );
        expect(receipt).toMatchObject({
          transition: 'lifecycle',
          status: 'ready-for-owner-approval',
        });
        expect(receipt.bootstrapReceiptSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(receipt.current.stackControlsSha256)
          .toMatch(/^[0-9a-f]{64}$/);

        const reviewDigest = digest(fs.readFileSync(fixture.reviewReceipt));
        const executed = runController(fixture, 'execute', reviewDigest);
        expect(
          executed.status,
          `${executed.stdout}\n${executed.stderr}`,
        ).toBe(0);
        expect(JSON.parse(fs.readFileSync(fixture.evidence, 'utf8')))
          .toMatchObject({
            status: 'passed',
            transition: 'lifecycle',
            bootstrapReceiptSha256: receipt.bootstrapReceiptSha256,
          });
        expect(JSON.parse(fs.readFileSync(fixture.journal, 'utf8')).phase)
          .toBe('passed');
        expect(commands(fixture).some((entry) => (
          entry.arguments.slice(0, 3).join(' ')
          === 'cloudformation wait stack-update-complete'
        ))).toBe(false);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('refuses execution when the owner-approved review receipt bytes change', () => {
      const fixture = makeFixture('roles-anywhere');
      try {
        const inspected = runController(fixture, 'inspect');
        expect(inspected.status, inspected.stderr).toBe(0);
        const approved = digest(fs.readFileSync(fixture.reviewReceipt));
        fs.appendFileSync(fixture.reviewReceipt, ' ');
        const executed = runController(fixture, 'execute', approved);
        expect(executed.status).not.toBe(0);
        expect(executed.stderr).toContain(
          'review receipt differs from the owner-approved SHA-256',
        );
        expect(JSON.parse(fs.readFileSync(fixture.state, 'utf8')).phase)
          .toBe('current');
        expect(fs.existsSync(fixture.evidence)).toBe(false);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('rejects an owner-reviewed change set containing any extra resource change', () => {
      const fixture = makeFixture('roles-anywhere', { extraChange: true });
      try {
        const inspected = runController(fixture, 'inspect');
        expect(inspected.status).not.toBe(0);
        expect(inspected.stderr).toContain(
          'resource changes exceed the exact allowlist',
        );
        expect(fs.existsSync(fixture.reviewReceipt)).toBe(false);
        expect(commands(fixture).some((entry) => (
          entry.arguments[1] === 'execute-change-set'
        ))).toBe(false);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('rejects every stack-level control drift outside the activation transition', () => {
      const cases = [
        ['notification', 'stack-level notificationArns control'],
        ['rollback', 'rollback configuration is not the exact activation control'],
        ['tags', 'stack-level tags control'],
        ['execution-role', 'stack execution role'],
        ['import', 'must not import existing resources'],
        ['deployment', 'standard rollback-enabled deployment'],
      ] as const;
      for (const [stackLevelDrift, expectedMessage] of cases) {
        const fixture = makeFixture('roles-anywhere', { stackLevelDrift });
        try {
          const inspected = runController(fixture, 'inspect');
          expect(
            inspected.status,
            `${stackLevelDrift}\n${inspected.stdout}\n${inspected.stderr}`,
          ).not.toBe(0);
          expect(inspected.stderr).toContain(expectedMessage);
          expect(fs.existsSync(fixture.reviewReceipt)).toBe(false);
          expect(commands(fixture).some((entry) => (
            entry.arguments[1] === 'execute-change-set'
          ))).toBe(false);
        } finally {
          fs.rmSync(fixture.root, { recursive: true, force: true });
        }
      }
    });

    it('fails closed when current stack parameters drift during inspection', () => {
      const fixture = makeFixture('roles-anywhere', {
        driftOnSecondDescribe: true,
      });
      try {
        const inspected = runController(fixture, 'inspect');
        expect(inspected.status).not.toBe(0);
        expect(inspected.stderr).toContain(
          'stack parameter LifecycleActivation does not match',
        );
        expect(fs.existsSync(fixture.reviewReceipt)).toBe(false);
        expect(JSON.parse(fs.readFileSync(fixture.state, 'utf8')).phase)
          .toBe('current');
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('does not emit pass evidence when post-execution live state is not enabled', () => {
      const fixture = makeFixture('roles-anywhere', {
        finalControlMismatch: true,
      });
      try {
        const inspected = runController(fixture, 'inspect');
        expect(inspected.status, inspected.stderr).toBe(0);
        const executed = runController(
          fixture,
          'execute',
          digest(fs.readFileSync(fixture.reviewReceipt)),
        );
        expect(executed.status).not.toBe(0);
        expect(executed.stderr).toContain(
          'completed without the exact enabled identity plane',
        );
        expect(JSON.parse(fs.readFileSync(fixture.state, 'utf8')).phase)
          .toBe('final');
        expect(fs.existsSync(fixture.evidence)).toBe(false);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('does not emit pass evidence when a stack-level control drifts during execution', () => {
      const fixture = makeFixture('roles-anywhere', {
        finalStackControlMismatch: true,
      });
      try {
        const inspected = runController(fixture, 'inspect');
        expect(inspected.status, inspected.stderr).toBe(0);
        const executed = runController(
          fixture,
          'execute',
          digest(fs.readFileSync(fixture.reviewReceipt)),
        );
        expect(executed.status).not.toBe(0);
        expect(executed.stderr).toContain(
          'enabled stack-level controls differ from the reviewed current stack',
        );
        expect(JSON.parse(fs.readFileSync(fixture.state, 'utf8')).phase)
          .toBe('final');
        expect(fs.existsSync(fixture.evidence)).toBe(false);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('requires the static lease alarm to age to ALARM before review', () => {
      const fixture = makeFixture('roles-anywhere', {
        alarmInitiallyOk: true,
      });
      try {
        const inspected = runController(fixture, 'inspect');
        expect(inspected.status).not.toBe(0);
        expect(inspected.stderr).toContain(
          'must age to ALARM before inspection or execution',
        );
        expect(fs.existsSync(fixture.reviewReceipt)).toBe(false);
        expect(commands(fixture).some((entry) => (
          entry.arguments[1] === 'put-metric-data'
        ))).toBe(false);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('resumes an accepted exact activation from its durable journal', () => {
      const fixture = makeFixture('roles-anywhere', {
        failDescribeAfterExecuteOnce: true,
      });
      try {
        const inspected = runController(fixture, 'inspect');
        expect(inspected.status, inspected.stderr).toBe(0);
        const reviewDigest = digest(fs.readFileSync(fixture.reviewReceipt));
        const interrupted = runController(fixture, 'execute', reviewDigest);
        expect(interrupted.status).not.toBe(0);
        expect(JSON.parse(fs.readFileSync(fixture.journal!, 'utf8')).phase)
          .toBe('change-set-accepted');
        expect(fs.existsSync(fixture.evidence)).toBe(false);

        const recovered = runController(
          fixture,
          'recover-or-finalize',
          reviewDigest,
        );
        expect(
          recovered.status,
          `${recovered.stdout}\n${recovered.stderr}`,
        ).toBe(0);
        expect(JSON.parse(recovered.stdout)).toMatchObject({
          ok: true,
          operation: 'recover-or-finalize',
          status: 'passed',
        });
        expect(JSON.parse(fs.readFileSync(fixture.journal!, 'utf8')).phase)
          .toBe('passed');
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('recovers an accepted lifecycle transition from its durable journal', () => {
      const fixture = makeFixture('lifecycle', {
        failDescribeAfterExecuteOnce: true,
      });
      try {
        const inspected = runController(fixture, 'inspect');
        expect(inspected.status, inspected.stderr).toBe(0);
        const reviewDigest = digest(fs.readFileSync(fixture.reviewReceipt));
        const interrupted = runController(fixture, 'execute', reviewDigest);
        expect(interrupted.status).not.toBe(0);
        expect(JSON.parse(fs.readFileSync(fixture.journal, 'utf8')).phase)
          .toBe('change-set-accepted');
        expect(fs.existsSync(fixture.evidence)).toBe(false);

        const recovered = runController(
          fixture,
          'recover-or-finalize',
          reviewDigest,
        );
        expect(
          recovered.status,
          `${recovered.stdout}\n${recovered.stderr}`,
        ).toBe(0);
        expect(JSON.parse(recovered.stdout)).toMatchObject({
          ok: true,
          operation: 'recover-or-finalize',
          status: 'passed',
        });
        expect(JSON.parse(fs.readFileSync(fixture.journal, 'utf8')).phase)
          .toBe('passed');
        expect(commands(fixture).filter((entry) => (
          entry.arguments.slice(0, 2).join(' ')
          === 'cloudformation execute-change-set'
        ))).toHaveLength(1);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('recovers a lifecycle transition after losing the execute response without re-executing', () => {
      const fixture = makeFixture('lifecycle', {
        failExecuteResponseOnce: true,
      });
      try {
        const inspected = runController(fixture, 'inspect');
        expect(inspected.status, inspected.stderr).toBe(0);
        const reviewDigest = digest(fs.readFileSync(fixture.reviewReceipt));
        const interrupted = runController(fixture, 'execute', reviewDigest);
        expect(interrupted.status).not.toBe(0);
        expect(JSON.parse(fs.readFileSync(fixture.journal, 'utf8')).phase)
          .toBe('execution-attempted');

        const recovered = runController(
          fixture,
          'recover-or-finalize',
          reviewDigest,
        );
        expect(
          recovered.status,
          `${recovered.stdout}\n${recovered.stderr}`,
        ).toBe(0);
        expect(JSON.parse(fs.readFileSync(fixture.journal, 'utf8')).phase)
          .toBe('passed');
        expect(commands(fixture).filter((entry) => (
          entry.arguments.slice(0, 2).join(' ')
          === 'cloudformation execute-change-set'
        ))).toHaveLength(1);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('records lifecycle rollback evidence and retains the exact predecessor', () => {
      const fixture = makeFixture('lifecycle', {
        rollbackOnExecute: true,
      });
      try {
        const inspected = runController(fixture, 'inspect');
        expect(inspected.status, inspected.stderr).toBe(0);
        const executed = runController(
          fixture,
          'execute',
          digest(fs.readFileSync(fixture.reviewReceipt)),
        );
        expect(executed.status).not.toBe(0);
        expect(executed.stderr).toContain('reviewed activation rolled back');
        expect(JSON.parse(fs.readFileSync(fixture.evidence, 'utf8')))
          .toMatchObject({
            status: 'rolled-back',
            transition: 'lifecycle',
          });
        expect(JSON.parse(fs.readFileSync(fixture.journal, 'utf8')).phase)
          .toBe('rolled-back');
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('records rollback evidence and never emits a passing activation', () => {
      const fixture = makeFixture('roles-anywhere', {
        rollbackOnExecute: true,
      });
      try {
        const inspected = runController(fixture, 'inspect');
        expect(inspected.status, inspected.stderr).toBe(0);
        const executed = runController(
          fixture,
          'execute',
          digest(fs.readFileSync(fixture.reviewReceipt)),
        );
        expect(executed.status).not.toBe(0);
        expect(executed.stderr).toContain('reviewed activation rolled back');
        expect(JSON.parse(fs.readFileSync(fixture.evidence, 'utf8')))
          .toMatchObject({
            status: 'rolled-back',
            transition: 'roles-anywhere',
          });
        expect(JSON.parse(fs.readFileSync(fixture.journal!, 'utf8')).phase)
          .toBe('rolled-back');
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('persists complete activation journals across repeated short writes', () => {
      const root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-dr-short-journal-')),
      );
      fs.chmodSync(root, 0o700);
      try {
        const harness = `
import importlib.util
import json
import os
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location("controller", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
root = Path(sys.argv[2])
journal = root / "journal.json"
original_write = module.os.write
calls = 0

def short_write(descriptor, body):
    global calls
    calls += 1
    return original_write(descriptor, body[:3])

module.os.write = short_write
payload = {
    "schemaVersion": module.JOURNAL_SCHEMA,
    "phase": "prepared",
    "padding": "x" * 256,
}
module.write_journal(
    journal,
    payload,
    owner_uid=os.getuid(),
    boundary=root,
    create=True,
)
observed = json.loads(journal.read_text())
if observed != payload or calls <= 1:
    raise SystemExit("short-write journal persistence was incomplete")
print(json.dumps({"calls": calls, "complete": True}))
`;
        const result = spawnSync(
          systemPython!,
          ['-c', harness, controller, root],
          { encoding: 'utf8' },
        );
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          complete: true,
        });
        expect(JSON.parse(result.stdout).calls).toBeGreaterThan(1);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  },
);
