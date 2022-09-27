import { Logger } from './Logger'

export async function retry<T>(
  log: Logger,
  maxRetries: number,
  timeout: number,
  defaultValue: T,
  fn: () => Promise<T>
): Promise<T> {
  let t: T | undefined = undefined
  let retries = 0
  while (t == null && retries <= maxRetries) {
    try {
      t = await fn()
    } catch (e) {
      log.warn(`${retries}/${maxRetries}: ${e}`)
      retries += 1
      if (timeout > 0)
        await new Promise(resolve => setTimeout(resolve, timeout))
    }
  }
  return t ?? defaultValue
}