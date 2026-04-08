export class HttpError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    super(body.error ? String(body.error) : `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

const HOP_BY_HOP_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export async function readBodyLimited(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!request.body) {
    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    size += value.byteLength;
    if (size > maxBytes) {
      throw new HttpError(413, { error: 'payload_too_large' });
    }
    chunks.push(value);
  }

  return concatBytes(chunks, size);
}

export function buildForwardHeaders(
  request: Request,
  authorization: string,
): Headers {
  const headers = new Headers();
  for (const [key, value] of request.headers) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      continue;
    }
    headers.set(key, value);
  }

  headers.set('authorization', authorization);
  return headers;
}

export function sanitizeResponseHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const [key, value] of source) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      continue;
    }
    headers.set(key, value);
  }
  return headers;
}

export function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(extraHeaders);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers });
}

export function getBearerToken(headers: Headers): string | null {
  const authorization = headers.get('authorization');
  if (!authorization) {
    return null;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

export function getClientIp(
  request: Request,
  info?: Deno.ServeHandlerInfo,
): string {
  const flyClientIp = request.headers.get('fly-client-ip');
  if (flyClientIp) {
    return flyClientIp;
  }

  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim();
  }

  const remoteAddress = info?.remoteAddr;
  if (remoteAddress?.transport === 'tcp') {
    return remoteAddress.hostname;
  }

  return 'unknown';
}

export function parseJsonObject(bytes: Uint8Array): Record<string, unknown> {
  if (bytes.byteLength === 0) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, { error: 'invalid_json' });
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, { error: 'invalid_json' });
  }

  return parsed as Record<string, unknown>;
}

export function setCommonHeaders(headers: Headers, requestId: string): void {
  headers.set('x-request-id', requestId);
  headers.set('cache-control', 'no-store');
}

function concatBytes(chunks: Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
