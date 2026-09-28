import {
  contextLinesIntegration,
  dedupeIntegration,
  defaultStackParser,
  type ErrorEvent,
  linkedErrorsIntegration,
  makeNodeTransport,
  NodeClient,
  nodeContextIntegration,
  Scope,
} from '@sentry/node';
import type { Logger } from '../logger';
import { SESSION_COOKIE } from '../web/auth/session';
import { TOKEN_PREFIX } from '../web/auth/personal-tokens';

/**
 * Error tracking (#117): the process's failures, sent to the homelab's
 * Bugsink (Sentry-compatible, `SENTRY_DSN`, the tracker finplat reports to).
 * Only with a DSN: without one `createErrorTracker` answers a tracker that
 * does nothing, and nothing of Sentry's runs.
 *
 * Captured at single choke points, never ad hoc: the error handler's
 * unexpected 500s (src/web/errors.tsx), and every failure outcome the
 * metrics record (a job, a push send, an MCP tool: src/metrics/metrics.ts),
 * plus the pages' script errors (POST /errors/client). Each capture names
 * its `source` and a few bounded tags (a route template, a job or tool
 * name), never a URL, header or body.
 *
 * One client per app, never Sentry's global one (`Sentry.init`): the
 * integration specs boot many apps in one process, as the metrics keep one
 * registry per app. So there are no automatic integrations either (no HTTP
 * or console breadcrumbs, no request data, no process handlers): an event
 * holds the error, its stack and what the capture named, and `scrubEvent`
 * is the net under all of it.
 */

/** Where an error was captured: a tag, so Bugsink can filter by it. */
export type ErrorSource = 'route' | 'job' | 'push' | 'mcp' | 'client';

export interface ErrorContext {
  source: ErrorSource;
  /** Values from a closed set only: a route template, a method, a job or tool name. */
  tags?: Record<string, string>;
  userId?: number;
}

/** What a page's script reported (public/js/errors.js), validated by its route. */
export interface ClientErrorReport {
  message: string;
  stack?: string;
  /** A route template this app has; absent when the page named none. */
  route?: string;
  /** The release the page was served by (a cached page may be older). */
  release?: string;
}

export interface ErrorTracker {
  /** SENTRY_DSN was set: the tracker sends, and the pages' beacon exists. */
  readonly enabled: boolean;
  captureException(error: unknown, context: ErrorContext): void;
  captureClientError(report: ClientErrorReport, userId: number): void;
  /** Sends what is queued (up to `timeoutMs`), then stops. createApp's onClose. */
  close(timeoutMs?: number): Promise<void>;
}

/** No DSN: nothing is captured or sent. Also what unit specs pass to Metrics. */
export const DISABLED_ERROR_TRACKER: ErrorTracker = {
  enabled: false,
  captureException() {},
  captureClientError() {},
  close: () => Promise.resolve(),
};

export interface ErrorTrackerOptions {
  /** SENTRY_DSN; empty means off. */
  dsn: string;
  /** The image's full git sha (BUILD_INFO.sha); unknown in development. */
  release: string | undefined;
  /** NODE_ENV: production, development or test. */
  environment: string;
  /** Context ErrorTracking: the tracker's own troubles (Bugsink unreachable). */
  logger: Logger;
}

const CLOSE_TIMEOUT_MS = 2_000;

export function createErrorTracker({
  dsn,
  release,
  environment,
  logger,
}: ErrorTrackerOptions): ErrorTracker {
  if (!dsn) return DISABLED_ERROR_TRACKER;

  const client = new NodeClient({
    dsn,
    release,
    environment,
    // Errors only, every one of them; no tracing, no sessions, no client
    // reports. Bugsink supports none of the rest (finplat's settings).
    sampleRate: 1,
    sendDefaultPii: false,
    sendClientReports: false,
    maxBreadcrumbs: 0,
    stackParser: defaultStackParser,
    transport: (options) => {
      const transport = makeNodeTransport(options);
      return {
        ...transport,
        send: async (envelope) => {
          try {
            const response = await transport.send(envelope);
            const status = response.statusCode ?? 0;
            if (status >= 400) {
              logger.warn(`Bugsink refused an event: HTTP ${status}`);
            }
            return response;
          } catch (error) {
            logger.warn(
              `Could not send an event to Bugsink: ${error instanceof Error ? error.message : String(error)}`,
            );
            throw error;
          }
        },
      };
    },
    integrations: [
      dedupeIntegration(),
      linkedErrorsIntegration(),
      nodeContextIntegration(),
      contextLinesIntegration(),
    ],
    beforeSend: scrubEvent,
  });
  const base = new Scope();
  base.setClient(client);
  client.init();

  function scopeFor({ source, tags, userId }: ErrorContext): Scope {
    const scope = base.clone();
    scope.setTags({ source, ...tags });
    if (userId !== undefined) scope.setUser({ id: String(userId) });
    return scope;
  }

  return {
    enabled: true,
    captureException(error, context) {
      // Through the scope, not the client: it hands the integrations the
      // original error (linkedErrors follows its `cause`, where Drizzle keeps
      // Postgres's own error).
      scopeFor(context).captureException(error);
    },
    captureClientError(
      { message, stack, route, release: pageRelease },
      userId,
    ) {
      // The page's stack as it sent it: the Node parser reads Chromium's
      // frames; Safari's and Firefox's stay whole in the `client` context.
      const error = new Error(message);
      error.name = 'ClientError';
      error.stack = stack ?? '';
      const scope = scopeFor({
        source: 'client',
        tags: { route: route ?? 'unknown' },
        userId,
      });
      if (stack) scope.setContext('client', { stack });
      if (pageRelease) {
        scope.addEventProcessor((event) => ({
          ...event,
          release: pageRelease,
        }));
      }
      scope.captureException(error);
    },
    async close(timeoutMs = CLOSE_TIMEOUT_MS) {
      await client.close(timeoutMs);
    },
  };
}

const FILTERED = '[Filtered]';

// Keys whose value is a credential wherever they appear in an event (a
// header, a context, an error's property), matched lowercased.
const SECRET_KEYS = new Set([
  'cookie',
  'cookies',
  'set-cookie',
  'authorization',
  'proxy-authorization',
  SESSION_COOKIE,
  'password',
  'currentpassword',
  'newpassword',
  'confirmpassword',
  'token',
  'secret',
]);

// Credentials inside any string of an event (an error message, a stack's
// context, a client report). Closet leaked session JWTs to Loki once
// (docs/audits/2026-09-25-closet-stack-and-backups.md): the session token is
// a JWT, so every JWT goes, whatever carried it.
const SECRET_PATTERNS: [RegExp, string][] = [
  [/eyJ[\w-]*\.[\w-]+\.[\w-]*/g, FILTERED],
  [
    new RegExp(`\\b${SESSION_COOKIE}=[^;\\s"']*`, 'g'),
    `${SESSION_COOKIE}=${FILTERED}`,
  ],
  [new RegExp(`\\b${TOKEN_PREFIX}[\\w-]+`, 'g'), `${TOKEN_PREFIX}${FILTERED}`],
  [/\bBearer\s+[^\s"']+/gi, `Bearer ${FILTERED}`],
  // Drizzle's failed-query message ends with the query's parameters: what
  // a user sent (an email, a hash, a note), never needed to group an error.
  [/\nparams: [\s\S]*$/, `\nparams: ${FILTERED}`],
];

function scrubString(value: string): string {
  return SECRET_PATTERNS.reduce(
    (scrubbed, [pattern, replacement]) =>
      scrubbed.replace(pattern, replacement),
    value,
  );
}

function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        SECRET_KEYS.has(key.toLowerCase()) ? FILTERED : scrubValue(inner),
      ]),
    );
  }
  return value;
}

/**
 * The tracker's beforeSend: no event leaves with a cookie, an Authorization
 * header, a session JWT, a personal access token or a request body. Closet
 * never attaches the request (a capture tags its route template), so any
 * `request` is dropped whole, bodies of the auth routes included; every
 * other string and key in the event is scrubbed.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const scrubbed = scrubValue(event) as ErrorEvent;
  delete scrubbed.request;
  return scrubbed;
}
