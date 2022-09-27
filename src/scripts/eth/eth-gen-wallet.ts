import * as ethers from 'ethers'

async function main() {
  const wlt = ethers.Wallet.createRandom()
  console.log(`${wlt.privateKey}:${wlt.address}`)
}

main().catch(console.dir)
