# Repository Guidelines

## Project Structure & Module Organization

This repository is a small Deno service that proxies Codex traffic to the OpenAI API. Keep runtime code in `src/`:

- `src/main.ts` boots the server.
- `src/app.ts` defines routes and request handling.
- `src/config.ts` loads and validates environment-driven configuration.
- `src/crypto.ts`, `src/http.ts`, and `src/rate_limiter.ts` provide focused support code.
- `src/app_test.ts` covers token issuance, proxying, and rate limiting.

Keep repository-level documentation and packaging files at the top level. Use `README.md` for user-facing setup and usage, `PLAN.md` for implementation scope, `Dockerfile` for container packaging, and `assets/` for static artwork.

## Build, Test, and Development Commands

- `deno task dev`: run the server with file watching.
- `deno task start`: run the server without watch mode.
- `deno task test`: run the test suite with environment access.
- `deno fmt`: format code according to `deno.json`.
- `deno lint`: run Deno’s recommended lint rules.
- `docker build -t openai-proxy .`: build the container image.

Run all commands from the repository root.

## Coding Style & Naming Conventions

Write TypeScript with Deno-native APIs and ES module imports that end in `.ts`. Follow `deno.json`: semicolons enabled and single quotes preferred. Use `camelCase` for variables and functions, `PascalCase` for types and classes, and `snake_case` only for external payload fields such as `session_id`. Keep modules small and focused on one responsibility.

## Testing Guidelines

Add tests in `src/*_test.ts` near the code they cover. Use `Deno.test(...)` with explicit scenario names such as `rejects invalid proxy token signatures`. Prioritize security-sensitive paths: auth validation, header stripping, upstream forwarding, timeout handling, and rate limiting. Run `deno task test` before opening a pull request.

## Commit & Pull Request Guidelines

Write commit messages in this format: `<Verb> <specific change>`. Examples: `Add README logo`, `Harden token validation`, `Strip client auth before upstream proxying`. Keep each commit scoped to a single change.

Pull requests should include a short description, any config or environment-variable changes, and the related issue when applicable. Include sample requests or responses when behavior changes. If you change the API or developer workflow, update `README.md` in the same pull request.

## Security & Configuration Tips

Never hardcode secrets. Load `OPENAI_API_KEY`, `PROXY_HMAC_SECRET`, and `PROXY_TOKEN_SECRET` from the environment. Use `PROXY_HMAC_PREVIOUS_SECRET` and `PROXY_TOKEN_PREVIOUS_SECRET` only for key rotation. Preserve the current security model: strip client `Authorization` headers before forwarding requests upstream.
