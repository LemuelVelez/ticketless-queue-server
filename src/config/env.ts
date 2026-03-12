function normalizeEnvValue(value: unknown) {
    return String(value ?? "").trim()
}

export function getOptionalEnv(name: string): string | undefined {
    const value = normalizeEnvValue(process.env[name])
    return value ? value : undefined
}

export function getEnvOrThrow(name: string): string {
    const value = getOptionalEnv(name)
    if (!value) {
        throw new Error(`${name} is missing`)
    }
    return value
}

export function getBooleanEnv(name: string, fallback = false): boolean {
    const value = getOptionalEnv(name)
    if (!value) return fallback

    switch (value.toLowerCase()) {
        case "1":
        case "true":
        case "yes":
        case "y":
        case "on":
            return true
        case "0":
        case "false":
        case "no":
        case "n":
        case "off":
            return false
        default:
            return fallback
    }
}

export function getNumberEnv(name: string, fallback: number): number {
    const value = getOptionalEnv(name)
    if (!value) return fallback

    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
}

export function getNormalizedUrlEnv(name: string): string | undefined {
    const value = getOptionalEnv(name)
    if (!value) return undefined

    try {
        const url = new URL(value)
        return url.toString().replace(/\/$/, "")
    } catch {
        throw new Error(`${name} must be a valid absolute URL`)
    }
}

export function getClientOrigin() {
    return getNormalizedUrlEnv("CLIENT_ORIGIN")
}

export function getServerPublicUrl() {
    return getNormalizedUrlEnv("SERVER_PUBLIC_URL")
}

export function getSupportInbox() {
    return getOptionalEnv("SUPPORT_INBOX")
}

export function getNodeEnv() {
    return getOptionalEnv("NODE_ENV") ?? "development"
}

export function getS3Prefix() {
    const value = getOptionalEnv("S3_PREFIX") ?? "uploads"
    return value.replace(/^\/+|\/+$/g, "")
}

export function getMissingOptionalEnv(names: string[]) {
    return names.filter((name) => !getOptionalEnv(name))
}