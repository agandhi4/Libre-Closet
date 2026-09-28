import { sql } from 'drizzle-orm';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { claimNextCutout } from '../../src/cutout/queries';
import {
  parseStoredName,
  variantFileName,
} from '../../src/web/files/image-variant';
import { halfMask, MASK_SIZE, storedCutout, variantPath } from './cutouts';
import {
  createGarment,
  jpegPhoto,
  photoFileName,
  photoRow,
  pngCutout,
  uploadPhoto,
} from './garments';
import { createTestApp, type TestApp } from './harness';

/** The deferred trigger's refusal, as drizzle reports a failed COMMIT. */
const COMMIT_REFUSED = {
  cause: expect.objectContaining({
    message: expect.stringMatching(/COMMIT refused/),
  }),
};

/**
 * A cutout's bytes are stored before its row is locked, under a variant
 * key of their own, and the transaction only swaps the row's key and
 * version (#141, Photos.writeCutout). These cases hold the row, the file
 * served and the files on disk to one another: through a failed COMMIT,
 * and through writers racing for one photo, where exactly the row's set
 * stays on disk.
 */
describe('cutout writes outside the row lock', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    // A COMMIT that fails after the swap's UPDATE ran: a deferred
    // constraint trigger raising for the names listed in the table.
    await t.db.execute(
      sql`create table spec_refused_commit (file_name text primary key)`,
    );
    await t.db.execute(sql`
      create function spec_refuse_commit() returns trigger language plpgsql as $$
      begin
        if exists (select 1 from spec_refused_commit where file_name = new.file_name) then
          raise exception 'spec: COMMIT refused for %', new.file_name;
        end if;
        return new;
      end $$`);
    await t.db.execute(sql`
      create constraint trigger spec_refuse_commit after update on file
      deferrable initially deferred for each row
      execute function spec_refuse_commit()`);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await t.db.execute(sql`delete from spec_refused_commit`);
  });

  afterAll(() => t?.cleanup());

  /** A garment with a stored photo, queued (pending) by its upload. */
  async function photo(name: string) {
    const garmentId = await createGarment(t, { name });
    await uploadPhoto(t, garmentId, await jpegPhoto(1200, 800));
    return photoFileName(t, garmentId);
  }

  /** Every keyed variant file of the photo on disk. */
  async function keyedFiles(fileName: string): Promise<string[]> {
    return (await readdir(t.dataPath))
      .filter((name) => {
        const parsed = parseStoredName(name);
        return parsed?.baseName === fileName && parsed.variantKey !== null;
      })
      .sort();
  }

  /** The nobg and thumb the row points at, and nothing else keyed. */
  async function expectOnlyTheRowsSet(fileName: string): Promise<void> {
    const row = await photoRow(t, fileName);
    expect(row?.variantKey).toMatch(/^[0-9a-f]{12}$/);
    expect(await keyedFiles(fileName)).toEqual(
      [
        variantFileName(fileName, 'nobg', row!.variantKey),
        variantFileName(fileName, 'thumb', row!.variantKey),
      ].sort(),
    );
    const served = await t.inject({
      method: 'GET',
      url: `/file/nobg/${fileName}?v=${row!.version}`,
      anonymous: true,
    });
    expect(served.statusCode).toBe(200);
    expect(
      served.rawPayload.equals(
        await readFile(await variantPath(t, fileName, 'nobg')),
      ),
    ).toBe(true);
  }

  const edit = async (fileName: string, width = 600) =>
    t.photos.saveEditedCutout(
      Readable.from(await pngCutout(width, 400)),
      fileName,
    );

  it('never holds the row lock while the files are written', async () => {
    const fileName = await photo('Slow storage shirt');
    let lockedDuringStore: boolean | undefined;
    const store = t.photos.storage.store.bind(t.photos.storage);
    vi.spyOn(t.photos.storage, 'store').mockImplementation(
      async (name, stream) => {
        // What a slow NFS write would find: can another session lock the row?
        lockedDuringStore = await t.db
          .execute(
            sql`select id from file where file_name = ${fileName} for update nowait`,
          )
          .then(
            () => false,
            () => true,
          );
        return store(name, stream);
      },
    );

    await expect(edit(fileName)).resolves.toBe(2);
    expect(lockedDuringStore).toBe(false);
    await expectOnlyTheRowsSet(fileName);
  });

  it('leaves the row and the served cutout as they were when the COMMIT fails, and deletes the orphans', async () => {
    const fileName = await photo('Refused commit shirt');
    await expect(edit(fileName, 600)).resolves.toBe(2);
    const before = await photoRow(t, fileName);
    const servedBefore = await storedCutout(t, fileName);

    await t.db.execute(
      sql`insert into spec_refused_commit (file_name) values (${fileName})`,
    );
    t.logs.clear();
    await expect(edit(fileName, 500)).rejects.toMatchObject(COMMIT_REFUSED);

    // The row still names the first cutout, which is still what is served.
    expect(await photoRow(t, fileName)).toMatchObject({
      version: 2,
      cutoutStatus: 'edited',
      variantKey: before!.variantKey,
    });
    expect((await storedCutout(t, fileName))!.equals(servedBefore!)).toBe(true);
    await expectOnlyTheRowsSet(fileName);
    expect(t.logs.records).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        msg: expect.stringMatching(/swap to key [0-9a-f]{12} rolled back$/),
        err: expect.objectContaining({
          message: expect.stringContaining('commit'),
        }),
      }),
    );
    expect(t.logs.messages('info', 'Photos')).toContainEqual(
      expect.stringMatching(
        /^Deleted .*-nobg-[0-9a-f]{12}\.webp and .*-thumb-[0-9a-f]{12}\.webp: its swap rolled back$/,
      ),
    );
  });

  it('leaves a queued photo queued when a job result cannot commit', async () => {
    const fileName = await photo('Refused job shirt');
    const job = await claimNextCutout(t.db, 'spec:1:00000000');
    expect(job?.fileName).toBe(fileName);
    await t.db.execute(
      sql`insert into spec_refused_commit (file_name) values (${fileName})`,
    );

    await expect(
      t.photos.saveModelCutout(
        fileName,
        halfMask(),
        MASK_SIZE,
        job!.jobVersion,
      ),
    ).rejects.toMatchObject(COMMIT_REFUSED);

    expect(await photoRow(t, fileName)).toMatchObject({
      version: 1,
      cutoutStatus: 'pending',
      variantKey: null,
    });
    expect(await keyedFiles(fileName)).toEqual([]);
    // The original is still what the cutout URL serves.
    const served = await t.inject({
      method: 'GET',
      url: `/file/nobg/${fileName}?v=1`,
      anonymous: true,
    });
    expect(
      served.rawPayload.equals(await readFile(join(t.dataPath, fileName))),
    ).toBe(true);
  });

  it('lets exactly one of two results for one job land', async () => {
    const inverted = Buffer.from(halfMask().map((alpha) => 255 - alpha));
    for (let round = 0; round < 4; round++) {
      const fileName = await photo(`Raced job ${round}`);
      const job = await claimNextCutout(t.db, 'spec:1:00000000');
      expect(job?.fileName).toBe(fileName);

      const outcomes = await Promise.all(
        [halfMask(), inverted].map((mask) =>
          t.photos.saveModelCutout(fileName, mask, MASK_SIZE, job!.jobVersion),
        ),
      );

      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
      expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([
        { ok: false, reason: 'not-allowed' },
      ]);
      expect(await photoRow(t, fileName)).toMatchObject({
        version: job!.jobVersion + 1,
        cutoutStatus: 'ready',
      });
      await expectOnlyTheRowsSet(fileName);
    }
  });

  it('applies concurrent mask edits one after another, keeping only the last set', async () => {
    const fileName = await photo('Many edits shirt');
    const versions = await Promise.all(
      [300, 400, 500, 600, 700].map((width) => edit(fileName, width)),
    );

    expect(versions.sort()).toEqual([2, 3, 4, 5, 6]);
    expect(await photoRow(t, fileName)).toMatchObject({
      version: 6,
      cutoutStatus: 'edited',
    });
    await expectOnlyTheRowsSet(fileName);
    // The unkeyed thumb the upload made went with the first swap.
    expect(
      (await readdir(t.dataPath)).includes(variantFileName(fileName, 'thumb')),
    ).toBe(false);
  });

  it("never lets a job's result replace a mask saved while it raced", async () => {
    for (let round = 0; round < 4; round++) {
      const fileName = await photo(`Edit against job ${round}`);
      const job = await claimNextCutout(t.db, 'spec:1:00000000');
      expect(job?.fileName).toBe(fileName);

      const [edited, result] = await Promise.all([
        edit(fileName),
        t.photos.saveModelCutout(
          fileName,
          halfMask(),
          MASK_SIZE,
          job!.jobVersion,
        ),
      ]);

      // Whichever committed first, the user's mask is what stays.
      expect(edited).toBeDefined();
      expect(await photoRow(t, fileName)).toMatchObject({
        cutoutStatus: 'edited',
        version: result.ok ? 3 : 2,
      });
      await expectOnlyTheRowsSet(fileName);
    }
  });
});
