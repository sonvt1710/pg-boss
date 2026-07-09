import { describe, it } from 'vitest'
import { ctx, expect } from './hooks.ts'
import * as helper from './testHelper.ts'
import * as plans from '../src/plans.ts'
import Contractor from '../src/contractor.ts'
import packageJson from '../package.json' with { type: 'json' }

const schemaVersion = packageJson.pgboss.schema as number

describe('drift', function () {
  describe('expectedManagedIndexes (pure)', function () {
    it('non-partitioned puts the full job_iN set on the job table', function () {
      const expected = plans.expectedManagedIndexes(false, [])
      const names = expected.map(i => i.name)

      for (let n = 1; n <= 9; n++) {
        expect(names).toContain(`job_i${n}`)
      }
      expect(names).toContain('warning_i1')
      expect(names).toContain('queue_stats_i1')
      expect(names).toContain('job_dep_parent_idx')
      // no per-partition names
      expect(names.some(n => n.startsWith('job_common_'))).toBe(false)
    })

    it('partitioned puts the full set on job_common', function () {
      const names = plans.expectedManagedIndexes(true, []).map(i => i.name)

      for (let n = 1; n <= 9; n++) {
        expect(names).toContain(`job_common_i${n}`)
      }
      expect(names).not.toContain('job_i1')
    })

    it('a per-queue partition only carries the base set plus its policy index', function () {
      const names = plans.expectedManagedIndexes(true, [{ table: 'jabc', policy: 'short' }]).map(i => i.name)

      // base: throttle/fetch/group/blocking
      expect(names).toContain('jabc_i4')
      expect(names).toContain('jabc_i5')
      expect(names).toContain('jabc_i7')
      expect(names).toContain('jabc_i9')
      // short -> i1
      expect(names).toContain('jabc_i1')
      // other policy indexes absent
      expect(names).not.toContain('jabc_i2')
      expect(names).not.toContain('jabc_i3')
      expect(names).not.toContain('jabc_i6')
      expect(names).not.toContain('jabc_i8')
    })

    it('attaches the expected key-column list to each index', function () {
      const byName = new Map(plans.expectedManagedIndexes(true, []).map(i => [i.name, i]))
      expect(byName.get('job_common_i5')!.keys).toBe('name,start_after')
      expect(byName.get('job_common_i9')!.keys).toBe('name,id')
      expect(byName.get('job_common_i1')!.keys).toBe("name,coalesce(singleton_key,'')")
    })

    it('maps each policy to its own index', function () {
      const cases: Array<[string, string]> = [
        ['short', 'jx_i1'],
        ['singleton', 'jx_i2'],
        ['stately', 'jx_i3'],
        ['exclusive', 'jx_i6'],
        ['key_strict_fifo', 'jx_i8']
      ]
      for (const [policy, idx] of cases) {
        const names = plans.expectedManagedIndexes(true, [{ table: 'jx', policy }]).map(i => i.name)
        expect(names).toContain(idx)
      }
    })
  })

  describe('computeSchemaDrift (pure)', function () {
    const expected = [
      { name: 'job_common_i5', table: 'job_common' },
      { name: 'warning_i1', table: 'warning' }
    ]

    it('reports ok when the live catalog matches', function () {
      const live = [
        { name: 'job_common_i5', table: 'job_common', valid: true },
        { name: 'warning_i1', table: 'warning', valid: true }
      ]
      const report = plans.computeSchemaDrift(expected, live, [])
      expect(report.ok).toBe(true)
      expect(report.missing).toHaveLength(0)
    })

    it('flags a missing index', function () {
      const live = [{ name: 'warning_i1', table: 'warning', valid: true }]
      const report = plans.computeSchemaDrift(expected, live, [])
      expect(report.ok).toBe(false)
      expect(report.missing.map(i => i.name)).toEqual(['job_common_i5'])
    })

    it('treats a missing index with an incomplete BAM build as building, not missing', function () {
      const live = [{ name: 'warning_i1', table: 'warning', valid: true }]
      const bam = ['CREATE INDEX CONCURRENTLY job_common_i5 ON pgboss.job_common (name, start_after)']
      const report = plans.computeSchemaDrift(expected, live, bam)
      expect(report.missing).toHaveLength(0)
      expect(report.building.map(i => i.name)).toEqual(['job_common_i5'])
      // building alone is not drift
      expect(report.ok).toBe(true)
    })

    it('flags an invalid index', function () {
      const live = [
        { name: 'job_common_i5', table: 'job_common', valid: false },
        { name: 'warning_i1', table: 'warning', valid: true }
      ]
      const report = plans.computeSchemaDrift(expected, live, [])
      expect(report.ok).toBe(false)
      expect(report.invalid.map(i => i.name)).toEqual(['job_common_i5'])
    })

    it('flags an unexpected pg-boss-named index but ignores user indexes', function () {
      const live = [
        { name: 'job_common_i5', table: 'job_common', valid: true },
        { name: 'warning_i1', table: 'warning', valid: true },
        { name: 'job_common_i99', table: 'job_common', valid: true }, // stale managed-named
        { name: 'my_custom_lookup', table: 'job_common', valid: true } // user's own
      ]
      const report = plans.computeSchemaDrift(expected, live, [])
      expect(report.unexpected.map(i => i.name)).toEqual(['job_common_i99'])
    })
  })

  describe('indexKeys (pure)', function () {
    it('extracts and normalizes the key-column list', function () {
      expect(plans.indexKeys("CREATE UNIQUE INDEX job_i1 ON x.job (name, COALESCE(singleton_key, '')) WHERE state='created'"))
        .toBe("name,coalesce(singleton_key,'')")
    })

    it('normalizes a pg_get_indexdef form (casts, USING btree) to the same value', function () {
      expect(plans.indexKeys("CREATE UNIQUE INDEX job_i1 ON pgboss.job USING btree (name, COALESCE(singleton_key, ''::text)) WHERE (state = 'created')"))
        .toBe("name,coalesce(singleton_key,'')")
    })

    it('preserves column order (order is significant)', function () {
      const ab = plans.indexKeys('CREATE INDEX x ON s.t (a, b)')
      const ba = plans.indexKeys('CREATE INDEX x ON s.t (b, a)')
      expect(ab).not.toBe(ba)
    })

    it('returns empty when there is no key list or the parens are unbalanced', function () {
      expect(plans.indexKeys('CREATE INDEX x ON s.t')).toBe('')
      expect(plans.indexKeys('CREATE INDEX x ON s.t (a, b')).toBe('')
    })
  })

  describe('indexPredicate (pure)', function () {
    it('returns empty for a non-partial index', function () {
      expect(plans.indexPredicate('CREATE INDEX x ON s.t (a)')).toBe('')
    })

    it('normalizes a hand-written and a canonicalized predicate to the same value', function () {
      const expected = plans.indexPredicate("CREATE UNIQUE INDEX job_i1 ON x.job (name) WHERE state = 'created' AND policy = 'short'")
      const live = plans.indexPredicate("CREATE UNIQUE INDEX job_i1 ON s.job USING btree (name) WHERE ((state = 'created'::s.job_state) AND (policy = 'short'::text))")
      expect(live).toBe(expected)
    })

    it('folds IN (...) and = ANY (ARRAY[...]) to the same value', function () {
      const inForm = plans.indexPredicate("CREATE INDEX x ON s.t (a) WHERE state IN ('active', 'retry', 'failed')")
      const anyForm = plans.indexPredicate("CREATE INDEX x ON s.t (a) WHERE (state = ANY (ARRAY['active'::s.job_state, 'retry'::s.job_state, 'failed'::s.job_state]))")
      expect(anyForm).toBe(inForm)
    })

    it('treats different predicates as different', function () {
      const a = plans.indexPredicate("CREATE INDEX x ON s.t (a) WHERE state = 'active'")
      const b = plans.indexPredicate("CREATE INDEX x ON s.t (a) WHERE state = 'completed'")
      expect(a).not.toBe(b)
    })
  })

  describe('computeSchemaDrift definition-diff (pure)', function () {
    const expected = [{ name: 'job_common_i9', table: 'job_common', keys: 'name,id', predicate: "blockingandstate='completed'" }]

    it('reports ok when keys and predicate match', function () {
      const live = [{ name: 'job_common_i9', table: 'job_common', valid: true, def: "CREATE INDEX job_common_i9 ON pgboss.job_common USING btree (name, id) WHERE (blocking AND (state = 'completed'::pgboss.job_state))" }]
      const report = plans.computeSchemaDrift(expected, live, [])
      expect(report.ok).toBe(true)
      expect(report.mismatched).toHaveLength(0)
    })

    it('flags an index whose key columns are reordered', function () {
      const live = [{ name: 'job_common_i9', table: 'job_common', valid: true, def: "CREATE INDEX job_common_i9 ON pgboss.job_common USING btree (id, name) WHERE (blocking AND (state = 'completed'::pgboss.job_state))" }]
      const report = plans.computeSchemaDrift(expected, live, [])
      expect(report.ok).toBe(false)
      expect(report.mismatched).toHaveLength(1)
      expect(report.mismatched[0]).toMatchObject({ name: 'job_common_i9', actualKeys: 'id,name', differs: ['keys'] })
    })

    it('flags an index whose predicate differs', function () {
      const live = [{ name: 'job_common_i9', table: 'job_common', valid: true, def: "CREATE INDEX job_common_i9 ON pgboss.job_common USING btree (name, id) WHERE (blocking AND (state = 'active'::pgboss.job_state))" }]
      const report = plans.computeSchemaDrift(expected, live, [])
      expect(report.ok).toBe(false)
      expect(report.mismatched[0].differs).toEqual(['predicate'])
      expect(report.mismatched[0].actualPredicate).toBe("blockingandstate='active'")
    })

    it('flags an index whose keys AND predicate both differ', function () {
      const live = [{ name: 'job_common_i9', table: 'job_common', valid: true, def: "CREATE INDEX job_common_i9 ON pgboss.job_common USING btree (id, name) WHERE (blocking AND (state = 'active'::pgboss.job_state))" }]
      const report = plans.computeSchemaDrift(expected, live, [])
      expect(report.mismatched[0].differs).toEqual(['keys', 'predicate'])
    })

    it('does not flag when the live def is unparseable', function () {
      const live = [{ name: 'job_common_i9', table: 'job_common', valid: true, def: 'garbage' }]
      const report = plans.computeSchemaDrift(expected, live, [])
      expect(report.mismatched).toHaveLength(0)
    })

    it('treats an expected index without a predicate as non-partial', function () {
      const noPredicate = [{ name: 'x_i1', table: 't', keys: 'a' }]
      const live = [{ name: 'x_i1', table: 't', valid: true, def: 'CREATE INDEX x_i1 ON s.t USING btree (a)' }]
      const report = plans.computeSchemaDrift(noPredicate, live, [])
      expect(report.ok).toBe(true)
      expect(report.mismatched).toHaveLength(0)
    })

    it('skips the definition-diff for an expected index without a known key list', function () {
      const noKeys = [{ name: 'job_common_i9', table: 'job_common' }]
      const live = [{ name: 'job_common_i9', table: 'job_common', valid: true, def: 'CREATE INDEX job_common_i9 ON pgboss.job_common USING btree (id, name)' }]
      const report = plans.computeSchemaDrift(noKeys, live, [])
      expect(report.ok).toBe(true)
      expect(report.mismatched).toHaveLength(0)
    })

    it('reports an invalid index that a BAM row is rebuilding as building', function () {
      const live = [{ name: 'job_common_i9', table: 'job_common', valid: false, def: '' }]
      const bam = ['CREATE INDEX CONCURRENTLY job_common_i9 ON pgboss.job_common (name, id)']
      const report = plans.computeSchemaDrift(expected, live, bam)
      expect(report.invalid).toHaveLength(1)
      expect(report.invalid[0].building).toBe(true)
    })

    it('flags an unexpected index whose name matches a static managed name', function () {
      // job_dep_parent_idx does not match the _iN pattern, so this exercises the static-name branch.
      const live = [{ name: 'job_dep_parent_idx', table: 'job_dependency', valid: true, def: '' }]
      const report = plans.computeSchemaDrift([], live, [])
      expect(report.unexpected.map(i => i.name)).toEqual(['job_dep_parent_idx'])
    })
  })

  describe('bamCommandIndexName (pure)', function () {
    it('extracts the index name from CREATE INDEX variants', function () {
      expect(plans.bamCommandIndexName('CREATE INDEX CONCURRENTLY jabc_i5 ON s.t (a)')).toBe('jabc_i5')
      expect(plans.bamCommandIndexName('CREATE UNIQUE INDEX IF NOT EXISTS job_i1 ON s.t (a)')).toBe('job_i1')
      expect(plans.bamCommandIndexName('ANALYZE s.t')).toBe(null)
    })
  })

  describe('detectSchemaDrift (integration)', function () {
    it('reports ok for a freshly installed schema', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig })
      const report = await ctx.boss.detectSchemaDrift()
      expect(report.ok).toBe(true)
      expect(report.missing).toHaveLength(0)
      expect(report.invalid).toHaveLength(0)
      expect(report.unexpected).toHaveLength(0)
    })

    it('detects a dropped index as missing', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig })
      const schema = ctx.schema

      const db = await helper.getDb()
      // job_common exists in partitioned mode; job in non-partitioned. Drop the fetch index either way.
      const table = helper.isCockroachDb ? 'job' : 'job_common'
      await db.executeSql(`DROP INDEX ${schema}.${table}_i5`)
      await db.close()

      const report = await ctx.boss.detectSchemaDrift()
      expect(report.ok).toBe(false)
      expect(report.missing.map(i => i.name)).toContain(`${table}_i5`)
    })

    it('treats a missing index with a pending BAM build as building, not missing', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig })
      const schema = ctx.schema
      const table = helper.isCockroachDb ? 'job' : 'job_common'

      const db = await helper.getDb()
      await db.executeSql(`DROP INDEX ${schema}.${table}_i5`)
      await db.executeSql(
        `INSERT INTO ${schema}.bam (name, version, status, table_name, command)
         VALUES ($1, 27, 'pending', $2, $3)`,
        ['drift-build', table, `CREATE INDEX CONCURRENTLY ${table}_i5 ON ${schema}.${table} (name, start_after)`]
      )
      await db.close()

      const report = await ctx.boss.detectSchemaDrift()
      expect(report.building.map(i => i.name)).toContain(`${table}_i5`)
      expect(report.missing.map(i => i.name)).not.toContain(`${table}_i5`)
    })

    it('flags a stray pg-boss-named index as unexpected', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig })
      const schema = ctx.schema
      const table = helper.isCockroachDb ? 'job' : 'job_common'

      const db = await helper.getDb()
      await db.executeSql(`CREATE INDEX ${table}_i99 ON ${schema}.${table} (name)`)
      await db.close()

      const report = await ctx.boss.detectSchemaDrift()
      expect(report.unexpected.map(i => i.name)).toContain(`${table}_i99`)
    })

    it('detects an index whose key columns are reordered as mismatched', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig })
      const schema = ctx.schema
      const table = helper.isCockroachDb ? 'job' : 'job_common'

      const db = await helper.getDb()
      // Rebuild i9 (name, id) with the columns swapped, keeping the same partial predicate so it is a
      // valid, present index that differs only in key-column order.
      await db.executeSql(`DROP INDEX ${schema}.${table}_i9`)
      await db.executeSql(`CREATE INDEX ${table}_i9 ON ${schema}.${table} (id, name) WHERE blocking AND state = 'completed'`)
      await db.close()

      const report = await ctx.boss.detectSchemaDrift()
      expect(report.ok).toBe(false)
      expect(report.mismatched.map(i => i.name)).toContain(`${table}_i9`)
      const m = report.mismatched.find(i => i.name === `${table}_i9`)!
      expect(m.expectedKeys).toBe('name,id')
      expect(m.actualKeys).toBe('id,name')
    })

    it('detects an index whose predicate differs as mismatched', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig })
      const schema = ctx.schema
      const table = helper.isCockroachDb ? 'job' : 'job_common'

      const db = await helper.getDb()
      // Same key columns as i9, but a different partial predicate (state = 'active' not 'completed').
      await db.executeSql(`DROP INDEX ${schema}.${table}_i9`)
      await db.executeSql(`CREATE INDEX ${table}_i9 ON ${schema}.${table} (name, id) WHERE blocking AND state = 'active'`)
      await db.close()

      const report = await ctx.boss.detectSchemaDrift()
      expect(report.ok).toBe(false)
      const m = report.mismatched.find(i => i.name === `${table}_i9`)!
      expect(m).toBeTruthy()
      expect(m.differs).toEqual(['predicate'])
      expect(m.actualPredicate).toBe("blockingandstate='active'")
    })

    it('handles a non-partitioned schema and a missing bam table', async function () {
      // noTablePartitioning is forced false by Attorney on non-distributed backends, so build the
      // schema directly and drive a Contractor to cover detectDrift's non-partitioned branch (job
      // indexes live on `job`, no job_common) and the bam-table-absent fallback.
      const npSchema = `${ctx.schema}_np`
      const db = await helper.getDb()
      try {
        await db.executeSql(plans.create(npSchema, schemaVersion, { createSchema: true, noTablePartitioning: true }))
        await db.executeSql(`DROP TABLE ${npSchema}.bam`)

        const contractor = new Contractor(db, { schema: npSchema } as any)
        const report = await contractor.detectDrift()

        expect(report.ok).toBe(true)
        expect(report.missing).toHaveLength(0)
        expect(report.mismatched).toHaveLength(0)
      } finally {
        await db.executeSql(`DROP SCHEMA IF EXISTS ${npSchema} CASCADE`)
        await db.close()
      }
    })

    // key_strict_fifo exercises the gnarliest predicate (IN → = ANY (ARRAY[...])) on a dedicated
    // partition table, so this guards the predicate normalizer against false positives end-to-end.
    for (const policy of ['stately', 'key_strict_fifo'] as const) {
      it(`accounts for a partitioned ${policy} queue policy index without false drift`, async function () {
        if (helper.isCockroachDb) return // partitioning disabled on CockroachDB

        ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
        await ctx.boss.createQueue(ctx.schema, { policy, partition: true })

        const report = await ctx.boss.detectSchemaDrift()
        expect(report.ok).toBe(true)
        expect(report.missing).toHaveLength(0)
        expect(report.mismatched).toHaveLength(0)
      })
    }
  })
})
