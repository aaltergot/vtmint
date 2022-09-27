import { Logger, consoleAndFileLogger } from '../util/Logger'
import { Actor } from 'comedy'
import * as ethers from 'ethers'
import { ProviderParams, makeProvider } from './make-provider'

export type EthContractGasWatchActorProps = {
  parentName: string
  providerParams: ProviderParams
  contractAddress: string
  contractMethodIds: string[]  // ['mint(uint32)']
  timeoutMillis: number
}

export type EthContractGasWatchResult = {
  challengers: Challenger[]
  timestamp: string
}
export type Challenger = {
  address: string,
  blockNumber?: number,
  gasPriceGwei: number
  maxFeePerGasGwei: number
  maxPriorityFeePerGasGwei: number
  timestamp: string
}

export default class EthContractGasWatchActor {

  private selfActor!: Actor
  private props!: EthContractGasWatchActorProps
  private log!: Logger
  private eventType!: ethers.providers.EventType
  private provider!: ethers.providers.Provider

  private challengers: Challenger[] = []
  private running: boolean = false
  private lastTickTimestamp = new Date()

  async initialize(selfActor: Actor) {
    this.selfActor = selfActor
    this.props = selfActor.getCustomParameters()
    this.log = consoleAndFileLogger(`${this.props.parentName}-EthContractGasWatchActor`)

    this.eventType = {
      address: this.props.contractAddress,
      topics: this.props.contractMethodIds.map(x => ethers.utils.id(x)) // FIXME topics are not methodIds!
    }

    this.provider = await makeProvider(this.props.providerParams)

    this.log.info('init')
  }

  private readonly contractEventListener =
    async (log: ethers.ethers.providers.Log, event: ethers.ethers.Event) => {
      const transaction = await event.getTransaction()
      this.challengers.push({
        address: transaction.from,
        blockNumber: transaction.blockNumber,
        gasPriceGwei: Number(ethers.utils.formatUnits(transaction.gasPrice ?? 0, 'gwei')),
        maxFeePerGasGwei: Number(ethers.utils.formatUnits(transaction.maxFeePerGas ?? 0, 'gwei')),
        maxPriorityFeePerGasGwei: Number(ethers.utils.formatUnits(transaction.maxPriorityFeePerGas ?? 0, 'gwei')),
        timestamp: new Date().toISOString()
      })
    }

  async launch() {
    if (this.running) return
    this.provider.addListener(this.eventType, this.contractEventListener)
    this.running = true
    await this.selfActor.send('tick')
  }

  async destroy() {
    this.running = false
    this.provider.removeListener(this.eventType, this.contractEventListener)
  }

  async tick() {
    if (!this.running) return
    try {
      const challengers: Challenger[] = [...this.challengers]
      this.challengers = []
      this.lastTickTimestamp = new Date()
      const timestamp = this.lastTickTimestamp.toISOString()
      await this.selfActor.getParent().send(
        'EthContractGasWatchResult',
        { challengers, timestamp }
      )
    } catch (e) {
      this.log.error(`Tick failed: ${e}`)
    }
    setTimeout(async () => {
      if (this.running) {
        await this.selfActor.send('tick')
      }
    }, this.props.timeoutMillis)
  }
}
