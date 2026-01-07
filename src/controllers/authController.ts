import type { Request, Response } from "express"
import crypto from "crypto"

import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

import { UserModel } from "../models/User"
import { signToken, verifyPassword, hashPassword } from "./security"
import { sendPasswordResetEmail } from "../lib/mailer"
import { fileExtFromContentType, getEnvOrThrow, getS3Client, s3ObjectUrl } from "../s3"

function normalizeEmail(email: unknown) {
    return String(email ?? "").toLowerCase().trim()
}

function sha256Hex(input: string) {
    return crypto.createHash("sha256").update(input).digest("hex")
}

function respondWithSession(res: Response, user: any) {
    const secret = process.env.JWT_SECRET
    if (!secret) return res.status(500).json({ message: "JWT_SECRET missing" })

    const token = signToken(
        {
            sub: String(user._id),
            role: user.role,
            name: user.name,
            email: user.email,
            avatarKey: user.avatarKey,
            avatarUrl: user.avatarUrl,
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
            avatarKey: user.avatarKey ?? null,
            avatarUrl: user.avatarUrl ?? null,
        },
    })
}

async function login(req: Request, res: Response, role: "ADMIN" | "STAFF") {
    const { email, password } = req.body || {}
    if (!email || !password) return res.status(400).json({ message: "email and password are required" })

    const user = await UserModel.findOne({ email: String(email).toLowerCase().trim(), role, active: true })
    if (!user) return res.status(401).json({ message: "Invalid credentials" })

    const ok = await verifyPassword(String(password), user.passwordSalt, user.passwordHash, user.passwordIterations)
    if (!ok) return res.status(401).json({ message: "Invalid credentials" })

    return respondWithSession(res, user)
}

export const authController = {
    adminLogin: (req: Request, res: Response) => login(req, res, "ADMIN"),
    staffLogin: (req: Request, res: Response) => login(req, res, "STAFF"),

    me: async (req: Request, res: Response) => {
        const u = (req as any).user
        return res.json({ user: u || null })
    },

    /**
     * PATCH /auth/me
     * Updates current user's name/email/password/avatar.
     * Returns a refreshed token + user object.
     */
    updateMe: async (req: Request, res: Response) => {
        const u = (req as any).user
        const userId = String(u?.id ?? "")
        if (!userId) return res.status(401).json({ message: "Unauthorized" })

        const user = await UserModel.findById(userId)
        if (!user) return res.status(401).json({ message: "Unauthorized" })

        const { name, email, currentPassword, newPassword, avatarKey, avatarUrl } = req.body || {}

        // Name
        if (name !== undefined) {
            const n = String(name).trim()
            if (!n) return res.status(400).json({ message: "name is required" })
            user.name = n
        }

        // Email (require current password for safety)
        if (email !== undefined) {
            const nextEmail = normalizeEmail(email)
            if (!nextEmail) return res.status(400).json({ message: "email is required" })

            if (nextEmail !== user.email) {
                if (!currentPassword) return res.status(400).json({ message: "currentPassword is required to change email" })

                const ok = await verifyPassword(String(currentPassword), user.passwordSalt, user.passwordHash, user.passwordIterations)
                if (!ok) return res.status(401).json({ message: "Invalid current password" })

                const exists = await UserModel.findOne({ email: nextEmail, _id: { $ne: user._id } }).select("_id").lean()
                if (exists) return res.status(409).json({ message: "Email already exists" })

                user.email = nextEmail
            }
        }

        // Password change (require current password)
        if (newPassword !== undefined) {
            const np = String(newPassword)
            if (!currentPassword) return res.status(400).json({ message: "currentPassword is required to change password" })
            if (np.length < 8) return res.status(400).json({ message: "Password must be at least 8 characters" })

            const ok = await verifyPassword(String(currentPassword), user.passwordSalt, user.passwordHash, user.passwordIterations)
            if (!ok) return res.status(401).json({ message: "Invalid current password" })

            const { salt, hash, algo, iterations } = await hashPassword(np)
            user.passwordSalt = salt
            user.passwordHash = hash
            user.passwordAlgo = algo
            user.passwordIterations = iterations
        }

        // Avatar fields (null clears, string sets)
        if (avatarKey !== undefined) {
            const v = avatarKey === null ? null : String(avatarKey).trim()
            user.avatarKey = v ? v : undefined
        }
        if (avatarUrl !== undefined) {
            const v = avatarUrl === null ? null : String(avatarUrl).trim()
            user.avatarUrl = v ? v : undefined
        }

        await user.save()
        return respondWithSession(res, user)
    },

    /**
     * PUT /auth/me/avatar
     * Backend-proxy avatar upload (avoids browser->S3 CORS entirely).
     * Expects raw binary body with Content-Type: image/*
     */
    uploadAvatar: async (req: Request, res: Response) => {
        const u = (req as any).user
        const userId = String(u?.id ?? "")
        if (!userId) return res.status(401).json({ message: "Unauthorized" })

        const user = await UserModel.findById(userId)
        if (!user) return res.status(401).json({ message: "Unauthorized" })

        const ct = String(req.headers["content-type"] ?? "").trim()
        if (!ct.startsWith("image/")) return res.status(400).json({ message: "Content-Type must be an image/*" })

        const ext = fileExtFromContentType(ct)
        if (!ext) return res.status(400).json({ message: "Unsupported image type" })

        const body = req.body
        if (!Buffer.isBuffer(body) || body.length === 0) {
            return res.status(400).json({ message: "Missing image body" })
        }

        // Keep same UX rule as frontend (max 5MB)
        if (body.length > 5 * 1024 * 1024) {
            return res.status(400).json({ message: "Please use an image up to 5MB." })
        }

        const bucket = getEnvOrThrow("S3_BUCKET_NAME")
        const region = getEnvOrThrow("AWS_REGION")

        const rand = crypto.randomBytes(8).toString("hex")
        const key = `avatars/${userId}/${Date.now()}-${rand}.${ext}`

        const s3 = getS3Client()
        await s3.send(
            new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: body,
                ContentType: ct,
            })
        )

        user.avatarKey = key
        user.avatarUrl = s3ObjectUrl(bucket, region, key)
        await user.save()

        return respondWithSession(res, user)
    },

    /**
     * POST /auth/me/avatar/presign
     * Generates a presigned PUT URL for uploading an avatar to S3.
     */
    presignAvatarUpload: async (req: Request, res: Response) => {
        const u = (req as any).user
        const userId = String(u?.id ?? "")
        if (!userId) return res.status(401).json({ message: "Unauthorized" })

        const { contentType } = req.body || {}
        const ct = String(contentType ?? "").trim()
        if (!ct) return res.status(400).json({ message: "contentType is required" })

        const ext = fileExtFromContentType(ct)
        if (!ext) return res.status(400).json({ message: "Unsupported image type" })

        const bucket = getEnvOrThrow("S3_BUCKET_NAME")
        const region = getEnvOrThrow("AWS_REGION")

        const rand = crypto.randomBytes(8).toString("hex")
        const key = `avatars/${userId}/${Date.now()}-${rand}.${ext}`

        const s3 = getS3Client()
        const cmd = new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            ContentType: ct,
        })

        const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 60 }) // 60s
        const objectUrl = s3ObjectUrl(bucket, region, key)

        return res.json({ uploadUrl, key, objectUrl })
    },

    /**
     * GET /auth/me/avatar/url
     * Returns a URL usable by the frontend to display the avatar.
     */
    getMyAvatarUrl: async (req: Request, res: Response) => {
        const u = (req as any).user
        const userId = String(u?.id ?? "")
        if (!userId) return res.status(401).json({ message: "Unauthorized" })

        const user = await UserModel.findById(userId).select("avatarKey avatarUrl").lean()
        if (!user) return res.status(401).json({ message: "Unauthorized" })

        if (user.avatarKey) {
            try {
                const bucket = getEnvOrThrow("S3_BUCKET_NAME")
                const s3 = getS3Client()
                const getCmd = new GetObjectCommand({ Bucket: bucket, Key: user.avatarKey })
                const url = await getSignedUrl(s3, getCmd, { expiresIn: 60 * 5 }) // 5 minutes
                return res.json({ url })
            } catch {
                // fall through
            }
        }

        return res.json({ url: user.avatarUrl ?? null })
    },

    emailExists: async (req: Request, res: Response) => {
        const { email } = req.body || {}
        const cleanEmail = normalizeEmail(email)
        if (!cleanEmail) return res.status(400).json({ message: "email is required" })

        const user = await UserModel.findOne({ email: cleanEmail, active: true }).select("_id").lean()
        return res.json({ exists: Boolean(user) })
    },

    forgotPassword: async (req: Request, res: Response) => {
        const { email } = req.body || {}
        const cleanEmail = normalizeEmail(email)

        if (!cleanEmail) return res.status(400).json({ message: "email is required" })

        const user = await UserModel.findOne({ email: cleanEmail, active: true })
        if (!user) return res.status(404).json({ message: "Email not found" })

        const token = crypto.randomBytes(32).toString("hex")
        const tokenHash = sha256Hex(token)

        const expiresMinutes = 60
        const expiresAt = new Date(Date.now() + expiresMinutes * 60 * 1000)

        user.passwordResetTokenHash = tokenHash
        user.passwordResetExpiresAt = expiresAt
        await user.save()

        await sendPasswordResetEmail({
            to: user.email,
            name: user.name,
            token,
            expiresMinutes,
        })

        return res.json({ ok: true })
    },

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

        user.passwordResetTokenHash = undefined
        user.passwordResetExpiresAt = undefined

        await user.save()

        return res.json({ ok: true })
    },
}
