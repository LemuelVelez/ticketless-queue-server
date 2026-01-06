import { UserModel } from "../models/User"
import { hashPassword } from "../controllers/security"

export type SeedAdminOptions = {
    email: string
    password: string
    name?: string
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

    const { salt, hash, algo, iterations } = await hashPassword(opts.password)

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
