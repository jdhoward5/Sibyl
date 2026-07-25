export interface NpmInvocationOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  execPath?: string
  fileExists?: (file: string) => boolean
}

export interface NpmInvocation {
  command: string
  args: string[]
}

export function npmInvocation(options?: NpmInvocationOptions): NpmInvocation
