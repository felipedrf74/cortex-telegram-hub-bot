// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import net from 'net';

export interface ExternalUrlPolicy {
  allowedHosts?: string[];
  allowedHostSuffixes?: string[];
  allowHttpLocalhost?: boolean;
}

const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
]);

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0;
}

function isPrivateIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  const firstHextet = Number.parseInt(normalized.split(':', 1)[0] || '0', 16);
  return normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    (Number.isInteger(firstHextet) && (firstHextet & 0xfe00) === 0xfc00) ||
    (Number.isInteger(firstHextet) && firstHextet >= 0xfe80 && firstHextet <= 0xfebf) ||
    normalized === '::' ||
    normalized === '0:0:0:0:0:0:0:0' ||
    normalized.startsWith('::ffff:');
}

function normalizeHostname(hostname: string): string {
  const withoutTrailingDot = hostname.replace(/\.$/, '');
  return withoutTrailingDot.startsWith('[') && withoutTrailingDot.endsWith(']')
    ? withoutTrailingDot.slice(1, -1).toLowerCase()
    : withoutTrailingDot.toLowerCase();
}

function isHostAllowed(host: string, policy: ExternalUrlPolicy): boolean {
  const normalized = normalizeHostname(host);
  if (policy.allowedHosts?.some((allowed) => normalizeHostname(allowed) === normalized)) {
    return true;
  }
  return policy.allowedHostSuffixes?.some((suffix) => {
    const normalizedSuffix = normalizeHostname(suffix).replace(/^\./, '');
    return normalized === normalizedSuffix || normalized.endsWith(`.${normalizedSuffix}`);
  }) ?? false;
}

export function assertSafeExternalUrl(rawUrl: string, policy: ExternalUrlPolicy = {}): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }

  const protocol = parsed.protocol.toLowerCase();
  const hostname = normalizeHostname(parsed.hostname);
  if (parsed.username || parsed.password) {
    throw new Error('URL credentials are not allowed');
  }
  if (protocol !== 'https:' && !(policy.allowHttpLocalhost && protocol === 'http:' && hostname === '127.0.0.1')) {
    throw new Error('Only HTTPS URLs are allowed');
  }
  if (BLOCKED_HOSTS.has(hostname)) {
    throw new Error('Localhost and metadata hosts are not allowed');
  }
  if (net.isIP(hostname) === 4 && isPrivateIpv4(hostname)) {
    throw new Error('Private IPv4 ranges are not allowed');
  }
  if (net.isIP(hostname) === 6 && isPrivateIpv6(hostname)) {
    throw new Error('Private IPv6 ranges are not allowed');
  }
  if ((policy.allowedHosts?.length || policy.allowedHostSuffixes?.length) && !isHostAllowed(hostname, policy)) {
    throw new Error('URL host is not allowlisted');
  }

  return parsed;
}

export function isSafeExternalUrl(rawUrl: string, policy: ExternalUrlPolicy = {}): boolean {
  try {
    assertSafeExternalUrl(rawUrl, policy);
    return true;
  } catch {
    return false;
  }
}
