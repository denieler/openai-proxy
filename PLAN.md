# OpenAI Proxy Implementation Plan

## Goal

Build a very lightweight Deno-based proxy service for Codex CLI that:

- accepts Codex requests on `/v1/*`
- authenticates callers using short-lived proxy tokens
- issues those short-lived tokens from `/auth/token` using HMAC-signed requests
- strips client-supplied `Authorization`
- injects server-side `Authorization: Bearer <OPENAI_API_KEY>`
- forwards requests to the OpenAI API
- streams upstream responses back to the client
- runs in Docker and is deployable to Fly.io

## Endpoints

### `POST /auth/token`

Responsibilities:

- require an HMAC-signed request using `PROXY_HMAC_SECRET`
- verify timestamp freshness
- parse optional caller metadata such as `sub`, `session_id`, `sandbox_id`
- mint a short-lived signed proxy token using `PROXY_TOKEN_SECRET`
- include claims:
  - `iat`
  - `exp`
  - `jti`
  - `aud=proxy`
- return:
  - `access_token`
  - `token_type`
  - `expires_in`

### `ALL /v1/*`

Responsibilities:

- require `Authorization: Bearer <short-lived-token>`
- verify token signature, audience, and expiration
- reject invalid auth with generic `401` responses
- proxy all `/v1/*` paths generically
- hardcode upstream to `https://api.openai.com`
- remove any client-supplied `Authorization`
- inject `Authorization: Bearer ${OPENAI_API_KEY}`
- forward method, query string, headers, and body
- stream upstream responses back without buffering

### `GET /healthz`

Responsibilities:

- return a simple health response
- expose no internal details

## Security Baseline

Implement the following baseline controls:

- short-lived proxy tokens with a default TTL around 10 minutes
- HMAC-signed `/auth/token` requests with timestamp freshness validation
- strict upstream host and path control
- request body size limit
- upstream and server timeouts
- rate limiting for `/auth/token` and `/v1/*`
- structured logs with redaction of tokens, prompts, and secrets
- secret rotation support for HMAC and token signing secrets
- fail closed if required env vars are missing

## Stateless Design

Keep the service stateless:

- no database required
- expiration checked from signed token `exp`
- `jti` included for future revocation support if needed
- replay protection for `/auth/token` initially based on timestamp freshness
  only

## Deployment Packaging

Package the service for deployment with:

- `Dockerfile`
- `.dockerignore`
- non-root runtime user
- `fly.toml`
- `.env.example` with placeholders only

## Tests

Add tests covering:

- HMAC request verification
- short-lived token mint/verify and expiry handling
- auth stripping and server auth injection
- streaming passthrough
- rate-limit behavior
- invalid audience, signature, and expired token cases

## Configuration

Required and optional environment variables:

- `OPENAI_API_KEY`
- `PROXY_HMAC_SECRET`
- `PROXY_TOKEN_SECRET`
- `PROXY_HMAC_PREVIOUS_SECRET` (optional)
- `PROXY_TOKEN_PREVIOUS_SECRET` (optional)
- `PROXY_TOKEN_TTL_SECONDS`
- `AUTH_MAX_SKEW_SECONDS`
- `MAX_REQUEST_BODY_BYTES`
- `PORT`
