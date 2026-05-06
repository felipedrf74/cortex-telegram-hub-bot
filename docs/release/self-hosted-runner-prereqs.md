# Self-Hosted Runner Prerequisites

Status: canonical
Owner: release lead (Felipe)
Last verified: 2026-05-06
Update policy: update when the promote runner labels, SSH target, tunnel
topology, or deployment transport changes.

## Purpose

Production and staging deployment scripts still require SSH and rsync to
`dominguez@serverdominguez`. GitHub-hosted runners are not a valid deployment
path for that target because the server is reached through the operator network
and IPv6-only host alias, while the existing Cloudflare Tunnel exposes HTTPS
application routes only.

The public HTTPS tunnel is valid for external health and app reachability:

- `https://api.nexushub.me/health`
- `https://api-staging.nexushub.me/health`

It is not a deploy transport. Do not route `deploy.sh`, `deploy-staging.sh`, or
`promote-to-prod.sh` through the HTTPS tunnel unless the server has an explicit
owner-approved SSH transport for that route.

## Required Runner

Use a self-hosted GitHub Actions runner with these labels:

```text
self-hosted
nexus-hub-promote
```

The runner must be on a machine that can:

- resolve `serverdominguez`;
- run non-interactive SSH to `dominguez@serverdominguez` with local SSH config,
  local key material, and a populated `known_hosts`;
- run `bash`, `curl`, `ssh`, `rsync`, `git`, `node`, and `npm`;
- check out the engine repo through `actions/checkout`;
- reach `https://api.nexushub.me/health` and
  `https://api-staging.nexushub.me/health` over normal HTTPS.

No production SSH key should be added as a GitHub secret for this path. The
runner host owns its local SSH identity, matching Felipe's existing Mac-side
deploy model.

## Reachability Smoke

Run the manual workflow:

```text
.github/workflows/promote-reachability.yml
```

It performs two checks:

- a GitHub-hosted job resolves and probes the Cloudflare HTTPS health endpoints;
- a self-hosted job resolves `serverdominguez` and runs `ssh -o BatchMode=yes`
  against `dominguez@serverdominguez`.

The workflow does not deploy. If the self-hosted job queues indefinitely, the
runner is missing, offline, or missing the expected labels. In that state,
continue using the documented local promote path from Felipe's Mac.

## Guardrails

- Do not revive the archived SSH deploy workflow on `ubuntu-latest`.
- Do not add SSH deploy secrets to GitHub without explicit owner approval.
- Do not treat Cloudflare HTTPS health success as proof that SSH deploys can
  run from hosted GitHub runners.
- Do not run production promotion from Actions until the self-hosted smoke has
  passed in the same runner environment.
