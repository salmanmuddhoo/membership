import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  createUploadTicket,
  sanitiseFileName,
  uploadInChunks,
  UploadRejected,
  validateUploadRequest,
  DEFAULT_CHUNK_SIZE,
} from './upload';
import { resetTokenCache, type GraphConfig } from './graph';

// A stand-in for Graph that enforces the parts of the protocol this code
// depends on: chunk alignment, Content-Range continuity, and the size declared
// up front. Asserting against a mock that accepts anything would prove only
// that our code runs.
//
// Vercel rejects a request body over ~4.5 MB before the handler sees it, so the
// number that matters is whether a file LARGER than that arrives intact by this
// route. These tests send 9 MB.
interface UploadState {
  received: Buffer[];
  total: number;
  nextExpectedOffset: number;
}

let server: Server;
let baseUrl: string;
const sessions = new Map<string, UploadState>();
// What the double actually reassembled, so a test can compare it byte for byte
// against what was sent rather than trusting the response.
const assembledBySession = new Map<string, Buffer>();
let lastCreateBody: unknown;

function config(): GraphConfig {
  return {
    tenantId: 'tenant',
    clientId: 'client',
    clientSecret: 'secret',
    driveId: 'drive-1',
    graphBaseUrl: `${baseUrl}/v1.0`,
    loginBaseUrl: baseUrl,
  };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', baseUrl || 'http://localhost');

    // Token endpoint.
    if (req.method === 'POST' && url.pathname.endsWith('/oauth2/v2.0/token')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }));
      return;
    }

    // createUploadSession.
    if (
      req.method === 'POST' &&
      url.pathname.endsWith('/createUploadSession')
    ) {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        lastCreateBody = JSON.parse(Buffer.concat(chunks).toString());
        const id = `session-${sessions.size + 1}`;
        sessions.set(id, { received: [], total: 0, nextExpectedOffset: 0 });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            uploadUrl: `${baseUrl}/upload/${id}`,
            expirationDateTime: new Date(Date.now() + 3600_000).toISOString(),
          })
        );
      });
      return;
    }

    // Chunk upload.
    if (req.method === 'PUT' && url.pathname.startsWith('/upload/')) {
      const id = url.pathname.split('/')[2];
      const state = sessions.get(id);
      if (!state) {
        res.writeHead(404).end();
        return;
      }

      const range = req.headers['content-range'] as string | undefined;
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range ?? '');
      if (!match) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'malformed Content-Range' }));
        return;
      }

      const start = Number(match[1]);
      const end = Number(match[2]);
      const total = Number(match[3]);

      // Graph refuses a chunk that does not continue where the last one ended.
      if (start !== state.nextExpectedOffset) {
        res.writeHead(416, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'range does not continue' }));
        return;
      }

      const body: Buffer[] = [];
      req.on('data', (c: Buffer) => body.push(c));
      req.on('end', () => {
        const chunk = Buffer.concat(body);

        if (chunk.byteLength !== end - start + 1) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'length does not match range' }));
          return;
        }

        // Every chunk but the last must be a multiple of 320 KiB.
        const isLast = end + 1 === total;
        if (!isLast && chunk.byteLength % (320 * 1024) !== 0) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'chunk not a multiple of 320 KiB' }));
          return;
        }

        state.received.push(chunk);
        state.nextExpectedOffset = end + 1;
        state.total = total;

        if (isLast) {
          const assembled = Buffer.concat(state.received);
          assembledBySession.set(id, assembled);
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: `item-${id}`,
              name: 'uploaded',
              size: assembled.byteLength,
              webUrl: `https://sharepoint.example/${id}`,
            })
          );
        } else {
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ nextExpectedRanges: [`${end + 1}-`] }));
        }
      });
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

afterEach(() => {
  resetTokenCache();
  sessions.clear();
  assembledBySession.clear();
});

// Vercel's serverless request-body limit. The whole point of the spike is to
// get past it.
const VERCEL_BODY_LIMIT = 4.5 * 1024 * 1024;

describe('S-112: a file larger than the request limit reaches storage', () => {
  it('transfers 9 MB intact, in chunks, through an upload session', async () => {
    const size = 9 * 1024 * 1024;
    expect(size).toBeGreaterThan(VERCEL_BODY_LIMIT);

    // Recognisable bytes, so a chunk arriving out of order would corrupt the
    // pattern rather than going unnoticed.
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) bytes[i] = i % 251;

    const ticket = await createUploadTicket(
      {
        folderPath: 'Members/ABM-000001',
        fileName: 'national-id.jpg',
        sizeBytes: size,
        contentType: 'image/jpeg',
      },
      config()
    );

    const result = await uploadInChunks(
      ticket.uploadUrl,
      bytes,
      ticket.chunkSize
    );

    expect(result.size).toBe(size);
    expect(result.id).toBe('item-session-1');

    // The bytes the double reassembled must equal the bytes sent, exactly. A
    // chunk arriving out of order, duplicated or truncated fails here — which
    // is the whole claim the spike is making.
    const assembled = assembledBySession.get('session-1');
    expect(assembled).toBeDefined();
    expect(assembled!.byteLength).toBe(size);
    expect(Buffer.from(bytes).equals(assembled!)).toBe(true);
  }, 30_000);

  it('sends chunks Graph will accept', async () => {
    // Every chunk but the last must be a multiple of 320 KiB; the double
    // rejects anything else, so this passing is the assertion.
    expect(DEFAULT_CHUNK_SIZE % (320 * 1024)).toBe(0);

    const size = 5 * 1024 * 1024 + 12_345; // deliberately not chunk-aligned
    const bytes = new Uint8Array(size).fill(7);

    const ticket = await createUploadTicket(
      {
        folderPath: 'Members/ABM-000002',
        fileName: 'proof.pdf',
        sizeBytes: size,
        contentType: 'application/pdf',
      },
      config()
    );

    const result = await uploadInChunks(ticket.uploadUrl, bytes, 320 * 1024);
    expect(result.size).toBe(size);
  }, 30_000);

  it('fails rather than reporting success when a chunk is rejected', async () => {
    // S-408: a failed upload must never be recorded as uploaded.
    const bytes = new Uint8Array(1024).fill(1);
    const ticket = await createUploadTicket(
      {
        folderPath: 'Members/ABM-000003',
        fileName: 'x.pdf',
        sizeBytes: bytes.byteLength,
        contentType: 'application/pdf',
      },
      config()
    );

    // A fetch that mangles the range so the server refuses continuity.
    const brokenFetch: typeof fetch = (input, init) =>
      fetch(input as string, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string>),
          'content-range': 'bytes 500-600/1024',
        },
      });

    await expect(
      uploadInChunks(ticket.uploadUrl, bytes, 512, brokenFetch)
    ).rejects.toThrowError(/Chunk upload failed/);
  });
});

describe('the backend decides the terms', () => {
  it('never overwrites a filed document silently', async () => {
    await createUploadTicket(
      {
        folderPath: 'Members/ABM-000004',
        fileName: 'id.jpg',
        sizeBytes: 1000,
        contentType: 'image/jpeg',
      },
      config()
    );

    // A replacement is an explicit action with its own history (S-409), not a
    // side effect of uploading the same name twice.
    expect(lastCreateBody).toMatchObject({
      item: { '@microsoft.graph.conflictBehavior': 'rename' },
    });
  });

  it('refuses a file type a document library has no reason to hold', () => {
    expect(() =>
      validateUploadRequest({
        folderPath: 'Members/ABM-000001',
        fileName: 'payload.exe',
        sizeBytes: 1000,
        contentType: 'application/x-msdownload',
      })
    ).toThrowError(UploadRejected);
  });

  it('refuses a file large enough to be a mistake', () => {
    expect(() =>
      validateUploadRequest({
        folderPath: 'Members/ABM-000001',
        fileName: 'huge.pdf',
        sizeBytes: 200 * 1024 * 1024,
        contentType: 'application/pdf',
      })
    ).toThrowError(/between 1 byte and/);
  });

  it('refuses a destination that tries to climb out of the folder', () => {
    expect(() =>
      validateUploadRequest({
        folderPath: 'Members/../../Finance',
        fileName: 'x.pdf',
        sizeBytes: 10,
        contentType: 'application/pdf',
      })
    ).toThrowError(/Invalid destination/);
  });
});

describe('sanitiseFileName', () => {
  it('strips a path so a name cannot choose its own folder', () => {
    expect(sanitiseFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitiseFileName('C:\\Users\\a\\id.jpg')).toBe('id.jpg');
  });

  it('removes characters SharePoint refuses', () => {
    expect(sanitiseFileName('my*file?.pdf')).toBe('myfile.pdf');
  });

  it('never returns an empty name', () => {
    expect(sanitiseFileName('***')).toBe('document');
    expect(sanitiseFileName('   ')).toBe('document');
  });

  it('keeps a leading dot from hiding the file', () => {
    expect(sanitiseFileName('.hidden.pdf')).toBe('hidden.pdf');
  });
});
