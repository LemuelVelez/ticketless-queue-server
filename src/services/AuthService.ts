import {
    createHash,
    createHmac,
    pbkdf2Sync,
    randomBytes,
    timingSafeEqual,
} from "crypto"
import { Types } from "mongoose"
import type { ParticipantType, UserDoc, UserRole } from "../models/Model"
import { UserModel } from "../models/Model"
import { UserService, type UserView } from "./UserService"

const DEFAULT_PASSWORD_ITERATIONS = 150000
const DEFAULT_ACCESS_TOKEN_TTL_HOURS = 24
const DEFAULT_RESET_TOKEN_TTL_MINUTES = 60
const ACCESS_TOKEN_TYPE = "access"

const participantRoles: ParticipantType[] = [
    "STUDENT",
    "ALUMNI_VISITOR",
    "GUEST",
]

export type AccessTokenPayload = {
    sub: string
    role: UserRole
    email?: string
    iat: number
    exp: number
    type: "access"
}

export type AuthResult = {
    accessToken: string
    user: UserView
}

export class AuthError extends Error {
    status: number

    constructor(message: string, status = 400) {
        super(message)
        this.name = "AuthError"
        this.status = status
    }
}

type RegisterParticipantInput = {
    type?: string
    name?: string
    firstName?: string
    middleName?: string
    lastName?: string
    email?: string
    studentId?: string
    tcNumber?: string
    mobileNumber?: string
    phone?: string
    departmentId?: string
    password?: string
    pin?: string
    smsUpdates?: boolean
}

type LoginInput = {
    identifier?: string
    email?: string
    studentId?: string
    tcNumber?: string
    password?: string
    pin?: string
}

type ForgotPasswordInput = {
    identifier?: string
    email?: string
    studentId?: string
    tcNumber?: string
}

type ResetPasswordInput = {
    token?: string
    password?: string
    newPassword?: string
    pin?: string
}

function normalizeString(value: unknown): string {
    return String(value ?? "").trim()
}

function normalizeOptionalString(value: unknown): string | undefined {
    const normalized = normalizeString(value)
    return normalized || undefined
}

function normalizeEmail(value: unknown): string | undefined {
    const email = normalizeString(value).toLowerCase()
    return email || undefined
}

function isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function parsePositiveInteger(
    value: string | undefined,
    fallback: number
): number {
    const parsed = Number.parseInt(String(value ?? "").trim(), 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function hashRawToken(token: string): string {
    return createHash("sha256").update(token).digest("hex")
}

function toBase64Url(value: string): string {
    return Buffer.from(value, "utf8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "")
}

function fromBase64Url(value: string): string {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/")
    const padLength = (4 - (normalized.length % 4)) % 4
    const padded = normalized + "=".repeat(padLength)

    return Buffer.from(padded, "base64").toString("utf8")
}

function base64ToUrlSafe(value: string): string {
    return value
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "")
}

function getAuthSecret(): string {
    const secret =
        process.env.AUTH_SECRET?.trim() ||
        process.env.JWT_SECRET?.trim() ||
        process.env.SESSION_SECRET?.trim()

    if (secret) return secret

    if ((process.env.NODE_ENV ?? "").trim() !== "production") {
        return "dev-insecure-auth-secret"
    }

    throw new AuthError("AUTH_SECRET is required in production", 500)
}

function buildPasswordHash(
    password: string,
    salt: string,
    iterations: number
): string {
    return pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex")
}

function buildSafeBuffer(value: string): Buffer {
    return Buffer.from(value, "utf8")
}

function buildDisplayName(input: RegisterParticipantInput): string {
    const explicitName = normalizeString(input.name)
    if (explicitName) return explicitName

    const composed = [
        normalizeString(input.firstName),
        normalizeString(input.middleName),
        normalizeString(input.lastName),
    ]
        .filter(Boolean)
        .join(" ")

    return composed
}

function getDuplicateField(error: any): string {
    if (error?.keyPattern && typeof error.keyPattern === "object") {
        const field = Object.keys(error.keyPattern)[0]
        if (field) return field
    }

    if (error?.keyValue && typeof error.keyValue === "object") {
        const field = Object.keys(error.keyValue)[0]
        if (field) return field
    }

    return "field"
}

export class AuthService {
    private static getAccessTokenTtlMs(): number {
        const hours = parsePositiveInteger(
            process.env.AUTH_TOKEN_TTL_HOURS,
            DEFAULT_ACCESS_TOKEN_TTL_HOURS
        )
        return hours * 60 * 60 * 1000
    }

    private static getResetTokenTtlMs(): number {
        const minutes = parsePositiveInteger(
            process.env.AUTH_RESET_TOKEN_TTL_MINUTES,
            DEFAULT_RESET_TOKEN_TTL_MINUTES
        )
        return minutes * 60 * 1000
    }

    private static shouldReturnResetToken(): boolean {
        if (String(process.env.AUTH_RETURN_RESET_TOKEN ?? "").trim() === "true") {
            return true
        }

        return (process.env.NODE_ENV ?? "").trim() !== "production"
    }

    static hashPassword(password: string): {
        salt: string
        hash: string
        iterations: number
        algo: "pbkdf2-sha256"
    } {
        const salt = randomBytes(16).toString("hex")
        const iterations = DEFAULT_PASSWORD_ITERATIONS
        const hash = buildPasswordHash(password, salt, iterations)

        return {
            salt,
            hash,
            iterations,
            algo: "pbkdf2-sha256",
        }
    }

    static verifyPassword(
        password: string,
        user: Pick<
            UserDoc,
            "passwordSalt" | "passwordHash" | "passwordIterations"
        >
    ): boolean {
        const calculatedHash = buildPasswordHash(
            password,
            user.passwordSalt,
            user.passwordIterations || DEFAULT_PASSWORD_ITERATIONS
        )

        const expected = buildSafeBuffer(user.passwordHash)
        const actual = buildSafeBuffer(calculatedHash)

        if (expected.length !== actual.length) return false

        return timingSafeEqual(expected, actual)
    }

    private static createAccessToken(user: {
        _id: Types.ObjectId | string
        role: UserRole
        email?: string
    }): string {
        const now = Date.now()

        const payload: AccessTokenPayload = {
            sub: String(user._id),
            role: user.role,
            email: normalizeEmail(user.email),
            iat: now,
            exp: now + this.getAccessTokenTtlMs(),
            type: ACCESS_TOKEN_TYPE,
        }

        const encodedPayload = toBase64Url(JSON.stringify(payload))
        const signature = base64ToUrlSafe(
            createHmac("sha256", getAuthSecret())
                .update(encodedPayload)
                .digest("base64")
        )

        return `${encodedPayload}.${signature}`
    }

    static verifyAccessToken(token: string): AccessTokenPayload {
        const normalizedToken = normalizeString(token)

        if (!normalizedToken.includes(".")) {
            throw new AuthError("Invalid access token", 401)
        }

        const [encodedPayload, signature] = normalizedToken.split(".")

        if (!encodedPayload || !signature) {
            throw new AuthError("Invalid access token", 401)
        }

        const expectedSignature = base64ToUrlSafe(
            createHmac("sha256", getAuthSecret())
                .update(encodedPayload)
                .digest("base64")
        )

        const expected = buildSafeBuffer(expectedSignature)
        const actual = buildSafeBuffer(signature)

        if (expected.length !== actual.length) {
            throw new AuthError("Invalid access token", 401)
        }

        if (!timingSafeEqual(expected, actual)) {
            throw new AuthError("Invalid access token", 401)
        }

        let payload: AccessTokenPayload

        try {
            payload = JSON.parse(fromBase64Url(encodedPayload)) as AccessTokenPayload
        } catch {
            throw new AuthError("Invalid access token", 401)
        }

        if (
            payload?.type !== ACCESS_TOKEN_TYPE ||
            !payload?.sub ||
            !payload?.role ||
            typeof payload?.exp !== "number"
        ) {
            throw new AuthError("Invalid access token", 401)
        }

        if (Date.now() >= payload.exp) {
            throw new AuthError("Access token has expired", 401)
        }

        return payload
    }

    private static async findUserByIdentifier(
        identifier: string
    ): Promise<any | null> {
        const normalized = normalizeString(identifier)
        if (!normalized) return null

        const email = normalized.includes("@")
            ? normalizeEmail(normalized)
            : undefined

        const conditions: Record<string, unknown>[] = [
            { studentId: normalized },
            { tcNumber: normalized },
        ]

        if (email) {
            conditions.unshift({ email })
        }

        return UserModel.findOne({
            $or: conditions,
        }).exec()
    }

    private static async buildAuthResult(user: any): Promise<AuthResult> {
        const view =
            (await UserService.getById(user._id)) ??
            UserService.toView(user)

        return {
            accessToken: this.createAccessToken(user),
            user: view,
        }
    }

    static async getCurrentUser(userId: string): Promise<UserView | null> {
        const user = await UserModel.findById(userId).exec()

        if (!user || !user.active) {
            return null
        }

        return (
            (await UserService.getById(user._id)) ??
            UserService.toView(user)
        )
    }

    static async registerParticipant(
        input: RegisterParticipantInput
    ): Promise<AuthResult> {
        try {
            const type = normalizeString(input.type).toUpperCase() as ParticipantType

            if (!participantRoles.includes(type)) {
                throw new AuthError(
                    "Registration is only allowed for STUDENT, ALUMNI_VISITOR, or GUEST",
                    400
                )
            }

            const name = buildDisplayName(input)
            if (!name) {
                throw new AuthError("Name is required", 400)
            }

            const email = normalizeEmail(input.email)
            if (email && !isValidEmail(email)) {
                throw new AuthError("Email is invalid", 400)
            }

            const studentId = normalizeOptionalString(
                input.studentId ?? input.tcNumber
            )

            if (type === "STUDENT" && !studentId) {
                throw new AuthError("studentId is required for students", 400)
            }

            const mobileNumber = normalizeOptionalString(
                input.mobileNumber ?? input.phone
            )

            if (!mobileNumber) {
                throw new AuthError("mobileNumber is required", 400)
            }

            const departmentId = normalizeOptionalString(input.departmentId)

            if (!departmentId) {
                throw new AuthError("departmentId is required", 400)
            }

            if (!Types.ObjectId.isValid(departmentId)) {
                throw new AuthError("departmentId is invalid", 400)
            }

            const password = normalizeString(input.password ?? input.pin)

            if (password.length < 4) {
                throw new AuthError(
                    "Password must be at least 4 characters long",
                    400
                )
            }

            if (email) {
                const emailExists = await UserModel.exists({ email })

                if (emailExists) {
                    throw new AuthError("Email is already in use", 409)
                }
            }

            if (studentId) {
                const studentExists = await UserModel.exists({
                    $or: [{ studentId }, { tcNumber: studentId }],
                })

                if (studentExists) {
                    throw new AuthError("studentId is already in use", 409)
                }
            }

            const passwordData = this.hashPassword(password)

            const user = await UserModel.create({
                name,
                email,
                role: type,
                active: true,
                type,
                firstName: normalizeOptionalString(input.firstName),
                middleName: normalizeOptionalString(input.middleName),
                lastName: normalizeOptionalString(input.lastName),
                tcNumber: studentId,
                studentId,
                mobileNumber,
                phone: mobileNumber,
                departmentId: new Types.ObjectId(departmentId),
                smsUpdates:
                    typeof input.smsUpdates === "boolean"
                        ? input.smsUpdates
                        : true,
                passwordSalt: passwordData.salt,
                passwordHash: passwordData.hash,
                passwordAlgo: passwordData.algo,
                passwordIterations: passwordData.iterations,
            })

            return this.buildAuthResult(user)
        } catch (error: any) {
            if (error instanceof AuthError) throw error

            if (error?.code === 11000) {
                throw new AuthError(
                    `${getDuplicateField(error)} is already in use`,
                    409
                )
            }

            throw error
        }
    }

    static async login(input: LoginInput): Promise<AuthResult> {
        const identifier = normalizeString(
            input.identifier ??
                input.email ??
                input.studentId ??
                input.tcNumber
        )

        if (!identifier) {
            throw new AuthError("identifier is required", 400)
        }

        const password = normalizeString(input.password ?? input.pin)

        if (!password) {
            throw new AuthError("password is required", 400)
        }

        const user = await this.findUserByIdentifier(identifier)

        if (!user || !user.active) {
            throw new AuthError("Invalid credentials", 401)
        }

        const passwordMatches = this.verifyPassword(password, user)

        if (!passwordMatches) {
            throw new AuthError("Invalid credentials", 401)
        }

        return this.buildAuthResult(user)
    }

    static async forgotPassword(input: ForgotPasswordInput): Promise<{
        message: string
        resetToken?: string
        resetUrl?: string
    }> {
        const identifier = normalizeString(
            input.identifier ??
                input.email ??
                input.studentId ??
                input.tcNumber
        )

        if (!identifier) {
            throw new AuthError("identifier is required", 400)
        }

        const genericMessage =
            "If the account exists, password reset instructions have been generated."

        const user = await this.findUserByIdentifier(identifier)

        if (!user || !user.active) {
            return { message: genericMessage }
        }

        const rawToken = randomBytes(32).toString("hex")
        const expiresAt = new Date(Date.now() + this.getResetTokenTtlMs())

        user.passwordResetTokenHash = hashRawToken(rawToken)
        user.passwordResetExpiresAt = expiresAt

        await user.save()

        if (!this.shouldReturnResetToken()) {
            return { message: genericMessage }
        }

        const clientBase =
            process.env.CLIENT_ORIGIN?.trim() ||
            process.env.SERVER_PUBLIC_URL?.trim()

        const resetUrl = clientBase
            ? `${clientBase.replace(/\/$/, "")}/reset-password?token=${encodeURIComponent(
                  rawToken
              )}`
            : undefined

        return {
            message: genericMessage,
            resetToken: rawToken,
            resetUrl,
        }
    }

    static async resetPassword(input: ResetPasswordInput): Promise<{
        message: string
    }> {
        const token = normalizeString(input.token)

        if (!token) {
            throw new AuthError("token is required", 400)
        }

        const newPassword = normalizeString(
            input.newPassword ?? input.password ?? input.pin
        )

        if (newPassword.length < 4) {
            throw new AuthError(
                "New password must be at least 4 characters long",
                400
            )
        }

        const user = await UserModel.findOne({
            passwordResetTokenHash: hashRawToken(token),
            passwordResetExpiresAt: { $gt: new Date() },
            active: true,
        }).exec()

        if (!user) {
            throw new AuthError("Invalid or expired reset token", 400)
        }

        const passwordData = this.hashPassword(newPassword)

        user.passwordSalt = passwordData.salt
        user.passwordHash = passwordData.hash
        user.passwordAlgo = passwordData.algo
        user.passwordIterations = passwordData.iterations
        user.passwordResetTokenHash = undefined
        user.passwordResetExpiresAt = undefined

        await user.save()

        return {
            message: "Password has been reset successfully",
        }
    }
}