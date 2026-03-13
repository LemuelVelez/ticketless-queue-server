import { pbkdf2Sync, randomBytes } from "crypto"
import { UserModel } from "../models/Model"

export type SeedAdminOptions = {
    email: string
    password: string
    name?: string
}

const PASSWORD_ALGO = "pbkdf2-sha256" as const
const PASSWORD_ITERATIONS = 150000
const PASSWORD_KEY_LENGTH = 32

function hashPassword(password: string) {
    const normalized = String(password ?? "")
    const salt = randomBytes(16).toString("hex")
    const hash = pbkdf2Sync(
        normalized,
        salt,
        PASSWORD_ITERATIONS,
        PASSWORD_KEY_LENGTH,
        "sha256"
    ).toString("hex")

    return {
        salt,
        hash,
        algo: PASSWORD_ALGO,
        iterations: PASSWORD_ITERATIONS,
    }
}

export async function seedAdminUser(opts: SeedAdminOptions) {
    const email = opts.email.trim().toLowerCase()
    const name = (opts.name || "Super Admin").trim()

    const existing = await UserModel.findOne({ email })
    if (existing) {
        // If exists but is not admin, do not overwrite role silently
        if (existing.role !== "ADMIN") {
            throw new Error(`User ${email} already exists but is not ADMIN`)
        }
        return { created: false, userId: String(existing._id) }
    }

    const { salt, hash, algo, iterations } = hashPassword(opts.password)

    const user = await UserModel.create({
        name,
        email,
        role: "ADMIN",
        active: true,
        passwordSalt: salt,
        passwordHash: hash,
        passwordAlgo: algo,
        passwordIterations: iterations,
    })

    return { created: true, userId: String(user._id) }
}