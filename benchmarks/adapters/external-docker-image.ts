import { runDockerCommand } from '../worker/docker-client'

/** Returns the Docker image ID reported by `docker image inspect`. */
export async function dockerImageId(image: string): Promise<string> {
  const result = await runDockerCommand([
    'image',
    'inspect',
    '--format',
    '{{.Id}}',
    image,
  ])
  const value = result.stdout.trim()
  if (!/^sha256:[a-f0-9]{64}$/u.test(value))
    throw new Error('Docker image digest is invalid')
  return value
}

/** Checks whether Docker can inspect the requested image. */
export async function dockerImageExists(image: string): Promise<boolean> {
  const result = await runDockerCommand(
    ['image', 'inspect', '--format', '{{.Id}}', image],
    {
      allowFailure: true,
      maxOutputBytes: 1_024,
    },
  )
  return result.exitCode === 0
}

/** Returns the workspace path label stored in the Docker image metadata. */
export async function dockerImageWorkspace(image: string): Promise<string> {
  const result = await runDockerCommand([
    'image',
    'inspect',
    '--format',
    '{{.Config.WorkingDir}}',
    image,
  ])
  const value = result.stdout.trim().replace(/\/+$/u, '')
  if (!value.startsWith('/') || value === '/')
    throw new Error('External task image has no safe native workspace')
  return value
}
