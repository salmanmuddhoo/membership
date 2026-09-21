// How a SharePoint failure is reported (M4).
//
// The point of these is not the Graph protocol — upload.test.ts covers that.
// It is that an environment which has not been set up, and credentials that no
// longer work, are told apart from each other and from a defect. An officer
// who sees "something went wrong" cannot tell whether to retry, change their
// file, or find an administrator.
import { afterEach, describe, expect, it } from 'vitest';

const GRAPH_VARS = [
  'GRAPH_TENANT_ID',
  'GRAPH_CLIENT_ID',
  'GRAPH_CLIENT_SECRET',
  'GRAPH_DRIVE_ID',
] as const;

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

async function load() {
  return import('./graph');
}

function configure(overrides: Partial<Record<string, string>> = {}) {
  process.env.GRAPH_TENANT_ID = 'tenant';
  process.env.GRAPH_CLIENT_ID = 'client';
  process.env.GRAPH_CLIENT_SECRET = 'secret';
  process.env.GRAPH_DRIVE_ID = 'drive';
  Object.assign(process.env, overrides);
}

describe('an environment where SharePoint has not been set up', () => {
  it('says so, rather than failing as though something broke', async () => {
    const { getGraphConfig, GraphError } = await load();
    for (const name of GRAPH_VARS) delete process.env[name];

    try {
      getGraphConfig();
      expect.unreachable('getGraphConfig should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(GraphError);
      expect((error as InstanceType<typeof GraphError>).reason).toBe(
        'not_configured'
      );
    }
  });

  // Half-configured is the state an operator most often lands in, and it must
  // read the same as not configured at all rather than reaching Microsoft with
  // a blank tenant.
  it.each(GRAPH_VARS)('treats a missing %s the same way', async name => {
    const { getGraphConfig, GraphError } = await load();
    configure();
    delete process.env[name];

    expect(() => getGraphConfig()).toThrowError(GraphError);
  });

  it('accepts a complete configuration', async () => {
    const { getGraphConfig } = await load();
    configure();

    expect(getGraphConfig()).toMatchObject({
      tenantId: 'tenant',
      driveId: 'drive',
      graphBaseUrl: 'https://graph.microsoft.com/v1.0',
    });
  });
});

describe('what the person filing a document is told', () => {
  it('names the setup that is missing, without naming a secret', async () => {
    const { GraphError, graphFailureMessage } = await load();
    const message = graphFailureMessage(
      new GraphError('GRAPH_CLIENT_SECRET=hunter2 is absent', 'not_configured')
    );

    expect(message).toMatch(/not configured/i);
    expect(message).toMatch(/administrator/i);
    // The underlying text belongs in the log, never in a response.
    expect(message).not.toContain('hunter2');
  });

  it('distinguishes credentials that no longer work', async () => {
    const { GraphError, graphFailureMessage } = await load();
    const message = graphFailureMessage(
      new GraphError('AADSTS7000215: invalid client secret', 'auth_failed', 401)
    );

    expect(message).toMatch(/could not sign in/i);
    expect(message).not.toContain('AADSTS7000215');
  });

  it('reports a refusal by the library as the library’s, not the file’s', async () => {
    const { GraphError, graphFailureMessage } = await load();
    const message = graphFailureMessage(
      new GraphError(
        'Graph item lookup failed (403): denied',
        'request_failed',
        403
      )
    );

    expect(message).toContain('403');
    expect(message).toMatch(/rather than with what you were filing/i);
  });
});
