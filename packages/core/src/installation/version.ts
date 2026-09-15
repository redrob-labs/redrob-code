declare global {
  const REDROB_VERSION: string
  const REDROB_CHANNEL: string
}

export const InstallationVersion = typeof REDROB_VERSION === "string" ? REDROB_VERSION : "local"
export const InstallationChannel = typeof REDROB_CHANNEL === "string" ? REDROB_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
