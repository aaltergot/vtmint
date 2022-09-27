import * as ethers from 'ethers'

export type ProviderParams = InfuraProviderParams | RpcProviderParams | WebSocketProvider
export type InfuraProviderParams = { tpe: "InfuraProviderParams", network: string, projectId: string }
export type RpcProviderParams = { tpe: "RpcProviderParams", url: string, network: string }
export type WebSocketProvider = { tpe: "WebSocketProvider", url: string, network: string }


export async function makeProvider(providerParams: ProviderParams): Promise<ethers.providers.Provider> {
  let provider: ethers.providers.Provider
  switch(providerParams.tpe) {
    case "InfuraProviderParams":
      const infuraProvider = new ethers.providers.InfuraProvider(
        providerParams.network,
        providerParams.projectId
      )
      await infuraProvider.ready
      provider = infuraProvider
      break
    case "RpcProviderParams":
      const rpcProvider = new ethers.providers.JsonRpcProvider(
        providerParams.url,
        providerParams.network
      )
      await rpcProvider.ready
      provider = rpcProvider
      break
    case "WebSocketProvider":
      const socketProvider = new ethers.providers.WebSocketProvider(
        providerParams.url,
        providerParams.network
      )
      await socketProvider.ready
      provider = socketProvider
      break
  }
  return provider
}