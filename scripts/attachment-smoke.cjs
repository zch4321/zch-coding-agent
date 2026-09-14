const { spawn } = require('node:child_process')
const { createRequire } = require('node:module')
const path = require('node:path')
const {
  buildChildEnvironment,
  packagedElectronPath,
} = require('./sqlite-smoke.cjs')

const CHILD_MARKER = 'ZCH_PACKAGED_ATTACHMENT_SMOKE'

/** Loads sharp from the packaged app and exercises the same native decode/resize/encode path as imports. */
async function probePackagedImages() {
  const appPackage = path.join(
    path.dirname(process.execPath),
    'resources',
    'app.asar',
    'package.json',
  )
  const packagedRequire = createRequire(appPackage)
  const sharp = packagedRequire('sharp')
  const original = await sharp({
    create: { width: 2560, height: 1440, channels: 3, background: '#4488bb' },
  })
    .png()
    .toBuffer()
  const request = await sharp(original)
    .rotate()
    .resize(2048, 2048, { fit: 'inside' })
    .jpeg({ quality: 90 })
    .toBuffer()
  const metadata = await sharp(request).metadata()
  if (
    metadata.width !== 2048 ||
    metadata.height !== 1152 ||
    request.length > 2 * 1024 * 1024
  )
    throw new Error(
      'Packaged image processing produced an invalid request variant',
    )
  console.log(
    `ATTACHMENTS_OK runtime=electron-packaged sharp=${sharp.versions.sharp} bytes=${request.length}`,
  )
}

if (process.env[CHILD_MARKER] === '1') {
  probePackagedImages().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
} else if (process.platform !== 'win32') {
  console.log(`ATTACHMENTS_SKIP target=win32 host=${process.platform}`)
} else {
  const child = spawn(packagedElectronPath(), [path.resolve(__filename)], {
    env: buildChildEnvironment(process.env, {
      ELECTRON_RUN_AS_NODE: '1',
      [CHILD_MARKER]: '1',
    }),
    stdio: 'inherit',
    windowsHide: true,
  })
  child.on('error', (error) => {
    console.error(error)
    process.exitCode = 1
  })
  child.on('exit', (code) => {
    process.exitCode = code ?? 1
  })
}
