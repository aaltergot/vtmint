import * as readline from 'readline'
import * as util from 'util'

export async function exitOnEnter(question: string = '', sleepMillis: number = 500): Promise<boolean> {
  const rl = readline.createInterface(process.stdin, process.stdout)
  const questionF = util.promisify(rl.question).bind(rl)
  let timeout: NodeJS.Timeout | undefined = undefined
  const resumeOrExit = await Promise.race([
    questionF(question),
    new Promise(resolve => {
      timeout = setTimeout(() => resolve('resume'), sleepMillis)
    })
  ])
  if (timeout != null && resumeOrExit != 'resume') {
    clearTimeout(timeout)
  }
  rl.close()
  return resumeOrExit != 'resume'
}
