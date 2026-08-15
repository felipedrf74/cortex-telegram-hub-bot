// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import { localPrimaryInferenceConfig } from './local-primary-config';

export function isLocalInferenceUserEnrolled(userId: number, percent: number): boolean {
  if (localPrimaryInferenceConfig.staffUserIds.includes(userId)) return true;
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  const digest = crypto.createHash('sha256').update(`local-primary-v1:${userId}`).digest();
  return digest.readUInt32BE(0) % 100 < percent;
}
