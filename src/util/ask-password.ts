import * as readline from 'readline'

export async function askPassword(question: string = ''): Promise<string> {
  const input = process.stdin
  const output = process.stdout
  const rl = readline.createInterface(input, output)

  input.on('keypress', (c, k) => {
    const len = rl.line.length
    readline.moveCursor(output, -len, 0)
    readline.clearLine(output, 1)
    output.write('*'.repeat(len))
  })

  const password: string = await new Promise(resolve => {
    rl.question(question, (pwd) => {
      rl.close()
      resolve(pwd)
    })
  })
  return password
}
