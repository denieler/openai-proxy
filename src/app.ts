import { Config } from './config.ts';
import {
  computeRequestSignature,
  createProxyToken,
  ProxyTokenClaims,
  verifyProxyToken,
  verifyRequestSignature,
} from './crypto.ts';
import {
  buildForwardHeaders,
  getBearerToken,
  getClientIp,
  HttpError,
  jsonResponse,
  parseJsonObject,
  readBodyLimited,
  sanitizeResponseHeaders,
  setCommonHeaders,
} from './http.ts';
import { FixedWindowRateLimiter } from './rate_limiter.ts';

export type LoggerFields = Record<
  string,
  string | number | boolean | undefined
>;
export type Logger = (
  level: 'info' | 'warn' | 'error',
  message: string,
  fields?: LoggerFields,
) => void;

type AppDependencies = {
  fetchImpl?: typeof fetch;
  logger?: Logger;
  now?: () => number;
  randomUUID?: () => string;
  rateLimiter?: FixedWindowRateLimiter;
};

type AuthTokenRequestBody = {
  sandbox_id?: string;
  scopes?: string[];
  session_id?: string;
  sub?: string;
};

export function createApp(config: Config, dependencies: AppDependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const logger = dependencies.logger ?? defaultLogger;
  const now = dependencies.now ?? (() => Date.now());
  const randomUUID = dependencies.randomUUID ?? (() => crypto.randomUUID());
  const rateLimiter = dependencies.rateLimiter ?? new FixedWindowRateLimiter();

  return async function handler(
    request: Request,
    info?: Deno.ServeHandlerInfo,
  ): Promise<Response> {
    const requestId = request.headers.get('x-request-id') ?? randomUUID();
    const startedAt = now();
    const url = new URL(request.url);
    const clientIp = getClientIp(request, info);

    try {
      let response: Response;
      if (request.method === 'GET' && url.pathname === '/healthz') {
        response = jsonResponse(200, { ok: true });
      } else if (request.method === 'POST' && url.pathname === '/auth/token') {
        response = await handleAuthToken(
          request,
          requestId,
          clientIp,
          config,
          now,
          randomUUID,
          rateLimiter,
        );
      } else if (url.pathname.startsWith('/v1/')) {
        response = await handleProxyRequest(
          request,
          requestId,
          clientIp,
          config,
          now,
          rateLimiter,
          fetchImpl,
        );
      } else {
        response = jsonResponse(404, { error: 'not_found' });
      }

      const headers = new Headers(response.headers);
      setCommonHeaders(headers, requestId);
      const finalResponse = new Response(response.body, {
        headers,
        status: response.status,
        statusText: response.statusText,
      });

      logger('info', 'request_complete', {
        client_ip: clientIp,
        duration_ms: now() - startedAt,
        method: request.method,
        path: url.pathname,
        request_id: requestId,
        status: finalResponse.status,
      });

      return finalResponse;
    } catch (error) {
      const response = toErrorResponse(error, requestId);
      logger(response.status >= 500 ? 'error' : 'warn', 'request_failed', {
        client_ip: clientIp,
        duration_ms: now() - startedAt,
        error: error instanceof Error ? error.message : 'unknown_error',
        method: request.method,
        path: url.pathname,
        request_id: requestId,
        status: response.status,
      });
      return response;
    }
  };
}

async function handleAuthToken(
  request: Request,
  requestId: string,
  clientIp: string,
  config: Config,
  now: () => number,
  randomUUID: () => string,
  rateLimiter: FixedWindowRateLimiter,
): Promise<Response> {
  applyRateLimit(
    rateLimiter,
    `auth:${clientIp}`,
    config.authRateLimit.max,
    config.authRateLimit.windowMs,
    now(),
  );
  const bodyBytes = await readBodyLimited(request, config.maxRequestBodyBytes);

  const timestamp = request.headers.get('x-timestamp');
  const signature = request.headers.get('x-signature');
  if (!timestamp || !signature) {
    throw new HttpError(401, { error: 'unauthorized' });
  }

  const timestampMs = Number(timestamp) * 1000;
  if (!Number.isFinite(timestampMs)) {
    throw new HttpError(401, { error: 'unauthorized' });
  }

  const skewSeconds = Math.abs(now() - timestampMs) / 1000;
  if (skewSeconds > config.authMaxSkewSeconds) {
    throw new HttpError(401, { error: 'unauthorized' });
  }

  const url = new URL(request.url);
  const verified = await verifyRequestSignature(
    signature,
    config.hmacSecrets,
    timestamp,
    request.method,
    `${url.pathname}${url.search}`,
    bodyBytes,
  );
  if (!verified) {
    throw new HttpError(401, { error: 'unauthorized' });
  }

  const body = parseJsonObject(bodyBytes);
  const tokenBody = normalizeAuthTokenRequestBody(body);
  const accessToken = await createProxyToken(
    tokenBody,
    config.tokenSecrets[0],
    now(),
    config.tokenTtlSeconds,
    randomUUID(),
  );

  return jsonResponse(200, {
    access_token: accessToken,
    expires_in: config.tokenTtlSeconds,
    request_id: requestId,
    token_type: 'Bearer',
  });
}

async function handleProxyRequest(
  request: Request,
  requestId: string,
  clientIp: string,
  config: Config,
  now: () => number,
  rateLimiter: FixedWindowRateLimiter,
  fetchImpl: typeof fetch,
): Promise<Response> {
  applyRateLimit(
    rateLimiter,
    `proxy:${clientIp}`,
    config.proxyRateLimit.max,
    config.proxyRateLimit.windowMs,
    now(),
  );

  const bearerToken = getBearerToken(request.headers);
  if (!bearerToken) {
    throw new HttpError(401, { error: 'unauthorized' });
  }

  const verifiedClaims = await verifyProxyToken(
    bearerToken,
    config.tokenSecrets,
    now(),
  );
  if (!verifiedClaims) {
    throw new HttpError(401, { error: 'unauthorized' });
  }
  void verifiedClaims;

  const bodyBytes = await readBodyLimited(request, config.maxRequestBodyBytes);
  const url = new URL(request.url);
  const upstreamUrl = new URL(
    url.pathname + url.search,
    config.upstreamBaseUrl,
  );
  const upstreamHeaders = buildForwardHeaders(
    request,
    `Bearer ${config.openAiApiKey}`,
  );
  upstreamHeaders.set('x-request-id', requestId);

  const upstreamResponse = await fetchImpl(upstreamUrl, {
    body: bodyBytes.byteLength > 0 ? bodyBytes : undefined,
    headers: upstreamHeaders,
    method: request.method,
    signal: AbortSignal.timeout(config.upstreamTimeoutMs),
  });

  const responseHeaders = sanitizeResponseHeaders(upstreamResponse.headers);
  return new Response(upstreamResponse.body, {
    headers: responseHeaders,
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
  });
}

function applyRateLimit(
  rateLimiter: FixedWindowRateLimiter,
  key: string,
  max: number,
  windowMs: number,
  nowMs: number,
): void {
  const result = rateLimiter.take(key, max, windowMs, nowMs);
  if (!result.allowed) {
    throw new HttpError(429, { error: 'rate_limited' });
  }
}

function normalizeAuthTokenRequestBody(
  body: Record<string, unknown>,
): AuthTokenRequestBody {
  const normalized: AuthTokenRequestBody = {};

  if (typeof body.sub === 'string' && body.sub.trim().length > 0) {
    normalized.sub = body.sub.trim();
  }
  if (
    typeof body.session_id === 'string' && body.session_id.trim().length > 0
  ) {
    normalized.session_id = body.session_id.trim();
  }
  if (
    typeof body.sandbox_id === 'string' && body.sandbox_id.trim().length > 0
  ) {
    normalized.sandbox_id = body.sandbox_id.trim();
  }
  if (
    Array.isArray(body.scopes) &&
    body.scopes.every((scope) => typeof scope === 'string')
  ) {
    normalized.scopes = body.scopes.map((scope) => scope.trim()).filter((
      scope,
    ) => scope.length > 0);
  }

  return normalized;
}

function toErrorResponse(error: unknown, requestId: string): Response {
  if (error instanceof HttpError) {
    const headers = new Headers();
    setCommonHeaders(headers, requestId);
    return jsonResponse(error.status, error.body, headers);
  }

  const headers = new Headers();
  setCommonHeaders(headers, requestId);
  return jsonResponse(500, { error: 'internal_error' }, headers);
}

function defaultLogger(
  level: 'info' | 'warn' | 'error',
  message: string,
  fields: LoggerFields = {},
): void {
  console.log(JSON.stringify({ level, message, ...fields }));
}

export async function signAuthRequestForTesting(
  secret: string,
  request: Request,
): Promise<string> {
  const clone = request.clone();
  const bodyBytes = await readBodyLimited(clone, 1024 * 1024);
  const url = new URL(request.url);
  const timestamp = request.headers.get('x-timestamp');
  if (!timestamp) {
    throw new Error('Request is missing x-timestamp');
  }
  return await computeRequestSignature(
    secret,
    timestamp,
    request.method,
    `${url.pathname}${url.search}`,
    bodyBytes,
  );
}

export type VerifiedClaims = ProxyTokenClaims;
