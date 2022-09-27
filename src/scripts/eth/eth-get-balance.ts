import fs from 'fs'
import * as e from 'ethers'
import { consoleAndFileLogger } from '../../util/Logger'
import { exitOnEnter } from '../../util/exit-on-enter'
import { retry } from '../../util/retry'
import { parallelize } from '../../util/parallelize'

async function main() {
  const log = consoleAndFileLogger("eth-get-balance")

  const infuraProjectId = process.argv[2]
  const tsvFilePath = process.argv[3]
  if (!infuraProjectId || !tsvFilePath) {
    log.error('infura key and tsv file input required')
    return
  }
  const ws: any[] = parse(tsvFilePath)

  const provider = new e.providers.InfuraProvider('mainnet', infuraProjectId)
  await provider.ready

  log.info(`Fetching balances of ${ws.length} wallets`)

  let shutdown = false
  let awaitingShutdown = false
  const awaitShutdown = async () => { while (awaitingShutdown && !shutdown) shutdown = await exitOnEnter() }

  const getEthBalance = async (address: string) =>
    retry(log, 3, 0, -1, async () => Number(e.utils.formatEther(await provider.getBalance(address))))

  const updateWalletBalance = async (w: any) => {
    w.balance = await getEthBalance(w.address)
    if (w.balance < 0)
      log.error(`balance(${w.address}) failed`)
    return w.balance
  }

  awaitingShutdown = true
  await Promise.race([
    parallelize(50, () => shutdown, ws, updateWalletBalance),
    awaitShutdown()
  ]).then(() => { awaitingShutdown = false })
  if (shutdown) return

  ws.sort((a, b) => a.balance - b.balance)
  let sum = 0
  for (const w of ws) {
    log.info(` | ${w.address} | ${w.balance}`)
    sum += w.balance > 0 ? w.balance : 0
  }
  log.info(`Sum: ${sum}`)
}

export function parse(path: string): { address: string }[] {
  const result: { address: string }[] = []
  const contents = fs.readFileSync(path).toString()
  const lines = contents.split(/\r?\n/)
    .filter((v, i, a) => a.indexOf(v) === i)
  for (const line of lines) {
    const split = line.split('\t')
    if (line.trim().length == 0 || split.length < 1) continue
    const address = split[0].trim()
    result.push({ address })
  }
  return result
}

main().catch(console.dir)
