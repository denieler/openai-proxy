# OpenAI Proxy

![OpenAI Proxy architecture](assets/proxy-architecture.svg)

Lightweight Deno proxy for Codex CLI requests to the OpenAI API.

## Features

- issues short-lived proxy tokens from `POST /auth/token`
- validates short-lived bearer tokens on `ALL /v1/*`
- removes any client-supplied `Authorization`
- injects server-side `Authorization: Bearer <OPENAI_API_KEY>`
- forwards all `/v1/*` paths to `https://api.openai.com`
- streams upstream responses back to the caller
- includes basic rate limiting, body size limits, request timeouts, and secret rotation support

## Environment Variables

See `.env.example`.

Required:

- `OPENAI_API_KEY`
- `PROXY_HMAC_SECRET`
- `PROXY_TOKEN_SECRET`

Optional rotation:

- `PROXY_HMAC_PREVIOUS_SECRET`
- `PROXY_TOKEN_PREVIOUS_SECRET`

## Local Run

```bash
deno task start
```

## Tests

```bash
deno test --allow-env
```

## Auth Token Flow

`POST /auth/token` expects:

- header `X-Timestamp`: unix timestamp in seconds
- header `X-Signature`: HMAC-SHA256 signature
- JSON body with optional fields such as `sub`, `session_id`, `sandbox_id`, `scopes`

Signature payload format:

```text
timestamp + "\n" + method + "\n" + path_and_query + "\n" + sha256_hex(body)
```

Example body:

```json
{
  "sub": "codex-cli",
  "session_id": "session-123",
  "sandbox_id": "sandbox-456"
}
```

Successful response:

```json
{
  "access_token": "<short-lived-token>",
  "token_type": "Bearer",
  "expires_in": 600
}
```

## Proxy Flow

Send Codex traffic to `/v1/*` with:

```http
Authorization: Bearer <short-lived-token>
```

The proxy validates the token, strips the incoming auth header, injects `OPENAI_API_KEY`, and forwards the request upstream.

## Docker

```bash
docker build -t openai-proxy .
docker run --rm -p 8080:8080 --env-file .env openai-proxy
```

## Fly.io

The repo includes `fly.toml`. Update the `app` value before deployment, then set Fly secrets for:

- `OPENAI_API_KEY`
- `PROXY_HMAC_SECRET`
- `PROXY_TOKEN_SECRET`
