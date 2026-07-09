import assert from 'node:assert'
import * as plans from './plans.ts'
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

    const liveResult = await this.db.executeSql(plans.getSchemaIndexes(schema))
    const live = liveResult.rows.map((r: { name: string, table: string, valid: boolean, def: string }) => ({
      name: r.name,
      table: r.table,
      valid: r.valid,
      def: r.def
    }))

    // The bam table only exists from schema v27; ignore its absence on very old schemas.
    let bamCommands: string[] = []
    try {
      const bamResult = await this.db.executeSql(plans.getIncompleteBamCommands(schema))
      bamCommands = bamResult.rows.map((r: { command: string }) => r.command)
    } catch {
      bamCommands = []
    }

    const expected = plans.expectedManagedIndexes(partitioned, partitions)
    return plans.computeSchemaDrift(expected, live, bamCommands)
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
