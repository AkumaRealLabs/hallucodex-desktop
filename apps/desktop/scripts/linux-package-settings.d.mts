/**
 * Resolve Linux package metadata without inventing a publisher or distribution URL.
 * @param env - File-owned packaging settings.
 * @returns Explicit development mode or complete deb metadata.
 */
export function resolveLinuxPackageSettings(env: NodeJS.ProcessEnv): { developmentAppImage: boolean, maintainer?: string, homepage?: string }
