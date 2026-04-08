const DEFAULT_PORT = 8080;
const DEFAULT_TOKEN_TTL_SECONDS = 600;
const DEFAULT_AUTH_MAX_SKEW_SECONDS = 300;
const DEFAULT_MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000;
const DEFAULT_AUTH_RATE_LIMIT_MAX = 20;
const DEFAULT_AUTH_RATE_LIMIT_WINDOW_SECONDS = 60;
const DEFAULT_PROXY_RATE_LIMIT_MAX = 300;
const DEFAULT_PROXY_RATE_LIMIT_WINDOW_SECONDS = 60;

export type RateLimitConfig = {
  max: number;
  windowMs: number;
};

export type Config = {
  port: number;
  upstreamBaseUrl: string;
  openAiApiKey: string;
  hmacSecrets: string[];
  tokenSecrets: string[];
  tokenTtlSeconds: number;
  authMaxSkewSeconds: number;
  maxRequestBodyBytes: number;
  upstreamTimeoutMs: number;
  authRateLimit: RateLimitConfig;
  proxyRateLimit: RateLimitConfig;
};

export function loadConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): Config {
  const openAiApiKey = requireEnv(env, 'OPENAI_API_KEY');
  const currentHmacSecret = requireEnv(env, 'PROXY_HMAC_SECRET');
  const currentTokenSecret = requireEnv(env, 'PROXY_TOKEN_SECRET');

  const previousHmacSecret = optionalEnv(env, 'PROXY_HMAC_PREVIOUS_SECRET');
  const previousTokenSecret = optionalEnv(env, 'PROXY_TOKEN_PREVIOUS_SECRET');

  return {
    port: parseNumber(env.PORT, DEFAULT_PORT, 'PORT'),
    upstreamBaseUrl: 'https://api.openai.com',
    openAiApiKey,
    hmacSecrets: [currentHmacSecret, ...compact([previousHmacSecret])],
    tokenSecrets: [currentTokenSecret, ...compact([previousTokenSecret])],
    tokenTtlSeconds: parseNumber(
      env.PROXY_TOKEN_TTL_SECONDS,
      DEFAULT_TOKEN_TTL_SECONDS,
      'PROXY_TOKEN_TTL_SECONDS',
    ),
    authMaxSkewSeconds: parseNumber(
      env.AUTH_MAX_SKEW_SECONDS,
      DEFAULT_AUTH_MAX_SKEW_SECONDS,
      'AUTH_MAX_SKEW_SECONDS',
    ),
    maxRequestBodyBytes: parseNumber(
      env.MAX_REQUEST_BODY_BYTES,
      DEFAULT_MAX_REQUEST_BODY_BYTES,
      'MAX_REQUEST_BODY_BYTES',
    ),
    upstreamTimeoutMs: parseNumber(
      env.UPSTREAM_TIMEOUT_MS,
      DEFAULT_UPSTREAM_TIMEOUT_MS,
      'UPSTREAM_TIMEOUT_MS',
    ),
    authRateLimit: {
      max: parseNumber(
        env.AUTH_RATE_LIMIT_MAX,
        DEFAULT_AUTH_RATE_LIMIT_MAX,
        'AUTH_RATE_LIMIT_MAX',
      ),
      windowMs: parseNumber(
        env.AUTH_RATE_LIMIT_WINDOW_SECONDS,
        DEFAULT_AUTH_RATE_LIMIT_WINDOW_SECONDS,
        'AUTH_RATE_LIMIT_WINDOW_SECONDS',
      ) * 1000,
    },
    proxyRateLimit: {
      max: parseNumber(
        env.PROXY_RATE_LIMIT_MAX,
        DEFAULT_PROXY_RATE_LIMIT_MAX,
        'PROXY_RATE_LIMIT_MAX',
      ),
      windowMs: parseNumber(
        env.PROXY_RATE_LIMIT_WINDOW_SECONDS,
        DEFAULT_PROXY_RATE_LIMIT_WINDOW_SECONDS,
        'PROXY_RATE_LIMIT_WINDOW_SECONDS',
      ) * 1000,
    },
  };
}

function requireEnv(
  env: Record<string, string | undefined>,
  key: string,
): string {
  const value = optionalEnv(env, key);
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
}

function optionalEnv(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = env[key];
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseNumber(
  rawValue: string | undefined,
  fallback: number,
  key: string,
): number {
  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid numeric environment variable: ${key}`);
  }

  return Math.trunc(value);
}

function compact(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value));
}
