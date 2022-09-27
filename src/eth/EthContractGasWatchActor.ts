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

export type ParseData = {
  methodId: string | undefined,
  params: string[] | undefined,
}
export function parseTransactionData(input: string): ParseData {
  let parseData:ParseData = { methodId: undefined,
                              params: undefined
                            }
  if (input == '0x') {
      return parseData
  }
  if ( (input.length - 8 - 2)  % 64 != 0 ) {
      // console.log('Data size misaligned with parse request')
      return parseData
  }
  const method = input.slice(0,10)
  const numParams = Math.floor( (input.length - 8 - 2) / 64)
  const params = new Array<string>()
  for (let i=0; i < numParams; i++) {
      params.push( input.slice(10 + i * 64, 10 + (i + 1) * 64)) 
  }
  parseData.methodId = method
  parseData.params = params
  return parseData
}

export default class EthContractGasWatchActor {

  private selfActor!: Actor
  private props!: EthContractGasWatchActorProps
  private log!: Logger
  private eventType!: {address: string, methodIds: string[], event: string}
  private provider!: ethers.providers.Provider

  private challengers: Challenger[] = []
  private running: boolean = false
  private lastTickTimestamp = new Date()

  async initialize(selfActor: Actor) {
    this.selfActor = selfActor
    this.props = selfActor.getCustomParameters()
    this.log = consoleAndFileLogger(`${this.props.parentName}-EthContractGasWatchActor`)

    this.eventType = {
      event: 'pending',
      address: this.props.contractAddress,
      // topics: this.props.contractMethodIds.map(x => ethers.utils.id(x)), // FIXME topics are not methodIds!
      methodIds: this.props.contractMethodIds.map(x => ethers.utils.id(x).slice(0,10)), 
    }

    this.provider = await makeProvider(this.props.providerParams)

    this.log.info('init')
  }

  private readonly contractEventListener =
    // async (log: ethers.ethers.providers.Log, event: ethers.ethers.Event) => {
    //   const transaction = await event.getTransaction()
    ////
    async (hash: string) => {
      const transaction = await this.provider.getTransaction(hash)
      if (!transaction) return
      const parsData = parseTransactionData(transaction.data)
      if (!parsData.methodId) return
      const contractAddress = transaction.to
      if (!this.eventType.methodIds.includes(parsData.methodId)) return
      // console.log('GOT method, ', parsData.methodId,  'hash:', hash, )
    ////
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
      // this.provider.addListener(this.eventType, this.contractEventListener)
      ////
      this.provider.addListener(this.eventType.event, this.contractEventListener)
      ////
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
