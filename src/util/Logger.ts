import * as path from 'path'
import * as fs from 'fs'
import { ensureDir } from './ensure-dir'

export interface Logger {
  debug(...messages: any[]): void;

  info(...messages: any[]): void;

  warn(...messages: any[]): void;

  error(...messages: any[]): void;
}

function formatMessage(
  level: string,
  thread: string,
  ...messages: any[]
) {
  const msg = messages.map(x => x.join('\n    ')).join('\n  ')
  return `${new Date().toISOString()} ${level} ${thread}: ${msg}`
}

export function consoleLogger(): Logger {
  const thread = 'main'
  return {
    debug: (...messages: any[]): void =>
      console.log(formatMessage('DEBUG', thread, messages)),
    info: (...messages: any[]): void =>
      console.log(formatMessage('INFO', thread, messages)),
    warn: (...messages: any[]): void =>
      console.log(formatMessage('WARN', thread, messages)),
    error: (...messages: any[]): void =>
      console.log(formatMessage('ERROR', thread, messages)),
  }
}

export function consoleAndFileLogger(prefix: string = 'main'): Logger {
  const logsDir = ensureDir(`${process.cwd()}${path.sep}logs`)
  const logFile = `${logsDir}${path.sep}${prefix}_${new Date().toISOString().split(':').join("-")}.log`
  return {
    debug: (...messages: any[]): void => {
      const msg = formatMessage('DEBUG', prefix, messages)
      console.log(msg)
      fs.appendFileSync(logFile, msg + '\n')
    },
    info: (...messages: any[]): void => {
      let msg = formatMessage('INFO', prefix, messages);
      console.log(msg)
      fs.appendFileSync(logFile, msg + '\n')
    },
    warn: (...messages: any[]): void => {
      const msg = formatMessage('WARN', prefix, messages);
      console.log(msg)
      fs.appendFileSync(logFile, msg + '\n')
    },
    error: (...messages: any[]): void => {
      const msg = formatMessage('ERROR', prefix, messages);
      console.log(msg)
      fs.appendFileSync(logFile, msg + '\n')
    },
  }
}
