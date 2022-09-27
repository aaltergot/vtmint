import * as fs from 'fs'
import * as path from 'path'
import actors from 'comedy'
import { Logger, consoleAndFileLogger } from '../../util/Logger'
import * as ethers from 'ethers'
import { askPassword } from '../../util/ask-password'
import { exitOnEnter } from '../../util/exit-on-enter'
import { retry } from '../../util/retry'
import { parallelize } from '../../util/parallelize'
import {
  EthContractGasWatchActorProps,
  EthContractGasWatchResult,
  Challenger
} from '../../eth/EthContractGasWatchActor'
import { ProviderParams, makeProvider } from '../../eth/make-provider'

const scriptName = "eth-mint"

type EthMintParams = {
  providerParams: ProviderParams,

  contractAddress: string

  maxFeePerGasGwei: number
  maxPriorityFeePerGasGwei: number

  mints: MintTask[]
}

type MintTask = {
  fromAtLeastBalance?: number
  fromShouldRemainBalance?: number

  shouldMintAtLeast?: number
  shouldMintAtMost?: number
  shouldMintExactly?: number

  fromPrivateKey?: string
  fromPrivateKeys?: string[]
}

type MintQueueElement = {
  thread: MintQueueThreadElement[]
}

type MintQueueThreadElement = {
  fromWallet: FromWallet
  toAddress: string
  fromIsBuffer: boolean
  ethValue?: number
  maxFeePerGasGwei: number
}

type FromWallet = { wallet: ethers.Wallet, balance: number }

async function main() {
  const log = consoleAndFileLogger(scriptName)

  let parallelism = 1
  let dryRun = false
  let mintParamsPath: string | undefined = undefined
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('parallelism=')) {
      parallelism = Number(arg.slice('parallelism='.length))
      if (parallelism < 1) parallelism = 1
    } else if (arg == 'dry') {
      dryRun = true
    } else {
      mintParamsPath = arg
    }
  }
  if (!mintParamsPath) {
    log.error('mintParamsPath input required')
    return
  }
  if (dryRun) {
    log.info("Running in dry mode")
  } else {
    log.info("Running in production mode")
  }
  const mintParams: EthMintParams = parseEthMintParams(mintParamsPath)

  let shutdown = false
  let awaitingShutdown = false
  const awaitShutdown = async () => { while (awaitingShutdown && !shutdown) shutdown = await exitOnEnter() }

  const provider = await makeProvider(mintParams.providerParams)

  const ethBalanceCache: { [address: string]: number } = {}
  const getEthBalance: (address: string) => Promise<number> = async address =>
    retry(log, 3, 0, -1, async () => {
        const b = ethBalanceCache[address] ?? Number(ethers.utils.formatEther(await provider.getBalance(address)))
        ethBalanceCache[address] = b
        return b
      }
    )

  const allFromWallets: FromWallet[] = []
  const privateFromWalletCache: { [privateKey: string]: FromWallet } = {}
  const publicFromWalletCache: { [publicKey: string]: FromWallet } = {}
  const ensureFromWalletPrivate: (privateKey: string) => FromWallet = privateKey => {
    let fromWallet = privateFromWalletCache[privateKey]
    if (!fromWallet) {
      fromWallet = { wallet: new ethers.Wallet(privateKey, provider), balance: 0 }
      privateFromWalletCache[privateKey] = fromWallet
      publicFromWalletCache[fromWallet.wallet.publicKey] = fromWallet
      allFromWallets.push(fromWallet)
    }
    return fromWallet
  }
  mintParams.mints.forEach(mint =>
    mint.fromPrivateKeys?.forEach(privateKey =>
      ensureFromWalletPrivate(privateKey)))

  if (allFromWallets.length == 0) {
    log.info(`No wallets to mint from`)
    return
  }

  log.info(`Updating balances of ${allFromWallets.length} wallets...`)
  const updateFromWalletBalance = async (fromWallet: FromWallet) => {
    fromWallet.balance = await getEthBalance(fromWallet.wallet.address)
    if (fromWallet.balance < 0)
      log.error(`balance(${fromWallet.wallet.address}) failed`)
  }
  awaitingShutdown = true
  await Promise.race([
    parallelize(50, () => shutdown, allFromWallets, updateFromWalletBalance),
    awaitShutdown()
  ]).then(() => { awaitingShutdown = false })
  if (shutdown) return
  log.info('done')

  const actorSystem = actors.createSystem({ config: {} })
  const rootActor = await actorSystem.rootActor()

  const ethContractGasWatchActorProps: EthContractGasWatchActorProps = {
    parentName: scriptName,
    contractAddress: mintParams.contractAddress,
    // contractMethodIds: ['devMint(uint256 quantity)', 'mint(uint32 address, uint32 quantity)'],
    contractMethodIds: ['devMint(uint256)', 'mint(uint32,uint32)',
                       'multicall(uint256,bytes[])' //for test
                      ],
    providerParams: mintParams.providerParams,
    timeoutMillis: 100
  }
  const ethContractGasWatchActor = await rootActor.createChild(
    '/src/eth/EthContractGasWatchActor',
    { customParameters: ethContractGasWatchActorProps }
  )
  await ethContractGasWatchActor.send('launch')

  const challengers: Challenger[] = []
  const ethContractGasWatchResultListener =
    (result: EthContractGasWatchResult) => challengers.push(...result.challengers)
  rootActor.addListener('EthContractGasWatchResult', ethContractGasWatchResultListener)

  log.info(`Processing ${mintParams.mints.length} mints, from of total ${allFromWallets}`)
  const mintWorker = async (mint: MintTask) => {
    await retry(log, 3, 0, 'failure', () => doMint(
      log, dryRun, provider,
      privateFromWalletCache, publicFromWalletCache,
      () => challengers, mintParams, mint
    ))
  }

  let subscriptionFinished = false
  awaitingShutdown = true
  await Promise.race([
    parallelize(parallelism, () => shutdown, mintParams.mints, mintWorker)
      .then(() => { subscriptionFinished = true}),
    awaitShutdown()
  ]).then(() => { awaitingShutdown = false })
  while (!subscriptionFinished)
    await new Promise(resolve => setTimeout(resolve, 1000))


  const mintQueue: MintQueueElement[] = []

  rootActor.removeListener('EthContractGasWatchResult', ethContractGasWatchResultListener)
}

function parseEthMintParams(filePath: string): EthMintParams {
  const params = JSON.parse(fs.readFileSync(filePath).toString())
  const sanitizeNumber = (x: any) => typeof x === 'string' ? Number(x) : x
  params.maxFeePerGasGwei = sanitizeNumber(params.maxFeePerGasGwei)
  for (const mint of params.mints) {

    mint.fromAtLeastBalance = sanitizeNumber(mint.fromAtLeastBalance)
    mint.fromShouldRemainBalance = sanitizeNumber(mint.fromShouldRemainBalance)
    mint.shouldMintAtLeast = sanitizeNumber(mint.shouldSendAtLeast)
    mint.shouldMintAtMost = sanitizeNumber(mint.shouldSendAtMost)
    mint.shouldMintExactly = sanitizeNumber(mint.shouldSendExactly)

    const fromPrivateKeys: string[] = mint.fromPrivateKeys ?? []
    if (mint.fromPrivateKey != null) {
      fromPrivateKeys.push(mint.fromPrivateKey)
      delete mint.fromPrivateKey
    }
    mint.fromPrivateKeys = fromPrivateKeys
      .filter((v: any, i: any, a: any) => a.indexOf(v) === i) ?? []

    const fromPublicKeys: string[] = mint.fromPublicKeys ?? []
    if (mint.fromPublicKey != null) {
      fromPublicKeys.push(mint.fromPublicKey)
      delete mint.fromPublicKey
    }
    mint.fromPublicKeys = fromPublicKeys
      .filter((v: any, i: any, a: any) => a.indexOf(v) === i) ?? []
  }
  return params
}

type DoMintResult = 'ok' | 'emptyWalletsList' | 'error'
async function doMint(
  log: Logger,
  dryRun: boolean,
  provider: ethers.providers.Provider,

  privateFromWalletCache: { [privateKey: string]: FromWallet },
  publicFromWalletCache: { [publicKey: string]: FromWallet },

  getChallengers: () => Challenger[],
  mintParams: {
    contractAddress: string
    maxFeePerGasGwei: number
    maxPriorityFeePerGasGwei: number
  },
  mint: MintTask
): Promise<DoMintResult> {
  let result: DoMintResult = 'ok'
  try {
    const challengers = getChallengers()
    const challengerMaxFeePerGasGwei = challengers
      .sort((c1, c2) => c1.maxFeePerGasGwei - c2.maxFeePerGasGwei)
      .pop()?.maxFeePerGasGwei
    const challengerMaxPriorityFeePerGasGwei = challengers
      .sort((c1, c2) => c1.maxPriorityFeePerGasGwei - c2.maxPriorityFeePerGasGwei)
      .pop()?.maxPriorityFeePerGasGwei

    const maybeFromWallet = [
      ...Object.values(privateFromWalletCache),
      ...Object.values(publicFromWalletCache)
    ].shift()

    if (!maybeFromWallet) {
      return 'emptyWalletsList'
    }

    // const gasLimit = await provider.estimateGas({
    //   from: mint.fromPrivateKey,  // mint.from1
    //   to: maybeFromWallet.wallet.address,
    //   value: ethers.utils.parseUnits(`${minEthValue}`, 'ether')
    // })
    // const maxFeePerGasGwei = params.maxFeePerGasGwei ?? 60
    // const maxFeePerGas = e.utils.parseUnits(`${maxFeePerGasGwei}`, 'gwei')
    // const maxFee = maxFeePerGas.mul(gasLimit)

  } catch (e) {
    log.error(`doMint error: ${e}`)
    result = 'error'
  }
  return result
}



main().catch(console.dir)

