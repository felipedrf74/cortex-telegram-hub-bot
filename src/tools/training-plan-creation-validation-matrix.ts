// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  buildTrainingPlanCreationQualityMatrix,
  buildTrainingPlanCreationValidationMatrix,
  TRAINING_PLAN_CREATION_LOCAL_SIMULATOR_ACCOUNT_EMAIL,
  TRAINING_PLAN_SCIENCE_EVIDENCE_BASELINE,
} from '../services/training-plan-creation-validation';

interface CliSummary {
  matrix: ReturnType<typeof buildTrainingPlanCreationValidationMatrix>;
  qualityMatrix: ReturnType<typeof buildTrainingPlanCreationQualityMatrix>;
  scienceEvidenceBaseline: typeof TRAINING_PLAN_SCIENCE_EVIDENCE_BASELINE;
  authorizationRequired: boolean;
  productionWritesForbiddenByDefault: boolean;
  localSimulatorAccountEmail: string;
}

function main(): void {
  const qaAccountArg = process.argv.find((arg) => arg.startsWith('--qa-account='));
  const qaAccountEmail = qaAccountArg?.split('=')[1]?.trim() || undefined;
  const summary: CliSummary = {
    matrix: buildTrainingPlanCreationValidationMatrix(qaAccountEmail),
    qualityMatrix: buildTrainingPlanCreationQualityMatrix({ qaAccountEmail }),
    scienceEvidenceBaseline: TRAINING_PLAN_SCIENCE_EVIDENCE_BASELINE,
    authorizationRequired: true,
    productionWritesForbiddenByDefault: true,
    localSimulatorAccountEmail: TRAINING_PLAN_CREATION_LOCAL_SIMULATOR_ACCOUNT_EMAIL,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (require.main === module) {
  main();
}
