// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Default-OFF release boundary for the additive local-primary subsystem.
 * Keeping these controls isolated prevents an inference feature from changing
 * the canonical production/maintenance configuration contract. Durable
 * admission still requires the audited database runtime-control row.
 */
function emergencyBoolean(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/iu.test(String(value ?? '').trim());
}

export const localPrimaryInferenceConfig = Object.freeze({
  contentProxyEnabled: process.env.LOCAL_PRIMARY_CONTENT_PROXY_ENABLED === 'true',
  chatEnabled: process.env.LOCAL_PRIMARY_CHAT_ENABLED === 'true',
  contentSpecialistsEnabled: process.env.LOCAL_PRIMARY_CONTENT_SPECIALISTS_ENABLED === 'true',
  autoRollbackEnabled: process.env.LOCAL_PRIMARY_AUTO_ROLLBACK_ENABLED === 'true',
  scriptJobsEnabled: process.env.LOCAL_PRIMARY_SCRIPT_JOBS_ENABLED === 'true',
  scriptJobsCloudPrimaryEnabled:
    process.env.CONTENT_SCRIPT_JOBS_CLOUD_PRIMARY_ENABLED === 'true',
  // Script jobs are OpenAI-primary under the locked delivery contract. Keep
  // owner/staff acceptance independently available before this public gate is
  // opened; local-model rollout state must not decide cloud-script admission.
  scriptJobsPublicEnabled: process.env.CONTENT_SCRIPT_JOBS_PUBLIC_ENABLED === 'true',
  // The attended kill switch accepts conventional affirmative spellings so
  // an operator cannot accidentally leave inference active with `TRUE` or `1`.
  hardKill: emergencyBoolean(process.env.LOCAL_PRIMARY_LLM_HARD_KILL),
  scriptJobEncryptionKey: String(process.env.CONTENT_SCRIPT_JOB_ENCRYPTION_KEY || '').trim(),
  scriptJobPreviousEncryptionKeys: Object.freeze(
    String(process.env.CONTENT_SCRIPT_JOB_PREVIOUS_ENCRYPTION_KEYS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  ),
  gatewaySocketPath: String(process.env.OLLAMA_GATEWAY_SOCKET_PATH || '').trim(),
  // Production active/100% admission resolves this server-selected private
  // artifact and requires the owner request to pin its exact byte digest.
  activationEvidencePath: String(
    process.env.LOCAL_PRIMARY_ACTIVATION_EVIDENCE_PATH || '',
  ).trim(),
  activationEvidenceHmacSecret: String(
    process.env.LOCAL_PRIMARY_ACTIVATION_EVIDENCE_HMAC_SECRET || '',
  ),
  staffUserIds: Object.freeze(
    String(process.env.LOCAL_PRIMARY_STAFF_USER_IDS || '')
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isSafeInteger(value) && value > 0),
  ),
  maxContextTokens: 16_384,
  maxOutputTokens: 6_144,
  waitingQueueDepth: 4,
});
