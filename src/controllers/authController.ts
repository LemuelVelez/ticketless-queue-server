import type { Request, Response } from "express"
import crypto from "crypto"

import { UserModel } from "../models/User"
import { signToken, verifyPassword, hashPassword } from "./security"
import { sendPasswordResetEmail } from "../lib/mailer"

function normalizeEmail(email: unknown) {
    return String(email ?? "").toLowerCase().trim()
}

function sha256Hex(input: string) {
    return crypto.createHash("sha256").update(input).digest("hex")
}

async function login(req: Request, res: Response, role: "ADMIN" | "STAFF") {
    const { email, password } = req.body || {}
    if (!email || !password) return res.status(400).json({ message: "email and password are required" })

    const user = await UserModel.findOne({ email: String(email).toLowerCase().trim(), role, active: true })
    if (!user) return res.status(401).json({ message: "Invalid credentials" })

    const ok = await verifyPassword(String(password), user.passwordSalt, user.passwordHash, user.passwordIterations)
    if (!ok) return res.status(401).json({ message: "Invalid credentials" })

    const secret = process.env.JWT_SECRET
    if (!secret) return res.status(500).json({ message: "JWT_SECRET missing" })

    const token = signToken(
        {
            sub: String(user._id),
            role: user.role,
            name: user.name,
            assignedDepartment: user.assignedDepartment ? String(user.assignedDepartment) : undefined,
            assignedWindow: user.assignedWindow ? String(user.assignedWindow) : undefined,
        },
        secret,
        60 * 60 * 12
    )

    return res.json({
        token,
        user: {
            id: String(user._id),
            name: user.name,
            email: user.email,
            role: user.role,
            assignedDepartment: user.assignedDepartment ? String(user.assignedDepartment) : null,
            assignedWindow: user.assignedWindow ? String(user.assignedWindow) : null,
        },
    })
}

export const authController = {
    adminLogin: (req: Request, res: Response) => login(req, res, "ADMIN"),
    staffLogin: (req: Request, res: Response) => login(req, res, "STAFF"),

    me: async (req: Request, res: Response) => {
        const u = (req as any).user
        return res.json({ user: u || null })
    },

    // ✅ POST /auth/password/forgot
    forgotPassword: async (req: Request, res: Response) => {
        const { email } = req.body || {}
        const cleanEmail = normalizeEmail(email)

        if (!cleanEmail) return res.status(400).json({ message: "email is required" })

        // Security: do not reveal if email exists
        const user = await UserModel.findOne({ email: cleanEmail, active: true })
        if (!user) return res.json({ ok: true })

        // Generate token (sent to email), store only hash in DB
        const token = crypto.randomBytes(32).toString("hex")
        const tokenHash = sha256Hex(token)

        const expiresMinutes = 60
        const expiresAt = new Date(Date.now() + expiresMinutes * 60 * 1000)

        user.passwordResetTokenHash = tokenHash
        user.passwordResetExpiresAt = expiresAt
        await user.save()

        // Build reset link (optional but recommended)
        const frontendUrl =
            process.env.FRONTEND_URL || process.env.CLIENT_URL || process.env.APP_URL || ""

        const base = frontendUrl ? frontendUrl.replace(/\/$/, "") : ""
        const resetLink = base
            ? `${base}/reset-password?token=${encodeURIComponent(token)}`
            : undefined

        // Send email using Gmail env vars
        await sendPasswordResetEmail({
            to: user.email,
            name: user.name,
            resetLink,
            token,
            expiresMinutes,
        })

        return res.json({ ok: true })
    },

    // ✅ POST /auth/password/reset
    resetPassword: async (req: Request, res: Response) => {
        const { token, password } = req.body || {}

        const cleanToken = String(token ?? "").trim()
        const cleanPassword = String(password ?? "")

        if (!cleanToken || !cleanPassword) {
            return res.status(400).json({ message: "token and password are required" })
        }

        if (cleanPassword.length < 8) {
            return res.status(400).json({ message: "Password must be at least 8 characters" })
        }

        const tokenHash = sha256Hex(cleanToken)

        const user = await UserModel.findOne({
            passwordResetTokenHash: tokenHash,
            passwordResetExpiresAt: { $gt: new Date() },
            active: true,
        })

        if (!user) return res.status(400).json({ message: "Invalid or expired token" })

        const { salt, hash, algo, iterations } = await hashPassword(cleanPassword)
        user.passwordSalt = salt
        user.passwordHash = hash
        user.passwordAlgo = algo
        user.passwordIterations = iterations

        // Clear reset fields
        user.passwordResetTokenHash = undefined
        user.passwordResetExpiresAt = undefined

        await user.save()

        return res.json({ ok: true })
    },
}
