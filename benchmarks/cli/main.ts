#!/usr/bin/env node
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runBenchmarkCli } from './cli'

export async function runBenchmarkMain(argv: string[]): Promise<number> {
  const controller = new AbortController()
  const abort = () =>
    controller.abort(new Error('Benchmark process interrupted'))
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  try {
    return (await runBenchmarkCli(argv, { signal: controller.signal })).exitCode
  } finally {
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  void runBenchmarkMain(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode
  })
}
