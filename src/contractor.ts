import assert from 'node:assert'
import * as plans from './plans.ts'
import * as drifter from './drifter.ts'
import * as migrationStore from './migrationStore.ts'
import packageJson from '../package.json' with { type: 'json' }
import type * as types from './types.ts'

const schemaVersion = packageJson.pgboss.schema as number

class Contractor {
  static constructionPlans (schema = plans.DEFAULT_SCHEMA, options = { createSchema: true }) {
    return plans.create(schema, schemaVersion, options)
  }

  static migrationPlans (schema = plans.DEFAULT_SCHEMA, version = schemaVersion - 1, options: { partitionTables?: string[] } = {}) {
    // Exported plans run without a BAM worker, so inline the async index builds as direct
    // DDL rather than job_table_run_async() enqueues (see issue #766). Callers that hold a
    // live connection can pass partitionTables to fan the builds out across partitions.
    return migrationStore.migrate(schema, version, undefined, undefined, { inlineAsync: true, partitionTables: options.partitionTables })
  }

  static rollbackPlans (schema = plans.DEFAULT_SCHEMA, version = schemaVersion) {
    return migrationStore.rollback(schema, version)
  }

  private config: types.ResolvedConstructorOptions
  private db: types.IDatabase
  private migrations: types.Migration[]

  constructor (db: types.IDatabase, config: types.ResolvedConstructorOptions) {
    this.config = config
    this.db = db
    this.migrations = this.config.migrations || migrationStore.getAll(this.config.schema, this.config.noTablePartitioning, this.config.noCoveringIndexes)
  }

  async schemaVersion () {
    const result = await this.db.executeSql(plans.getVersion(this.config.schema))
    return result.rows.length ? parseInt(result.rows[0].version) : null
  }

  async isInstalled () {
    const result = await this.db.executeSql(plans.versionTableExists(this.config.schema))
    return !!result.rows[0].name
  }

  async start () {
    const installed = await this.isInstalled()

    if (installed) {
      const version = await this.schemaVersion()

      if (version !== null && schemaVersion > version) {
        await this.migrate(version)
      }
    } else {
      await this.create()
    }
  }

  // Presence-level schema drift scan: compares the managed indexes the code expects against the live
  // catalog. Partitioned vs. non-partitioned is read from the database (job_common presence), and the
  // per-queue policy indexes are computed from the queue table, so conditional indexes are handled.
  async detectDrift (): Promise<types.SchemaDriftReport> {
    const schema = this.config.schema

    const probe = await this.db.executeSql(plans.jobCommonExists(schema))
    const partitioned = !!probe.rows[0].name

    const partitions = partitioned
      ? (await this.db.executeSql(plans.getManagedQueuePartitions(schema))).rows
      : []

    const liveResult = await this.db.executeSql(drifter.getSchemaIndexes(schema))
    const live = liveResult.rows.map((r: { name: string, table: string, valid: boolean, def: string, constraintBacked: boolean }) => ({
      name: r.name,
      table: r.table,
      valid: r.valid,
      def: r.def,
      constraintBacked: r.constraintBacked
    }))

    // The bam table only exists from schema v27; ignore its absence on very old schemas.
    let bamCommands: string[] = []
    try {
      const bamResult = await this.db.executeSql(plans.getIncompleteBamCommands(schema))
      bamCommands = bamResult.rows.map((r: { command: string }) => r.command)
    } catch {
      bamCommands = []
    }

    // Function-body and enum drift are best-effort: pg_get_functiondef is unsupported on some backends
    // (CockroachDB), so a failure here leaves those checks empty rather than aborting the whole scan.
    let liveFunctions: Array<{ name: string, def: string }> = []
    try {
      const fnResult = await this.db.executeSql(drifter.getSchemaFunctions(schema))
      liveFunctions = fnResult.rows.map((r: { name: string, def: string }) => ({ name: r.name, def: r.def }))
    } catch {
      liveFunctions = []
    }

    let enumLabels: string[] = []
    try {
      const enumResult = await this.db.executeSql(drifter.getEnumDefinition(schema))
      enumLabels = enumResult.rows.map((r: { label: string }) => r.label)
    } catch {
      enumLabels = []
    }

    let liveColumns: Array<{ table: string, column: string, default?: string | null, type?: string, notNull?: boolean }> = []
    try {
      const colResult = await this.db.executeSql(drifter.getSchemaColumns(schema))
      liveColumns = colResult.rows.map((r: { table: string, column: string, default: string | null, type: string, notNull: boolean }) =>
        ({ table: r.table, column: r.column, default: r.default, type: r.type, notNull: r.notNull }))
    } catch {
      liveColumns = []
    }

    let liveConstraints: Array<{ table: string, def: string }> = []
    try {
      const conResult = await this.db.executeSql(drifter.getSchemaConstraints(schema))
      liveConstraints = conResult.rows.map((r: { table: string, def: string }) => ({ table: r.table, def: r.def }))
    } catch {
      liveConstraints = []
    }

    const building = new Set(bamCommands.map(plans.bamCommandIndexName).filter((n): n is string => n !== null))

    // CockroachDB renders column types (INT8 vs integer), default expressions, and constraint
    // definitions differently from standard Postgres, so the canonical-form checks would false-positive
    // there. Restrict type/default/constraint drift to Postgres-typed backends; the presence checks
    // (tables, indexes, column names, functions, enum) still run everywhere.
    const canonicalPg = this.config.backend !== 'cockroachdb'
    const expectedColumns = plans.expectedManagedColumns(schema, partitioned, partitions)
      .map(c => canonicalPg ? c : { table: c.table, columns: c.columns })

    return drifter.computeSchemaDrift({
      indexes: { expected: plans.expectedManagedIndexes(schema, partitioned, partitions), live, building },
      tables: { expected: plans.expectedManagedTables(schema, partitioned, partitions), live: [...new Set(liveColumns.map(c => c.table))] },
      functions: { expected: plans.expectedManagedFunctions(schema, partitioned), live: liveFunctions },
      columns: { expected: expectedColumns, live: liveColumns },
      constraints: canonicalPg ? { expected: plans.expectedManagedConstraints(schema, partitioned), live: liveConstraints } : undefined,
      enum: { name: 'job_state', expected: plans.EXPECTED_JOB_STATES, actual: enumLabels }
    })
  }

  async check () {
    const installed = await this.isInstalled()

    if (!installed) {
      throw new Error('pg-boss is not installed')
    }

    const version = await this.schemaVersion()

    if (schemaVersion !== version) {
      throw new Error('pg-boss database requires migrations')
    }
  }

  async create () {
    try {
      const commands = plans.create(this.config.schema, schemaVersion, this.config)
      await this.db.executeSql(commands)
    } catch (err: any) {
      assert(err.message.includes(plans.CREATE_RACE_MESSAGE), err)
    }
  }

  async migrate (version: number) {
    try {
      const commands = migrationStore.migrate(this.config.schema, version, this.migrations, this.config.noAdvisoryLocks)
      await this.db.executeSql(commands)
    } catch (err: any) {
      assert(err.message.includes(plans.MIGRATE_RACE_MESSAGE), err)
    }
  }

  async next (version: number) {
    const commands = migrationStore.next(this.config.schema, version, this.migrations, this.config.noAdvisoryLocks)
    await this.db.executeSql(commands)
  }

  async rollback (version: number) {
    const commands = migrationStore.rollback(this.config.schema, version, this.migrations, this.config.noAdvisoryLocks)
    await this.db.executeSql(commands)
  }
}

export default Contractor
