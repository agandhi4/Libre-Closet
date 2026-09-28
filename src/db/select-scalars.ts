import { type SQL, sql } from 'drizzle-orm';
import type { Queryable } from './client';

/** Each column's value; undefined for a column that may be left out. */
type ScalarValues<T extends Record<string, SQL | undefined>> = {
  [K in keyof T]: T[K] extends SQL<infer V>
    ? V
    : T[K] extends SQL<infer V> | undefined
      ? V | undefined
      : never;
};

/**
 * Reads independent scalar subqueries in one round trip: `select (...) as
 * "a", (...) as "b"`, one row, no FROM. For a page's counts and short lists
 * that share no rows (the wardrobe grid's, gridContext in
 * src/web/wardrobe/grid-context.ts): production reaches Postgres over a
 * link where each statement costs a round trip (#156), so reads that would
 * each be a statement ride in one. Each column is a whole subquery, so a
 * column it names belongs to its own FROM, never another's; a list is a
 * JSON value (`json_agg`), a count needs `::int` (node-postgres answers a
 * bigint as a string). A column given as undefined is not read (its value
 * is undefined), and with none left nothing is sent.
 */
export async function selectScalars<T extends Record<string, SQL | undefined>>(
  db: Queryable,
  columns: T,
): Promise<ScalarValues<T>> {
  const list = Object.entries(columns).flatMap(([name, value]) =>
    value === undefined ? [] : [sql`${value} as ${sql.identifier(name)}`],
  );
  if (list.length === 0) return {} as ScalarValues<T>;
  // The row's types are each column's SQL<T>, as with any raw statement.
  const { rows } = await db.execute(sql`select ${sql.join(list, sql`, `)}`);
  return rows[0] as ScalarValues<T>;
}
