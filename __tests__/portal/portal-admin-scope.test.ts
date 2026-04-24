import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const serverPath = path.resolve(__dirname, '../../src/portal/server.ts');
const adminDataRoutesPath = path.resolve(__dirname, '../../src/portal/admin-data-routes.ts');
const skillRoutesPath = path.resolve(__dirname, '../../src/portal/skill-routes.ts');
const contentRoutesPath = path.resolve(__dirname, '../../src/portal/content-routes.ts');
const founderRoutesPath = path.resolve(__dirname, '../../src/portal/founder-routes.ts');
const intelligenceRoutesPath = path.resolve(__dirname, '../../src/portal/intelligence-routes.ts');
const inviteRoutesPath = path.resolve(__dirname, '../../src/portal/invite-routes.ts');
const planRoutesPath = path.resolve(__dirname, '../../src/portal/plan-routes.ts');
const providerRoutesPath = path.resolve(__dirname, '../../src/portal/provider-routes.ts');
const webhookRoutesPath = path.resolve(__dirname, '../../src/portal/webhook-routes.ts');
const actionRoutesPath = path.resolve(__dirname, '../../src/portal/action-routes.ts');
const settingsRoutesPath = path.resolve(__dirname, '../../src/portal/settings-routes.ts');
const userSkillRoutesPath = path.resolve(__dirname, '../../src/portal/user-skill-routes.ts');
const userRoutesPath = path.resolve(__dirname, '../../src/portal/user-routes.ts');
const waitlistRoutesPath = path.resolve(__dirname, '../../src/portal/waitlist-routes.ts');
const operationsRoutesPath = path.resolve(__dirname, '../../src/portal/operations-routes.ts');
const serverSource = fs.readFileSync(serverPath, 'utf8');
const portalRouteSource = [
  serverSource,
  fs.readFileSync(adminDataRoutesPath, 'utf8'),
  fs.readFileSync(actionRoutesPath, 'utf8'),
  fs.readFileSync(settingsRoutesPath, 'utf8'),
  fs.readFileSync(userSkillRoutesPath, 'utf8'),
  fs.readFileSync(skillRoutesPath, 'utf8'),
  fs.readFileSync(contentRoutesPath, 'utf8'),
  fs.readFileSync(founderRoutesPath, 'utf8'),
  fs.readFileSync(intelligenceRoutesPath, 'utf8'),
  fs.readFileSync(inviteRoutesPath, 'utf8'),
  fs.readFileSync(planRoutesPath, 'utf8'),
  fs.readFileSync(providerRoutesPath, 'utf8'),
  fs.readFileSync(webhookRoutesPath, 'utf8'),
  fs.readFileSync(userRoutesPath, 'utf8'),
  fs.readFileSync(waitlistRoutesPath, 'utf8'),
  fs.readFileSync(operationsRoutesPath, 'utf8'),
].join('\n');

describe('portal admin scope hardening', () => {
  it('protects founder management routes with the admin token middleware', () => {
    expect(portalRouteSource).toContain("app.get('/api/founders', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.post('/api/founders', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.delete('/api/founders/:email', requirePortalAdminToken");
  });

  it('protects plan and waitlist admin routes with the admin token middleware', () => {
    expect(portalRouteSource).toContain("app.get('/api/plans', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.put('/api/plans/:planId', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.get('/api/waitlist', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.post('/api/waitlist/:id/approve', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.post('/api/waitlist/:id/reject', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.post('/api/waitlist/:id/invited', requirePortalAdminToken");
  });

  it('protects sensitive user and invite mutations with the admin token middleware', () => {
    expect(portalRouteSource).toContain("app.post('/api/users/:userId/suspend', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.post('/api/users/:userId/activate', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.put('/api/users/:userId/tier', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.put('/api/users/:userId/limits', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.post('/api/invite-codes', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.delete('/api/invite-codes/:code', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.put('/api/users/:userId/skills', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.post('/api/users/:userId/skills/reset', requirePortalAdminToken");
  });

  it('protects sensitive audit and user data-summary reads with the admin token middleware', () => {
    expect(portalRouteSource).toContain("app.get('/api/audit-trail', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.get('/api/users/:userId/data-summary', requirePortalAdminToken");
  });

  it('protects portal operational mutations with the admin token middleware', () => {
    expect(portalRouteSource).toContain("app.post('/api/skills/toggle', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.post('/api/domain-routing/toggle', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.put('/api/model-config', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.delete('/api/model-config', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.post('/api/channels', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.delete('/api/channels/:id', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.post('/api/action/:name', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.post('/api/signals/:id/dismiss', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.post('/api/books', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.post('/api/override/sprint', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.post('/api/skills/:name/enable', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.post('/api/skills/:name/disable', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.post('/api/skills/:name/subskills/:sub/enable', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.post('/api/skills/:name/subskills/:sub/disable', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.post('/api/webhooks/subscriptions', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.delete('/api/webhooks/subscriptions/:id', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.post('/api/webhooks/events/:id/replay', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.put('/api/settings', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.delete('/api/settings', requirePortalAdminToken");
  });

  it('sanitizes founder and plan 500 responses through the shared portal helper', () => {
    expect(portalRouteSource).toContain("sendPortalInternalError(res, err, 'Failed to load plan configuration'");
    expect(portalRouteSource).toContain("sendPortalInternalError(res, err, 'Failed to update plan configuration'");
    expect(portalRouteSource).toContain("sendPortalInternalError(res, err, 'Failed to load founders'");
    expect(portalRouteSource).toContain("sendPortalInternalError(res, err, 'Failed to save founder'");
    expect(portalRouteSource).toContain("sendPortalInternalError(res, err, 'Failed to remove founder'");
  });

  it('records portal admin mutations through the shared audit helper', () => {
    expect(portalRouteSource).toContain("logPortalAdminMutation(req, userId, 'user.status'");
    expect(portalRouteSource).toContain("logPortalAdminMutation(req, userId, 'user.tier'");
    expect(portalRouteSource).toContain("logPortalAdminMutation(req, userId, 'user.limits'");
    expect(portalRouteSource).toContain("logPortalAdminMutation(req, 0, 'invite_code.create'");
    expect(portalRouteSource).toContain("logPortalAdminMutation(req, 0, 'invite_code.delete'");
    expect(portalRouteSource).toContain("logPortalAdminMutation(req, 0, 'plan_config.update'");
    expect(portalRouteSource).toContain("logPortalAdminMutation(req, 0, 'founder.add'");
    expect(portalRouteSource).toContain("logPortalAdminMutation(req, 0, 'waitlist.approve'");
    expect(portalRouteSource).toContain("logPortalAdminMutation(req, userId, 'user.skills.update'");
    expect(portalRouteSource).toContain("logPortalAdminMutation(req, 0, 'settings.update'");
  });

  // Gap 5: operator alert lifecycle mutations now flow through the portal
  // admin token guard and the admin audit layer. Previously they required
  // only the method-based write scope and wrote actor metadata directly to
  // the alert row, leaving the audit_trail blind to the operator identity.
  it('protects operator-alert lifecycle mutations with the admin token middleware', () => {
    expect(portalRouteSource).toContain("app.post('/api/operator-alerts/:id/ack', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.post('/api/operator-alerts/:id/resolve', requirePortalAdminToken");
    expect(portalRouteSource).toContain("app.post('/api/operator-alerts/:id/retry-delivery', requirePortalAdminToken");
  });

  it('captures operator-alert lifecycle mutations in the admin audit trail', () => {
    expect(portalRouteSource).toContain("logPortalAdminMutation(req, 0, 'operator_alert.ack'");
    expect(portalRouteSource).toContain("logPortalAdminMutation(req, 0, 'operator_alert.resolve'");
    expect(portalRouteSource).toContain("logPortalAdminMutation(req, 0, 'operator_alert.retry_delivery'");
  });

  // Gap 5: admin routes that accept :userId now chain the operator target-user
  // guard after the admin token guard so we consistently validate existence
  // and (when configured) per-operator scope before mutating user data.
  it('chains the operator target-user guard on every :userId admin route', () => {
    expect(portalRouteSource).toContain("app.post('/api/users/:userId/suspend', requirePortalAdminToken, requireOperatorTargetUser('userId')");
    expect(portalRouteSource).toContain("app.post('/api/users/:userId/activate', requirePortalAdminToken, requireOperatorTargetUser('userId')");
    expect(portalRouteSource).toContain("app.put('/api/users/:userId/tier', requirePortalAdminToken, requireOperatorTargetUser('userId')");
    expect(portalRouteSource).toContain("app.put('/api/users/:userId/limits', requirePortalAdminToken, requireOperatorTargetUser('userId')");
    expect(portalRouteSource).toContain("app.put('/api/users/:userId/skills', requirePortalAdminToken, requireOperatorTargetUser('userId')");
    expect(portalRouteSource).toContain("app.post('/api/users/:userId/skills/reset', requirePortalAdminToken, requireOperatorTargetUser('userId')");
    expect(portalRouteSource).toContain("app.get('/api/users/:userId/data-summary', requirePortalAdminToken, requireOperatorTargetUser('userId')");
  });

  // Gap 5: the server composition root must call the beta-readiness preflight
  // so unsafe admin exposure is detected at startup, not first-request time.
  it('wires the portal admin beta readiness preflight into the portal server boot path', () => {
    expect(serverSource).toContain('validatePortalAdminBetaReadiness(config.portal)');
  });
});
