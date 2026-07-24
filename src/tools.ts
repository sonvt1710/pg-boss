import { setTimeout } from 'node:timers/promises'

/**
 * When sql contains multiple queries, result is an array of objects with rows property
 * This function unwraps the result into a single object with rows property
 *
 * Some drivers (postgres.js, and therefore drizzle-orm/postgres-js) instead return the rows
 * themselves as a flat array. Those elements have no `rows` property, so treat the array
 * as the row set rather than flat-mapping undefined into it.
*/
function unwrapSQLResult (result: { rows: any[] } | { rows: any[] }[] | any[]): { rows: any[] } {
  if (Array.isArray(result)) {
    return result.every(i => Array.isArray(i?.rows))
      ? { rows: result.flatMap(i => i.rows) }
      : { rows: result }
  }

  return result
}

export interface AbortablePromise<T> extends Promise<T> {
  abort: () => void
}

function delay (ms: number, error?: string, abortController?: AbortController): AbortablePromise<void> {
  const ac = abortController || new AbortController()

  const promise = new Promise<void>((resolve, reject) => {
    setTimeout(ms, null, { signal: ac.signal })
      .then(() => {
        if (error) {
          reject(new Error(error))
        } else {
          resolve()
        }
      })
      .catch(resolve)
  }) as AbortablePromise<void>

  promise.abort = () => {
    if (!ac.signal.aborted) {
      ac.abort()
    }
  }

  return promise
}

async function resolveWithinSeconds<T> (promise: Promise<T>, seconds: number, message?: string, abortController?: AbortController): Promise<T | void> {
  const timeout = Math.max(1, seconds) * 1000
  const reject = delay(timeout, message, abortController)

  let result

  try {
    result = await Promise.race([promise, reject])
  } finally {
    reject.abort()
  }

  return result
}

export {
  delay,
  resolveWithinSeconds,
  unwrapSQLResult
}
