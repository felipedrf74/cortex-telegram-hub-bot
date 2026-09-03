// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/** Stable compatibility facade; scoped modules own all Decision Center logic. */
export * from './decision-center/proposal-service';
export * from './decision-center/read-projection-ranking-service';
export * from './decision-center/command-service';
export * from './decision-center/command-response-receipts';
export * from './decision-center/lifecycle-preferences-jobs';
export {
  DECISION_MUTATION_COMMAND_SCHEMA_VERSION, DECISION_COMMAND_RECEIPT_SCHEMA_VERSION,
  createDecisionMutationCommand, type DecisionScope, type DecisionClock, type DecisionIsoWeek,
  type DecisionPlanningContext, type DecisionMutationChannel, type DecisionMutationOperation,
  type DecisionCommandReceiptStatus, type DecisionCommandReceiptReadbackItem,
  type DecisionCommandReceiptVerification, type DecisionCommandReceipt, type DecisionApprovalEvidence,
  type DecisionMutationApproval, type DecisionMutationExecution, type DecisionMutationReadback,
  type DecisionMutationCommand, type DecisionMutationCommandInput,
} from './decision-center/contracts';
export * from './decision-center/types';
export * from './decision-center/repository';
export * from './decision-center/repository-readiness';
