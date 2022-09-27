import * as fs from 'fs'
import * as path from 'path'
import * as e from 'ethers'
import { consoleAndFileLogger } from '../../util/Logger'
import { transferEthValue } from '../../eth/transfer-eth'
import { exitOnEnter } from '../../util/exit-on-enter'
import { retry } from '../../util/retry'
import { parallelize } from '../../util/parallelize'

type TransferEthParams = {
  infuraProjectId: string
  maxFeePerGasGwei?: number
  transfers: {
    fromAtLeastBalance?: number
    fromShouldRemainBalance?: number
    shouldSendAtLeast?: number
    shouldSendAtMost?: number
    shouldSendExactly?: number
    toShouldRemainBalanceAtMost?: number
    buffersCount?: number
    fromPrivateKey?: string
    fromPublicKey?: string
    fromPrivateKeys?: string[]
    fromPublicKeys?: string[]
    toAddress: string
  }[]
}

type TransferQueueElement = {
  thread: TransferQueueThreadElement[]
}

type TransferQueueThreadElement = {
  fromWallet: e.Wallet
  toAddress: string
  fromIsBuffer: boolean
  ethValue?: number
  maxFeePerGasGwei: number
}

async function main() {
  const log = consoleAndFileLogger('eth-transfer-eth')

  const paramsPath = process.argv[2]
  if (!paramsPath) {
    log.error('paramsPath input required')
    return
  }
  const params: TransferEthParams = readTransferEthParams(paramsPath)

  const dryRun = process.argv.slice(2).indexOf('dry') != -1
  const minEthValue = 0.0001

  const provider = new e.providers.InfuraProvider('mainnet', params.infuraProjectId)
  await provider.ready

  let shutdown = false
  let awaitingShutdown = false
  const awaitShutdown = async () => { while (awaitingShutdown && !shutdown) shutdown = await exitOnEnter() }

  const ethBalanceMap: { [address: string]: number } = {}
  const getEthBalance: (address: string) => Promise<number> = async address =>
    retry(log, 3, 0, -1, async () => {
      const b = ethBalanceMap[address] ?? Number(e.utils.formatEther(await provider.getBalance(address)))
      ethBalanceMap[address] = b
      return b
      }
    )

  type FromWallet = { wallet: e.Wallet, balance: number }
  const fromWalletsAll: FromWallet[] = []
  const fromWalletsPrivateMap: { [privateKey: string]: FromWallet } = {}
  const fromWalletsPublicMap: { [publicKey: string]: FromWallet } = {}
  const ensureFromWalletPrivate: (privateKey: string) => FromWallet = privateKey => {
    let fromWallet = fromWalletsPrivateMap[privateKey]
    if (!fromWallet) {
      fromWallet = { wallet: new e.Wallet(privateKey, provider), balance: 0 }
      fromWalletsPrivateMap[privateKey] = fromWallet
      fromWalletsPublicMap[fromWallet.wallet.publicKey] = fromWallet
      fromWalletsAll.push(fromWallet)
    }
    return fromWallet
  }

  log.info(`Processing ${params.transfers.length} transfers`)
  params.transfers.forEach(transfer =>
    transfer.fromPrivateKeys?.forEach(privateKey =>
      ensureFromWalletPrivate(privateKey)))

  if (fromWalletsAll.length == 0) {
    log.info(`No wallets to send from`)
    return
  }
  log.info(`Collecting balances of ${fromWalletsAll.length} wallets`)

  const updateFromWalletBalance = async (fromWallet: FromWallet) => {
    fromWallet.balance = await getEthBalance(fromWallet.wallet.address)
    if (fromWallet.balance < 0)
      log.error(`balance(${fromWallet.wallet.address}) failed`)
  }

  awaitingShutdown = true
  await Promise.race([
    parallelize(50, () => shutdown, fromWalletsAll, updateFromWalletBalance),
    awaitShutdown()
  ]).then(() => { awaitingShutdown = false })
  if (shutdown) return

  const gasLimit = await provider.estimateGas({
    from: fromWalletsAll[0].wallet.address,
    to: fromWalletsAll[0].wallet.address,
    value: e.utils.parseUnits(`${minEthValue}`, 'ether')
  })
  const maxFeePerGasGwei = params.maxFeePerGasGwei ?? 60
  const maxFeePerGas = e.utils.parseUnits(`${maxFeePerGasGwei}`, 'gwei')
  const maxFee = maxFeePerGas.mul(gasLimit)

  log.info(`Populating transfers queue`)
  const transferQueue: TransferQueueElement[] = []
  for (const transfer of params.transfers) {
    const transferFromWallets: FromWallet[] = [
      ...(transfer.fromPrivateKeys?.map(k => fromWalletsPrivateMap[k]!) ?? []),
      ...(transfer.fromPublicKeys?.map(k => fromWalletsPublicMap[k]!) ?? [])
    ].flatMap(x => x == null ? [] : [x])
    if (transferFromWallets.length == 0) continue

    const toAddressBalance = await getEthBalance(transfer.toAddress)

    for (const fromWallet of transferFromWallets) {

      const fromAtLeastBalanceMatch = transfer.fromAtLeastBalance == null
        || fromWallet.balance >= transfer.fromAtLeastBalance
      if (!fromAtLeastBalanceMatch) continue

      const buffersCount = transfer.buffersCount ?? 0
      const bufferTransfersFee = maxFee.mul(buffersCount)
      const bufferTransfersFeeEth = Number(e.utils.formatEther(bufferTransfersFee))
      const maxFeeEth = Number(e.utils.formatEther(maxFee))
      const wholeTransferFeeEth = maxFeeEth + bufferTransfersFeeEth

      let ethValue = fromWallet.balance - maxFeeEth  // start with maximum available for transfer
      if (transfer.shouldSendAtMost != null && ethValue > transfer.shouldSendAtMost + wholeTransferFeeEth) {
        ethValue = transfer.shouldSendAtMost + wholeTransferFeeEth
      }
      if (transfer.shouldSendExactly != null && ethValue > transfer.shouldSendExactly + wholeTransferFeeEth) {
        ethValue = transfer.shouldSendExactly + wholeTransferFeeEth
      }
      if (transfer.toShouldRemainBalanceAtMost != null
        && ethValue - wholeTransferFeeEth + toAddressBalance > transfer.toShouldRemainBalanceAtMost) {
        ethValue = toAddressBalance - transfer.toShouldRemainBalanceAtMost + wholeTransferFeeEth
      }
      ethValue -= transfer.fromShouldRemainBalance == null ? 0 : transfer.fromShouldRemainBalance

      const shouldSendAtLeastMatch = transfer.shouldSendAtLeast == null
        || ethValue - wholeTransferFeeEth >= transfer.shouldSendAtLeast
      const shouldSentAtMostMatch = transfer.shouldSendAtMost == null
        || ethValue - wholeTransferFeeEth <= transfer.shouldSendAtMost
      const shouldSentExactlyMatch = transfer.shouldSendExactly == null
        || ethValue - wholeTransferFeeEth == transfer.shouldSendExactly
      const toShouldRemainBalanceAtMostMatch = transfer.toShouldRemainBalanceAtMost == null
        || ethValue - wholeTransferFeeEth <= transfer.toShouldRemainBalanceAtMost - toAddressBalance

      if (ethValue < minEthValue
        || ethValue > fromWallet.balance
        || !shouldSendAtLeastMatch
        || !shouldSentAtMostMatch
        || !shouldSentExactlyMatch
        || !toShouldRemainBalanceAtMostMatch) continue

      fromWallet.balance -= ethValue

      const transferQueueThread: TransferQueueThreadElement[] = []
      let previousFromWallet = fromWallet.wallet
      let previousFromIsBuffer = false

      if (buffersCount > 0) {
        for (let i = 0; i < buffersCount; i++) {
          const bufferWallet = new e.Wallet(e.Wallet.createRandom().privateKey, provider)
          transferQueueThread.push({
            fromWallet: previousFromWallet,
            toAddress: bufferWallet.address,
            fromIsBuffer: previousFromIsBuffer,
            maxFeePerGasGwei,
            ethValue: previousFromIsBuffer ? undefined : ethValue
          })
          previousFromWallet = bufferWallet
          previousFromIsBuffer = true
        }
      }

      transferQueueThread.push({
        fromWallet: previousFromWallet,
        toAddress: transfer.toAddress,
        fromIsBuffer: previousFromIsBuffer,
        maxFeePerGasGwei,
        ethValue: buffersCount > 0 ? undefined : ethValue
      })

      transferQueue.push({thread: transferQueueThread})
    }
  }

  if (await exitOnEnter()) return

  const transferQueueTsv =
    `${process.cwd()}${path.sep}logs${path.sep}eth-transfer-eth-transfer-queue_` +
    `${new Date().toISOString().split(':').join("-")}.tsv`

  log.info(`Saving transfers queue to ${transferQueueTsv}`)
  transferQueue.forEach((tqe, tqei) => {
    tqe.thread.forEach(tqte => {
      fs.appendFileSync(
        transferQueueTsv,
        `${tqte.fromWallet.address}\t${tqte.toAddress}` +
        `\t${tqte.fromIsBuffer ? 1 : 0}\t${tqte.ethValue ?? -1}\t${tqei}` +
        `\n`
      )
    })
  })
  if (transferQueue.length == 0) fs.appendFileSync(transferQueueTsv, `\n`)

  if (!dryRun) {
    log.info(`Executing transfers queue. Transfer threads: ${transferQueue.length}`)

    let processedTransferThreads = 0
    const processTransferQueueElement = async (tqe: TransferQueueElement) => {
      for (const tqte of tqe.thread) {
        await transferEthValue(log, provider, tqte.fromWallet, tqte.toAddress, tqte.ethValue, maxFeePerGasGwei)
      }
      processedTransferThreads += 1
      log.info(`Processed ${processedTransferThreads}/${transferQueue.length} transfer threads`)
      return tqe
    }

    awaitingShutdown = true
    await Promise.race([
      parallelize(50, () => shutdown, transferQueue, processTransferQueueElement),
      awaitShutdown()
    ]).then(() => { awaitingShutdown = false })
    if (shutdown) return
  }
}

function readTransferEthParams(path: string): TransferEthParams {
  const params = JSON.parse(fs.readFileSync(path).toString())
  const sanitizeNumber = (x: any) => typeof x === 'string' ? Number(x) : x
  params.maxFeePerGasGwei = sanitizeNumber(params.maxFeePerGasGwei)
  for (const transfer of params.transfers) {
    transfer.fromAtLeastBalance = sanitizeNumber(transfer.fromAtLeastBalance)
    transfer.fromShouldRemainBalance = sanitizeNumber(transfer.fromShouldRemainBalance)
    transfer.shouldSendAtLeast = sanitizeNumber(transfer.shouldSendAtLeast)
    transfer.shouldSendAtMost = sanitizeNumber(transfer.shouldSendAtMost)
    transfer.shouldSendExactly = sanitizeNumber(transfer.shouldSendExactly)
    transfer.toShouldRemainBalanceAtMost = sanitizeNumber(transfer.toShouldRemainBalanceAtMost)
    transfer.buffersCount = sanitizeNumber(transfer.buffersCount)

    if (transfer.fromPrivateKey != null) {
      const fromPrivateKeys: string[] = transfer.fromPrivateKeys ?? []
      fromPrivateKeys.push(transfer.fromPrivateKey)
      transfer.fromPrivateKeys = fromPrivateKeys
      delete transfer.fromPrivateKey
    }
    transfer.fromPrivateKeys = transfer.fromPrivateKeys?.filter((v: any, i: any, a: any) => a.indexOf(v) === i) ?? []

    if (transfer.fromPublicKey != null) {
      const fromPublicKeys: string[] = transfer.fromPublicKeys ?? []
      fromPublicKeys.push(transfer.fromPublicKey)
      transfer.fromPublicKeys = fromPublicKeys
      delete transfer.fromPublicKey
    }
    transfer.fromPublicKeys = transfer.fromPublicKeys?.filter((v: any, i: any, a: any) => a.indexOf(v) === i) ?? []
  }
  return params
}

main().catch(console.dir)
