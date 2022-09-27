import { Logger } from '../util/Logger'
import * as e from 'ethers'
import { retry } from '../util/retry'

export async function transferEthThroughBuffers(
  provider: e.providers.Provider,
  log: Logger,
  fromPrivateKey: string,
  toAddress: string,
  bufferWalletsCount: number,
  maxFeePerGasGwei: number = 60
): Promise<string> {
  if (bufferWalletsCount == 0) {
    return await transferEth(provider, log, fromPrivateKey, toAddress)
  } else {
    const bufferWallet = e.Wallet.createRandom()
    log.info(`Using buffer wallet: ${bufferWallet.privateKey}:${bufferWallet.address}`)
    await transferEth(provider, log, fromPrivateKey, bufferWallet.address, maxFeePerGasGwei)
    return await transferEthThroughBuffers(
      provider, log, bufferWallet.privateKey, toAddress, bufferWalletsCount - 1, maxFeePerGasGwei)
  }
}

export async function transferEth(
  provider: e.providers.Provider,
  log: Logger,
  fromPrivateKey: string,
  toAddress: string,
  maxFeePerGasGwei: number = 60
): Promise<string> {
  const fromWallet = new e.Wallet(fromPrivateKey, provider)

  const balance = await provider.getBalance(fromWallet.address)
  const txReq: e.providers.TransactionRequest = {
    from: fromWallet.address,
    to: toAddress,
    value: balance
  }

  const feedData = await provider.getFeeData()
  if (feedData.maxFeePerGas == null || feedData.maxPriorityFeePerGas == null) {
    throw new Error(`getFeeData failed for ${fromWallet.privateKey}`)
  }
  const prevBlockMaxFeePerGas = feedData.maxFeePerGas
  const maxPriorityFeePerGas = feedData.maxPriorityFeePerGas
  const calculatedMaxFeePerGas =
    prevBlockMaxFeePerGas
      .sub(maxPriorityFeePerGas)
      .div(2)
      .div(10)
      .mul(15)
      .add(maxPriorityFeePerGas)
  let txMaxFeePerGas = calculatedMaxFeePerGas
  const gasLimit = await provider.estimateGas(txReq)
  txReq.gasLimit = gasLimit
  let calculatedMaxFee = calculatedMaxFeePerGas.mul(gasLimit)
  let txMaxFee = calculatedMaxFee
  const maxFeePerGas = e.utils.parseUnits(`${maxFeePerGasGwei}`, 'gwei')
  const maxFee = maxFeePerGas.mul(gasLimit)
  if (calculatedMaxFee.gt(maxFee)) {
    log.warn(
      `Calculated maxFee=${e.utils.formatEther(calculatedMaxFee)}ETH` +
      ` is greater than ${e.utils.formatEther(maxFee)}ETH.` +
      ` Setting maxFee to ${e.utils.formatEther(maxFee)}ETH`
    )
    txMaxFeePerGas = maxFeePerGas
    txMaxFee = maxFee
  }
  const valueToTransfer = balance.sub(txMaxFee)
  if (valueToTransfer.lt(0)) {
    throw new Error(
      `${fromWallet.address} has not enough minerals` +
      ` balance: ${e.utils.formatEther(balance)}ETH` +
      ` maxFee: ${e.utils.formatEther(calculatedMaxFee)}ETH`
    )
  }
  txReq.value = valueToTransfer
  txReq.maxFeePerGas = txMaxFeePerGas

  log.info(
    'Transferring eth\n' +
    `    from: ${fromWallet.privateKey}:${fromWallet.address}\n` +
    `    to: ${toAddress}\n` +
    `    balance: ${e.utils.formatEther(balance)}ETH\n` +
    `    value: ${e.utils.formatEther(valueToTransfer)}ETH\n` +
    `    gasLimit: ${gasLimit.toString()}\n` +
    `    maxFee: ${e.utils.formatEther(txMaxFee)}ETH`
  )

  const txResp = await fromWallet.sendTransaction(txReq)
  const txHash = txResp.hash
  let txReceipt: e.providers.TransactionReceipt | undefined = undefined
  let awaitingTicks = 0
  while (!txReceipt) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    if (awaitingTicks % 30 == 0) {
      log.debug(`Awaiting ${txHash}`)
    }
    awaitingTicks += 1
    txReceipt = await provider.waitForTransaction(txHash, 0)
  }

  const fromWalletBalance = await provider.getBalance(fromWallet.address)
  const toAddressBalance = await provider.getBalance(toAddress)

  log.info(
    `Mined ${txReceipt.transactionHash}\n` +
    `    effectiveGasPrice: ${e.utils.formatEther(txReceipt.effectiveGasPrice)}\n` +
    `    fee: ${e.utils.formatEther(txReceipt.effectiveGasPrice.mul(gasLimit))}ETH\n` +
    `    ${fromWallet.address} balance: ${e.utils.formatEther(fromWalletBalance)}ETH\n` +
    `    ${toAddress} balance: ${e.utils.formatEther(toAddressBalance)}ETH`
  )

  return txHash
}

export async function transferEthWithRetry(
  provider: e.providers.Provider,
  log: Logger,
  fromPrivateKey: string,
  toAddress: string,
  maxFeePerGasGwei: number = 60,
  retries: number = 2
): Promise<string> {
  let retriesCount = 0
  while (retriesCount < retries) {
    try {
      return await transferEth(provider, log, fromPrivateKey, toAddress, maxFeePerGasGwei)
    } catch (e) {
      log.error(`transferEth (retry ${retriesCount}/${retries}) failed: ${e}`)
    }
    retriesCount += 1
  }
  throw new Error(`transferEthWithRetry failed after ${retries} retries`)
}

export async function transferEthValue(
  log: Logger,
  provider: e.providers.Provider,
  fromWallet: e.Wallet,
  toAddress: string,
  ethValue: number | undefined,
  maxFeePerGasGwei: number,
  maxRetries: number = 3
): Promise<string> {
  const tx =  await retry(log, maxRetries, 0, undefined, async () => {
    const balance = await provider.getBalance(fromWallet.address)
    const txReq: e.providers.TransactionRequest = {
      from: fromWallet.address,
      to: toAddress,
      value: balance
    }

    const feedData = await provider.getFeeData()
    if (feedData.maxFeePerGas == null || feedData.maxPriorityFeePerGas == null) {
      throw new Error(`getFeeData failed for transferEthValue ${fromWallet.address} -> ${toAddress} (${ethValue})`)
    }
    const prevBlockMaxFeePerGas = feedData.maxFeePerGas
    const maxPriorityFeePerGas = feedData.maxPriorityFeePerGas
    const calculatedMaxFeePerGas =
      prevBlockMaxFeePerGas
        .sub(maxPriorityFeePerGas)
        .div(2)
        .div(10)
        .mul(15)
        .add(maxPriorityFeePerGas)
    let txMaxFeePerGas = calculatedMaxFeePerGas
    const gasLimit = await provider.estimateGas(txReq)
    txReq.gasLimit = gasLimit
    let calculatedMaxFee = calculatedMaxFeePerGas.mul(gasLimit)
    let txMaxFee = calculatedMaxFee
    const maxFeePerGas = e.utils.parseUnits(`${maxFeePerGasGwei}`, 'gwei')
    const maxFee = maxFeePerGas.mul(gasLimit)
    if (calculatedMaxFee.gt(maxFee)) {
      txMaxFeePerGas = maxFeePerGas
      txMaxFee = maxFee
    }

    const valueToTransfer = ethValue == null
      ? balance.sub(txMaxFee)
      : e.utils.parseUnits(`${ethValue}`, 'ether')

    if (balance.lt(valueToTransfer.add(txMaxFee))) throw new Error(
      `Insufficient founds for transferEthValue ${fromWallet.address} -> ${toAddress} (${ethValue})`)

    txReq.value = valueToTransfer
    txReq.maxFeePerGas = txMaxFeePerGas

    const txResp = await fromWallet.sendTransaction(txReq)
    const txHash = txResp.hash
    let txReceipt: e.providers.TransactionReceipt | undefined = undefined
    let awaitingTicks = 0
    while (!txReceipt) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      awaitingTicks += 1
      txReceipt = await provider.waitForTransaction(txHash, 0)
    }

    return txHash
  })
  if (!tx) {
    throw new Error(`transferEthValue failed ${fromWallet.address} -> ${toAddress} (${ethValue})`)
  }
  return tx
}