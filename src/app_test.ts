import { createApp, signAuthRequestForTesting } from './app.ts';
import { Config } from './config.ts';

function assert(
  condition: unknown,
  message = 'Assertion failed',
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals<T>(
  actual: T,
  expected: T,
  message = 'Values are not equal',
): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}\nExpected: ${expected}\nActual: ${actual}`);
  }
}

function assertMatch(
  actual: string,
  expected: RegExp,
  message = 'Value did not match',
): void {
  if (!expected.test(actual)) {
    throw new Error(`${message}\nExpected: ${expected}\nActual: ${actual}`);
  }
}

function createConfig(overrides: Partial<Config> = {}): Config {
  return {
    authMaxSkewSeconds: 300,
    authRateLimit: { max: 20, windowMs: 60_000 },
    hmacSecrets: ['auth-secret'],
    maxRequestBodyBytes: 1024 * 1024,
    openAiApiKey: 'server-openai-key',
    port: 8080,
    proxyRateLimit: { max: 300, windowMs: 60_000 },
    tokenSecrets: ['token-secret'],
    tokenTtlSeconds: 600,
    upstreamBaseUrl: 'https://api.openai.com',
    upstreamTimeoutMs: 5_000,
    ...overrides,
  };
}

async function issueToken(
  app: ReturnType<typeof createApp>,
  nowSeconds: number,
  body: Record<string, unknown> = { sub: 'codex-client' },
): Promise<string> {
  const request = new Request('http://localhost/auth/token', {
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      'x-timestamp': String(nowSeconds),
    },
    method: 'POST',
  });

  const signature = await signAuthRequestForTesting('auth-secret', request);
  request.headers.set('x-signature', signature);

  const response = await app(request);
  assertEquals(response.status, 200, 'Token issuance should succeed');
  const json = await response.json();
  assert(
    typeof json.access_token === 'string',
    'Response should contain access_token',
  );
  return json.access_token as string;
}

Deno.test('issues a short-lived token from a signed auth request', async () => {
  const nowMs = 1_700_000_000_000;
  const app = createApp(createConfig(), {
    now: () => nowMs,
    randomUUID: () => 'fixed-jti',
  });

  const token = await issueToken(app, Math.floor(nowMs / 1000));
  assertMatch(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

Deno.test('rejects invalid auth request signatures', async () => {
  const nowMs = 1_700_000_000_000;
  const app = createApp(createConfig(), { now: () => nowMs });

  const request = new Request('http://localhost/auth/token', {
    body: JSON.stringify({ sub: 'codex-client' }),
    headers: {
      'content-type': 'application/json',
      'x-signature': 'bad-signature',
      'x-timestamp': String(Math.floor(nowMs / 1000)),
    },
    method: 'POST',
  });

  const response = await app(request);
  assertEquals(response.status, 401);
});

Deno.test('rejects expired proxy tokens', async () => {
  let nowMs = 1_700_000_000_000;
  const app = createApp(createConfig({ tokenTtlSeconds: 2 }), {
    fetchImpl: () => Promise.resolve(new Response('ok')),
    now: () => nowMs,
    randomUUID: () => 'fixed-jti',
  });

  const token = await issueToken(app, Math.floor(nowMs / 1000));
  nowMs += 3_000;

  const response = await app(
    new Request('http://localhost/v1/responses', {
      body: JSON.stringify({ model: 'gpt-4.1-mini', input: 'hi' }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    }),
  );

  assertEquals(response.status, 401);
});

Deno.test('strips client authorization and injects server authorization', async () => {
  const nowMs = 1_700_000_000_000;
  let forwardedAuthorization = '';

  const app = createApp(createConfig(), {
    fetchImpl: (input, init) => {
      const url = input instanceof URL ? input : new URL(String(input));
      assertEquals(url.toString(), 'https://api.openai.com/v1/responses');
      const headers = new Headers(init?.headers);
      forwardedAuthorization = headers.get('authorization') ?? '';
      assertEquals(
        headers.get('x-request-id') !== null,
        true,
        'Request ID should be forwarded',
      );
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      );
    },
    now: () => nowMs,
    randomUUID: () => 'fixed-jti',
  });

  const token = await issueToken(app, Math.floor(nowMs / 1000));
  const response = await app(
    new Request('http://localhost/v1/responses', {
      body: JSON.stringify({ model: 'gpt-4.1-mini', input: 'hello' }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-custom-header': 'kept',
      },
      method: 'POST',
    }),
  );

  assertEquals(response.status, 200);
  assertEquals(forwardedAuthorization, 'Bearer server-openai-key');
});

Deno.test('relays streaming upstream responses', async () => {
  const nowMs = 1_700_000_000_000;
  const app = createApp(createConfig(), {
    fetchImpl: () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: first\n\n'));
          controller.enqueue(new TextEncoder().encode('data: second\n\n'));
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(stream, {
          headers: { 'content-type': 'text/event-stream' },
          status: 200,
        }),
      );
    },
    now: () => nowMs,
    randomUUID: () => 'fixed-jti',
  });

  const token = await issueToken(app, Math.floor(nowMs / 1000));
  const response = await app(
    new Request('http://localhost/v1/responses', {
      headers: {
        authorization: `Bearer ${token}`,
      },
      method: 'POST',
    }),
  );

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type'), 'text/event-stream');
  assertEquals(await response.text(), 'data: first\n\ndata: second\n\n');
});

Deno.test('rate limits repeated auth requests', async () => {
  const nowMs = 1_700_000_000_000;
  const app = createApp(
    createConfig({
      authRateLimit: { max: 1, windowMs: 60_000 },
    }),
    {
      now: () => nowMs,
      randomUUID: () => 'fixed-jti',
    },
  );

  await issueToken(app, Math.floor(nowMs / 1000));

  const request = new Request('http://localhost/auth/token', {
    body: JSON.stringify({ sub: 'codex-client' }),
    headers: {
      'content-type': 'application/json',
      'x-timestamp': String(Math.floor(nowMs / 1000)),
    },
    method: 'POST',
  });
  const signature = await signAuthRequestForTesting('auth-secret', request);
  request.headers.set('x-signature', signature);

  const response = await app(request);
  assertEquals(response.status, 429);
});

Deno.test('rejects invalid proxy token signatures', async () => {
  const nowMs = 1_700_000_000_000;
  const app = createApp(createConfig(), {
    fetchImpl: () => Promise.resolve(new Response('ok')),
    now: () => nowMs,
  });

  const response = await app(
    new Request('http://localhost/v1/responses', {
      body: JSON.stringify({ model: 'gpt-4.1-mini', input: 'hello' }),
      headers: {
        authorization: 'Bearer invalid.token.signature',
        'content-type': 'application/json',
      },
      method: 'POST',
    }),
  );

  assertEquals(response.status, 401);
});
