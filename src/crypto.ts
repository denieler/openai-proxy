const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type ProxyTokenClaims = {
  aud: 'proxy';
  exp: number;
  iat: number;
  iss: 'openai-proxy';
  jti: string;
  sandbox_id?: string;
  scopes?: string[];
  session_id?: string;
  sub?: string;
};

type JwtHeader = {
  alg: 'HS256';
  typ: 'JWT';
};

export async function createProxyToken(
  claims: Omit<ProxyTokenClaims, 'aud' | 'exp' | 'iat' | 'iss' | 'jti'>,
  secret: string,
  nowMs: number,
  ttlSeconds: number,
  jti: string,
): Promise<string> {
  const nowSeconds = Math.floor(nowMs / 1000);
  const payload: ProxyTokenClaims = {
    ...claims,
    aud: 'proxy',
    exp: nowSeconds + ttlSeconds,
    iat: nowSeconds,
    iss: 'openai-proxy',
    jti,
  };

  return await signJwt(payload, secret);
}

export async function verifyProxyToken(
  token: string,
  secrets: string[],
  nowMs: number,
): Promise<ProxyTokenClaims | null> {
  for (const secret of secrets) {
    const payload = await verifyJwt<ProxyTokenClaims>(token, secret);
    if (!payload) {
      continue;
    }

    const nowSeconds = Math.floor(nowMs / 1000);
    if (payload.aud !== 'proxy' || payload.iss !== 'openai-proxy') {
      return null;
    }
    if (!Number.isInteger(payload.exp) || !Number.isInteger(payload.iat)) {
      return null;
    }
    if (payload.exp <= nowSeconds) {
      return null;
    }

    return payload;
  }

  return null;
}

export async function computeRequestSignature(
  secret: string,
  timestamp: string,
  method: string,
  pathAndQuery: string,
  bodyBytes: Uint8Array,
): Promise<string> {
  const bodyHash = await sha256Hex(bodyBytes);
  const payload =
    `${timestamp}\n${method.toUpperCase()}\n${pathAndQuery}\n${bodyHash}`;
  const signature = await hmacSha256(secret, payload);
  return base64UrlEncode(signature);
}

export async function verifyRequestSignature(
  signature: string,
  secrets: string[],
  timestamp: string,
  method: string,
  pathAndQuery: string,
  bodyBytes: Uint8Array,
): Promise<boolean> {
  for (const secret of secrets) {
    const expected = await computeRequestSignature(
      secret,
      timestamp,
      method,
      pathAndQuery,
      bodyBytes,
    );
    if (timingSafeEqual(signature, expected)) {
      return true;
    }
  }

  return false;
}

async function signJwt(
  payload: Record<string, unknown>,
  secret: string,
): Promise<string> {
  const header: JwtHeader = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = encodeJsonSegment(header);
  const encodedPayload = encodeJsonSegment(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await hmacSha256(secret, signingInput);
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

async function verifyJwt<T>(token: string, secret: string): Promise<T | null> {
  const segments = token.split('.');
  if (segments.length !== 3) {
    return null;
  }

  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = base64UrlEncode(
    await hmacSha256(secret, signingInput),
  );
  if (!timingSafeEqual(encodedSignature, expectedSignature)) {
    return null;
  }

  const header = decodeJsonSegment<JwtHeader>(encodedHeader);
  if (!header || header.alg !== 'HS256' || header.typ !== 'JWT') {
    return null;
  }

  return decodeJsonSegment<T>(encodedPayload);
}

async function hmacSha256(
  secret: string,
  payload: string,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    textEncoder.encode(payload),
  );
  return new Uint8Array(signature);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const digestBytes = new Uint8Array(digest);
  return Array.from(digestBytes).map((byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

function encodeJsonSegment(value: unknown): string {
  return base64UrlEncode(textEncoder.encode(JSON.stringify(value)));
}

function decodeJsonSegment<T>(segment: string): T | null {
  try {
    const json = textDecoder.decode(base64UrlDecode(segment));
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function base64UrlEncode(input: Uint8Array): string {
  const binary = Array.from(input).map((byte) => String.fromCharCode(byte))
    .join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(
    /=+$/g,
    '',
  );
}

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(Math.ceil(input.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const maxLength = Math.max(leftBytes.length, rightBytes.length);

  let mismatch = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = leftBytes[index] ?? 0;
    const rightValue = rightBytes[index] ?? 0;
    mismatch |= leftValue ^ rightValue;
  }

  return mismatch === 0;
}
