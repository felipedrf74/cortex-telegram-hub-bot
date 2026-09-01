// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Compatibility facade for released route and test imports. The generation
 * pipeline is owned by the service layer; authenticated routes only map DTOs
 * and call its tenant-scoped public contract.
 */
export * from '../../services/training-plan-generation-pipeline';
