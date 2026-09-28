import type { ErrorEvent } from '@sentry/node';
import { describe, expect, it } from 'vitest';
import { captureLogs } from '../../test/support/log-capture';
import {
  createErrorTracker,
  DISABLED_ERROR_TRACKER,
  scrubEvent,
} from './error-tracker';

// A session token's shape (header.payload.signature, base64url), and a
// personal access token's (closet_ + 43 base64url characters).
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOjcsInB3ZiI6ImFiY2RlZmdoIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ';
const PAT = 'closet_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbC';

function event(fields: Partial<ErrorEvent>): ErrorEvent {
  return { type: undefined, ...fields };
}

describe('scrubEvent', () => {
  it('drops the request whole: cookies, headers and bodies', () => {
    const scrubbed = scrubEvent(
      event({
        request: {
          url: '/auth/login',
          cookies: { access_token: JWT },
          headers: { cookie: `access_token=${JWT}`, authorization: 'x' },
          data: { email: 'owner@example.com', password: 'Password123!' },
        },
      }),
    );
    expect(scrubbed.request).toBeUndefined();
    expect(JSON.stringify(scrubbed)).not.toContain(JWT);
  });

  it('filters credentials out of every string', () => {
    const scrubbed = scrubEvent(
      event({
        message: `cookie access_token=${JWT}; theme=dark`,
        exception: {
          values: [
            {
              type: 'Error',
              value: `bad token ${JWT} and ${PAT}, Authorization: Bearer ${PAT}`,
            },
            {
              type: 'DrizzleQueryError',
              value:
                'Failed query: select 1 where email = $1\nparams: owner@example.com,$2b$10$hash',
            },
          ],
        },
      }),
    );
    const text = JSON.stringify(scrubbed);
    expect(text).not.toContain(JWT);
    expect(text).not.toContain(PAT.slice('closet_'.length));
    expect(text).not.toContain('owner@example.com');
    expect(scrubbed.message).toBe('cookie access_token=[Filtered]; theme=dark');
    expect(scrubbed.exception?.values?.[1].value).toBe(
      'Failed query: select 1 where email = $1\nparams: [Filtered]',
    );
  });

  it('filters secret keys wherever they are', () => {
    const scrubbed = scrubEvent(
      event({
        contexts: {
          upstream: { headers: { Cookie: 'a=b', Authorization: 'Basic x' } },
        },
        extra: { form: { currentPassword: 'hunter2', note: 'kept' } },
        tags: { route: '/wardrobe/:id' },
      }),
    );
    expect(scrubbed.contexts).toEqual({
      upstream: {
        headers: { Cookie: '[Filtered]', Authorization: '[Filtered]' },
      },
    });
    expect(scrubbed.extra).toEqual({
      form: { currentPassword: '[Filtered]', note: 'kept' },
    });
    expect(scrubbed.tags).toEqual({ route: '/wardrobe/:id' });
  });
});

describe('createErrorTracker', () => {
  it('is a no-op without a DSN', () => {
    expect(
      createErrorTracker({
        dsn: '',
        release: undefined,
        environment: 'test',
        logger: captureLogs().logger,
      }),
    ).toBe(DISABLED_ERROR_TRACKER);
  });
});
