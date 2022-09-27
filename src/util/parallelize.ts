
export async function parallelize<T, V>(
  parallelism: number,
  shutdown: () => boolean | Promise<boolean>,
  ts: T[],
  fn: (t: T) => Promise<V>,
): Promise<V[]> {
  const queue = [...ts]
  const threadPromises: Promise<V[]>[] = []
  for (let thread = 0; thread < parallelism; thread++) {
    threadPromises.push(new Promise<V[]>(async (resolve, reject) => {
      const threadResult: V[] = []
      let hasMore = true
      while (hasMore && !(await Promise.resolve(shutdown()))) {
        const t = queue.shift()
        hasMore = t != null
        if (t != null) {
          try {
            const v = await fn(t)
            threadResult.push(v)
          } catch (e) {
            reject(e)
          }
        }
      }
      resolve(threadResult)
    }))
  }
  const threadsResult = await Promise.all(threadPromises)
  return threadsResult.flatMap(x => x)
}