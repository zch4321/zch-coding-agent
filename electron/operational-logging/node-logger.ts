import electronLog from 'electron-log/node'
import type {
  OperationalLoggerAdapter,
  OperationalLoggerFactory,
} from './service'

/** Creates isolated Node-only loggers for Headless execution. */
export const nodeOperationalLoggerFactory: OperationalLoggerFactory = {
  create(logId) {
    return electronLog.create({ logId }) as unknown as OperationalLoggerAdapter
  },
}
