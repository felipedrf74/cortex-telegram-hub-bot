// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router } from 'express';
import { sendSuccess } from '../response-helpers';
import { getCurrentLegalMetadata } from '../../services/legal-consent';

export function legalRoutes(): Router {
  const router = Router();

  router.get('/current', (_req, res) => {
    sendSuccess(res, getCurrentLegalMetadata());
  });

  router.get('/terms', (_req, res) => {
    res.redirect(302, getCurrentLegalMetadata().documents.terms.url);
  });

  router.get('/privacy', (_req, res) => {
    res.redirect(302, getCurrentLegalMetadata().documents.privacy.url);
  });

  return router;
}
