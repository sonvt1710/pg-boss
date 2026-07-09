# Operations

### `start()`

Returns the same PgBoss instance used during invocation

Prepares the target database and begins job monitoring.

```js
await boss.start()
await boss.send('hey-there', { msg:'this came for you' })
```

If the required database objects do not exist in the specified database, **`start()` will automatically create them**. The same process is true for updates as well. If a new schema version is required, pg-boss will automatically migrate the internal storage to the latest installed version.

> [!WARNING]
> While this is most likely a welcome feature, be aware of this during upgrades since this could delay the promise resolution by however long the migration script takes to run against your data.  For example, if you happened to have millions of jobs in the job table just hanging around for archiving and the next version of the schema had a couple of new indexes, it may take a few seconds before `start()` resolves. Most migrations are very quick, however, and are designed with performance in mind.

Additionally, all schema operations, both first-time provisioning and migrations, are nested within advisory locks to prevent race conditions during `start()`. Internally, these locks are created using `pg_advisory_xact_lock()` which auto-unlock at the end of the transaction and don't require a persistent session or the need to issue an unlock. For databases that don't support advisory locks (like CockroachDB), select the matching backend (e.g. `backend: 'cockroachdb'`) and pg-boss adjusts accordingly.

One example of how this is useful would be including `start()` inside the bootstrapping of a pod in a ReplicaSet in Kubernetes. Being able to scale up your job processing using a container orchestration tool like k8s is becoming more and more popular, and pg-boss can be dropped into this system without any special startup handling.

### `stop(options)`

Stops all background processing, such as maintenance and scheduling, as well as all polling workers started with `work()`.

By default, calling `stop()` without any arguments will gracefully wait for all workers to finish processing active jobs before resolving. Emits a `stopped` event if needed.

**Arguments**

* `options`: object

  * `graceful`, bool

    Default: `true`. If `true`, the PgBoss instance will wait for any workers that are currently processing jobs to finish, up to the specified timeout. During this period, new jobs will not be processed, but active jobs will be allowed to finish.

  * `close`, bool
    Default: `true`. If the database connection is managed by pg-boss, it will close the connection pool. Use `false` if needed to continue allowing operations such as `send()` and `fetch()`.

  * `timeout`, int

    Default: 30000. Maximum time (in milliseconds) to wait for workers to finish job processing before shutting down the PgBoss instance.

    > [!WARNING]
    > This option is ignored when `graceful` is set to `false`.

```js
// graceful shutdown: wait for active jobs to finish (up to the timeout)
await boss.stop()

// stop workers but keep the connection pool open for send() and fetch()
await boss.stop({ close: false })

// shut down immediately without waiting for active jobs
await boss.stop({ graceful: false })
```

### `isInstalled()`

Utility function to see if pg-boss is installed in the configured database.

```js
const installed = await boss.isInstalled()
// true
```

### `schemaVersion()`

Utility function to get the database schema version.

```js
const version = await boss.schemaVersion()
// 36
```

### `getBamStatus()`

Returns a summary of boss async migration (BAM) commands grouped by status.

BAM commands are database operations that run asynchronously after schema migrations, such as creating indexes on partitioned tables. This function provides a high-level overview of their progress.

```js
const status = await boss.getBamStatus()
// [
//   { status: 'completed', count: 5, lastCreatedOn: 2024-01-15T10:30:00.000Z },
//   { status: 'pending', count: 2, lastCreatedOn: 2024-01-15T10:31:00.000Z }
// ]
```

**Returns**

Array of objects with the following properties:

| Property | Type | Description |
| --- | --- | --- |
| `status` | string | One of: `pending`, `in_progress`, `completed`, `failed` |
| `count` | number | Number of BAM entries with this status |
| `lastCreatedOn` | Date | Most recent creation timestamp for this status |

### `getBamEntries()`

Returns all boss async migration (BAM) command entries with full details.

Use this function when you need to inspect individual BAM commands, troubleshoot failures, or review the command history.

```js
const entries = await boss.getBamEntries()
// [
//   {
//     id: '550e8400-e29b-41d4-a716-446655440000',
//     name: 'create-index',
//     version: 27,
//     status: 'completed',
//     queue: 'my-queue',
//     table: 'j1a2b3c4...',
//     command: 'CREATE INDEX ...',
//     error: null,
//     createdOn: 2024-01-15T10:30:00.000Z,
//     startedOn: 2024-01-15T10:30:01.000Z,
//     completedOn: 2024-01-15T10:30:05.000Z
//   }
// ]
```

**Returns**

Array of objects with the following properties:

| Property | Type | Description |
| --- | --- | --- |
| `id` | string | Unique identifier for the BAM entry |
| `name` | string | Name of the migration command |
| `version` | number | Schema version that created this command |
| `status` | string | One of: `pending`, `in_progress`, `completed`, `failed` |
| `queue` | string | Queue name (if applicable) |
| `table` | string | Target table name |
| `command` | string | SQL command to execute |
| `error` | string | Error message (if failed) |
| `createdOn` | Date | When the entry was created |
| `startedOn` | Date | When execution started |
| `completedOn` | Date | When execution completed |

### `detectSchemaDrift()`

Compares the managed indexes pg-boss expects against what actually exists in the database and reports any drift. Use it to catch indexes that were dropped, left `INVALID` by an interrupted build, altered, or otherwise diverged from the version pg-boss installed — for example after a manual schema change or a failed migration.

The scan is catalog-only (no locks, no table scans) and covers presence, key-column order, and partial-index predicates. Partitioned vs. non-partitioned and per-queue policy indexes are read from the live database, so conditional indexes are handled. Index predicates that are not simple boolean conjunctions and non-index objects (tables, columns, constraints, functions) are out of scope.

```js
const report = await boss.detectSchemaDrift()
// {
//   ok: false,
//   missing: [ { name: 'job_common_i5', table: 'job_common' } ],
//   building: [],
//   invalid: [],
//   unexpected: [],
//   mismatched: [
//     {
//       name: 'job_common_i9',
//       table: 'job_common',
//       differs: ['predicate'],
//       expectedKeys: 'name,id',
//       actualKeys: 'name,id',
//       expectedPredicate: "blockingandstate='completed'",
//       actualPredicate: "blockingandstate='active'"
//     }
//   ]
// }
```

**Returns**

An object with the following properties:

| Property | Type | Description |
| --- | --- | --- |
| `ok` | boolean | `true` when nothing is missing, invalid, unexpected, or mismatched |
| `missing` | array | Expected indexes with no matching catalog entry (excludes any a BAM row is still building) |
| `building` | array | Expected indexes still being built by a pending/in&#95;progress/failed BAM row — not yet drift |
| `invalid` | array | Present indexes marked `INVALID` by an interrupted `CREATE INDEX CONCURRENTLY` (each has a `building` flag) |
| `unexpected` | array | Present indexes matching pg-boss's naming that the expected set does not account for (e.g. a stale policy index) |
| `mismatched` | array | Present indexes whose key columns/order or predicate differ from the expected definition |

Each entry carries at least `name` and `table`. `mismatched` entries also include `expectedKeys`/`actualKeys`, `expectedPredicate`/`actualPredicate`, and `differs` (`['keys']`, `['predicate']`, or both). Key and predicate strings are normalized for comparison, so they will not match the raw SQL character-for-character.

The [`doctor`](../cli#doctor) CLI command runs this same check without writing any application code.
