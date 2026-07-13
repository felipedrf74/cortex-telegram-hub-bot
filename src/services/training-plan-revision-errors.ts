// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export class TrainingPlanRevisionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'TrainingPlanRevisionError';
  }
}
