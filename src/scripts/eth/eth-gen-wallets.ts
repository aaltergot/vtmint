import * as ethers from 'ethers'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

async function main() {
  for (let i = 0; i < 50000; i++) {
   const id = crypto.randomBytes(32).toString('hex');
   const privateKey = "0x" + id;
   const wlt = new ethers.Wallet(privateKey);
   fs.appendFileSync(
     `${__dirname}${path.sep}wallets.tsv`,
     `${privateKey}\t${wlt.address}\n`
     )
  }
}

main().catch(console.dir)
