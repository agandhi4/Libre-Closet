import type { Logger } from '../../logger';
import { type Location, locationLabel } from '../../weather/location';
import { OutboundFetchError } from '../security/outbound-fetch';
import type { CacheRow } from './queries';

/**
 * One cache of Open-Meteo answers keyed by rounded location, in a table
 * (service.ts: the forecast, weather_forecast; the climate normals,
 * weather_normals). The discipline both share, so it lives once:
 * - an answer younger than `freshForMs` is served from the row;
 * - an older one is served at once and refreshed in the background (#114):
 *   the first page after the hour must not wait for Open-Meteo. Only a cold
 *   miss (no answer kept) waits, for at most the fetcher's bound;
 * - a failed refresh keeps the last good answer and records the attempt, so
 *   the provider is asked again only `retryAfterMs` later;
 * - one refresh per location at a time in this process, and no read of the
 *   row while one runs: an ask meanwhile is served the answer the refresh
 *   started from (or joins it, on a cold miss), so an ask that read the
 *   stale row just before the refresh saved can never fetch again. The pages
 *   of one household ask for the same place together. Across processes a
 *   duplicate fetch is harmless.
 * A page is the same whether the refresh succeeds, fails or is still
 * running: it shows what it was served, and the next ask the new answer.
 *
 * Logs name the rounded location (`Forecast for 40.69,-73.97: ...`), never
 * the user: a refresh's start, then its outcome with its duration.
 */

export interface Cached<T> {
  value: T;
  /** When the answer was fetched: the "as of" the pages show. */
  fetchedAt: Date;
}

export interface LocationCacheOptions<T> {
  /** What the logs call it: "Forecast", "Climate normals". */
  name: string;
  freshForMs: number;
  retryAfterMs: number;
  now: () => Date;
  logger: Logger;
  read(location: Location): Promise<CacheRow<T> | undefined>;
  save(location: Location, value: T, at: Date): Promise<void>;
  recordFailure(location: Location, at: Date): Promise<void>;
  fetch(location: Location): Promise<T>;
  /** The answer's size for the log line: "16 days". */
  describe(value: T): string;
}

export interface LocationCache<T> {
  /**
   * The location's kept answer, stale or not (a stale one starts a
   * background refresh); the provider's, waited for, when none is kept;
   * null if the provider never answered.
   */
  get(location: Location): Promise<Cached<T> | null>;
  /**
   * Resolves once no refresh is running. The app's close awaits it before
   * ending the pool (a background refresh still has a row to save); specs
   * await it to see what a refresh stored.
   */
  settled(): Promise<void>;
}

/** A refresh under way: the answer it started from, and its outcome. */
interface Refresh<T> {
  kept: Cached<T> | null;
  /** Never rejects: a failure is logged and resolves to `kept`. */
  done: Promise<Cached<T> | null>;
}

export function createLocationCache<T>(
  options: LocationCacheOptions<T>,
): LocationCache<T> {
  const { name, now, logger } = options;
  // Both keyed by locationLabel. `reading` holds the row's read and the
  // decision, `refreshing` the fetch and save the decision started. An ask
  // looks in `refreshing` first, and a lookup enters its refresh there before
  // its own promise settles, so no ask reads the row while a refresh runs.
  const reading = new Map<string, Promise<Cached<T> | null>>();
  const refreshing = new Map<string, Refresh<T>>();

  async function lookup(location: Location): Promise<Cached<T> | null> {
    const row = await options.read(location);
    const at = now().getTime();
    const kept = lastGood(row);
    if (kept && at - kept.fetchedAt.getTime() < options.freshForMs) {
      return kept;
    }
    // A refresh failed a moment ago: do not ask again yet.
    if (
      row &&
      at - row.attemptedAt.getTime() < options.retryAfterMs &&
      row.attemptedAt.getTime() !== row.fetchedAt?.getTime()
    ) {
      return kept;
    }
    const { done } = startRefresh(location, kept);
    return kept ?? done;
  }

  function startRefresh(
    location: Location,
    kept: Cached<T> | null,
  ): Refresh<T> {
    const key = locationLabel(location);
    logger.info(
      `${name} for ${key}: refreshing; ${
        kept
          ? `serving the one from ${kept.fetchedAt.toISOString()} meanwhile`
          : 'none kept, the ask waits'
      }`,
    );
    const running: Refresh<T> = {
      kept,
      done: refresh(location, kept).finally(() => refreshing.delete(key)),
    };
    refreshing.set(key, running);
    return running;
  }

  async function refresh(
    location: Location,
    kept: Cached<T> | null,
  ): Promise<Cached<T> | null> {
    const label = locationLabel(location);
    const started = performance.now();
    try {
      const value = await options.fetch(location);
      const fetchedAt = now();
      await options.save(location, value, fetchedAt);
      logger.info(
        `${name} for ${label}: ${options.describe(value)} in ${elapsed(started)} ms`,
      );
      return { value, fetchedAt };
    } catch (error) {
      logger.warn(
        `${name} for ${label} failed (${failureReason(error)}) after ${elapsed(started)} ms; ${
          kept
            ? `serving the one from ${kept.fetchedAt.toISOString()}`
            : 'none to serve'
        }`,
      );
      // Nobody awaits a background refresh, so it must never reject: an
      // unhandled rejection ends the process.
      await options.recordFailure(location, now()).catch((failure: unknown) => {
        logger.error(
          { err: failure },
          `${name} for ${label}: recording the failed attempt failed`,
        );
      });
      return kept;
    }
  }

  return {
    get(location) {
      const key = locationLabel(location);
      const running = refreshing.get(key);
      if (running) {
        return running.kept ? Promise.resolve(running.kept) : running.done;
      }
      const looking = reading.get(key);
      if (looking) return looking;
      const read = lookup(location).finally(() => reading.delete(key));
      reading.set(key, read);
      return read;
    },

    async settled() {
      while (refreshing.size > 0) {
        await Promise.all([...refreshing.values()].map(({ done }) => done));
      }
    },
  };
}

function lastGood<T>(row: CacheRow<T> | undefined): Cached<T> | null {
  return row?.value && row.fetchedAt
    ? { value: row.value, fetchedAt: row.fetchedAt }
    : null;
}

/** The refusal's rule or the error's name, for the log; never a URL. */
export function failureReason(error: unknown): string {
  if (error instanceof OutboundFetchError) return error.reason;
  return error instanceof Error ? error.name : 'unknown';
}

export function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}
