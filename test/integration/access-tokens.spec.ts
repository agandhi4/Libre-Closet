import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { personalAccessToken } from '../../src/db/schema';
import {
  createToken,
  hashToken,
  MAX_ACTIVE_TOKENS,
} from '../../src/web/auth/personal-tokens';
import { createTestApp, type TestApp, unescapeHtml, userIdOf } from './harness';
import { createAccessToken } from './mcp';
import { expectNativePostForms } from './pages';

/**
 * The profile's Agent access page (#33): personal access tokens for the MCP
 * endpoint, created (shown once), listed by name and prefix, and revoked.
 * Only a hash is stored; nobody reaches another user's tokens.
 */
describe('agent access tokens', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  const page = () => t.inject({ method: 'GET', url: '/auth/tokens' });

  it('is linked from the profile', async () => {
    const res = await t.inject({ method: 'GET', url: '/auth/profile' });
    expect(res.body).toContain('href="/auth/tokens"');
  });

  it('shows a new token once, with the command that connects Claude Code', async () => {
    const res = await t.inject({
      method: 'POST',
      url: '/auth/tokens',
      payload: { name: 'Laptop' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expectNativePostForms(res);
    const token = /closet_[A-Za-z0-9_-]{43}/.exec(res.body)![0];
    expect(unescapeHtml(res.body)).toContain(
      `claude mcp add --transport http closet http://localhost:3000/mcp --header "Authorization: Bearer ${token}"`,
    );

    const [row] = await t.db
      .select()
      .from(personalAccessToken)
      .where(eq(personalAccessToken.name, 'Laptop'));
    expect(row.tokenHash).toBe(hashToken(token));
    expect(row.tokenHash).not.toContain(token);
    expect(row.tokenPrefix).toBe(token.slice(0, 11));

    const listed = await page();
    expect(listed.body).toContain('Laptop');
    expect(listed.body).toContain(`${token.slice(0, 11)}…`);
    expect(listed.body).not.toContain(token);
  });

  it('asks for a name', async () => {
    const res = await t.inject({
      method: 'POST',
      url: '/auth/tokens',
      payload: { name: '   ' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toMatch(/closet_[A-Za-z0-9_-]{43}/);
  });

  it('revokes a token of one’s own, and 404s anyone else’s', async () => {
    const cookie = await t.register('other@example.com');
    await createAccessToken(t, { cookie, name: 'Theirs' });
    const [theirs] = await t.db
      .select({ id: personalAccessToken.id })
      .from(personalAccessToken)
      .where(eq(personalAccessToken.name, 'Theirs'));
    const refused = await t.inject({
      method: 'POST',
      url: `/auth/tokens/${theirs.id}/revoke`,
    });
    expect(refused.statusCode).toBe(404);
    expect(refused.body).not.toContain('Theirs');

    const res = await t.inject({
      method: 'POST',
      url: `/auth/tokens/${theirs.id}/revoke`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/auth/tokens?revoked=1');
    const [row] = await t.db
      .select({ revokedAt: personalAccessToken.revokedAt })
      .from(personalAccessToken)
      .where(eq(personalAccessToken.id, theirs.id));
    expect(row.revokedAt).not.toBeNull();
    // Revoked is gone from the list, and a second revoke finds nothing.
    const listed = await t.inject({
      method: 'GET',
      url: '/auth/tokens',
      headers: { cookie },
    });
    expect(listed.body).not.toContain('Theirs');
    const again = await t.inject({
      method: 'POST',
      url: `/auth/tokens/${theirs.id}/revoke`,
      headers: { cookie },
    });
    expect(again.statusCode).toBe(404);
  });

  it(`stops at ${MAX_ACTIVE_TOKENS} tokens in force`, async () => {
    // Straight through the writer: the page is rate limited like the other
    // account writes (ACCOUNT_LIMIT, 5 a minute).
    const cookie = await t.register('busy@example.com');
    const id = await userIdOf(t, 'busy@example.com');
    for (let n = 0; n < MAX_ACTIVE_TOKENS; n += 1) {
      await createToken(t.db, id, `Token ${n}`);
    }
    const res = await t.inject({
      method: 'POST',
      url: '/auth/tokens',
      payload: { name: 'One more' },
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toMatch(/closet_[A-Za-z0-9_-]{43}/);
  });
});
