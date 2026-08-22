import electronLog from 'electron-log/main'
import type {
  OperationalLoggerAdapter,
  OperationalLoggerFactory,
} from './service'

/** Creates isolated desktop electron-log instances without renderer IPC. */
export const desktopOperationalLoggerFactory: OperationalLoggerFactory = {
  create(logId) {
    return electronLog.create({ logId }) as unknown as OperationalLoggerAdapter
  },
}
