import crypto from "crypto"

function base64url(input: Buffer | string) {
    const b = Buffer.isBuffer(input) ? input : Buffer.from(input)
    return b
        .toString("base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
}

function base64urlToBuffer(input: string) {
    const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4))
    const s = input.replace(/-/g, "+").replace(/_/g, "/") + pad
    return Buffer.from(s, "base64")
}

export async function hashPassword(password: string) {
    const salt = crypto.randomBytes(16).toString("hex")
    const iterations = 150000
    const keylen = 32
    const digest = "sha256"

    const hash = crypto.pbkdf2Sync(password, salt, iterations, keylen, digest).toString("hex")

    return {
        algo: "pbkdf2-sha256" as const,
        salt,
        hash,
        iterations,
    }
}

export async function verifyPassword(password: string, salt: string, expectedHash: string, iterations: number) {
    const keylen = 32
    const digest = "sha256"
    const computed = crypto.pbkdf2Sync(password, salt, iterations, keylen, digest).toString("hex")
    return crypto.timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(expectedHash, "hex"))
}

// Minimal JWT (HS256) without external deps
type JwtPayload = Record<string, unknown> & { exp: number; iat: number }

export function signToken(payload: Record<string, unknown>, secret: string, expiresInSeconds = 60 * 60 * 12) {
    const header = { alg: "HS256", typ: "JWT" }
    const now = Math.floor(Date.now() / 1000)

    const fullPayload: JwtPayload = {
        ...payload,
        iat: now,
        exp: now + expiresInSeconds,
    }

    const part1 = base64url(JSON.stringify(header))
    const part2 = base64url(JSON.stringify(fullPayload))
    const data = `${part1}.${part2}`

    const sig = crypto.createHmac("sha256", secret).update(data).digest()
    const part3 = base64url(sig)

    return `${part1}.${part2}.${part3}`
}

export function verifyToken(token: string, secret: string): JwtPayload {
    const parts = token.split(".")
    if (parts.length !== 3) throw new Error("Invalid token")

    const [p1, p2, p3] = parts
    const data = `${p1}.${p2}`

    const expectedSig = crypto.createHmac("sha256", secret).update(data).digest()
    const givenSig = base64urlToBuffer(p3)

    if (givenSig.length !== expectedSig.length || !crypto.timingSafeEqual(givenSig, expectedSig)) {
        throw new Error("Invalid signature")
    }

    const payload = JSON.parse(base64urlToBuffer(p2).toString("utf8")) as JwtPayload
    const now = Math.floor(Date.now() / 1000)
    if (!payload.exp || now > payload.exp) throw new Error("Token expired")

    return payload
}
