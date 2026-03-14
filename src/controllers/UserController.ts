import { randomBytes, pbkdf2Sync } from "crypto"
import type { NextFunction, Request, Response } from "express"
import { Types } from "mongoose"
import { sendLoginCredentialsEmail } from "../lib/mailer"
import { AuditLogModel, UserModel } from "../models/Model"
import { UserService } from "../services/UserService"
import { ControllerUtils } from "./ControllerUtils"

function isValidObjectId(value: string): boolean {
    return Types.ObjectId.isValid(String(value ?? "").trim())
}

function normalizeEmail(value: unknown): string {
    return String(value ?? "").trim().toLowerCase()
}

function buildTemporaryPassword() {
    const left = randomBytes(4).toString("hex").toUpperCase()
    const right = randomBytes(4).toString("hex")
    return `QP-${left}-${right}`
}

function hashPassword(password: string, salt: string, iterations: number) {
    return pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex")
}

function normalizeAccountRole(
    value: unknown
): "ADMIN" | "STAFF" | "STUDENT" | "ALUMNI_VISITOR" | "GUEST" | "" {
    const raw = String(value ?? "")
        .trim()
        .toUpperCase()
        .replace(/[\s/-]+/g, "_")

    if (raw === "ADMIN") return "ADMIN"
    if (raw === "STAFF") return "STAFF"
    if (raw === "STUDENT") return "STUDENT"
    if (raw === "ALUMNI_VISITOR" || raw === "ALUMNI" || raw === "VISITOR") {
        return "ALUMNI_VISITOR"
    }
    if (raw === "GUEST") return "GUEST"

    return ""
}

function isStaffAccountRole(role: string): role is "ADMIN" | "STAFF" {
    return role === "ADMIN" || role === "STAFF"
}

function parseBooleanLike(value: unknown, fallback = false): boolean {
    if (typeof value === "boolean") return value
    const raw = String(value ?? "").trim().toLowerCase()
    if (!raw) return fallback
    if (["1", "true", "yes", "y", "on"].includes(raw)) return true
    if (["0", "false", "no", "n", "off"].includes(raw)) return false
    return fallback
}

function hasOwn(object: unknown, key: string): boolean {
    return !!object && typeof object === "object"
        ? Object.prototype.hasOwnProperty.call(object, key)
        : false
}

function getActorId(req: Request): Types.ObjectId | undefined {
    const actorRaw =
        (req as any)?.user?._id ||
        (req as any)?.user?.id ||
        (req as any)?.auth?.userId ||
        ""

    return actorRaw && Types.ObjectId.isValid(String(actorRaw))
        ? new Types.ObjectId(String(actorRaw))
        : undefined
}

function getErrorMessage(error: unknown, fallback: string) {
    return error instanceof Error ? error.message : fallback
}

type IssueCredentialsMode = "send" | "resend"

export class UserController {
    private static async buildUserView(userId: string) {
        return (await UserService.getById(userId)) ?? null
    }

    private static async writeAuditLog(
        req: Request,
        action: string,
        user: any,
        meta?: Record<string, unknown>
    ) {
        try {
            await AuditLogModel.create({
                actor: getActorId(req),
                actorRole: (req as any)?.user?.role,
                action,
                entityType: "User",
                entityId: user?._id,
                meta,
                createdAt: new Date(),
            })
        } catch {
            // do not fail the main request if audit logging fails
        }
    }

    private static async issueLoginCredentials(
        req: Request,
        res: Response,
        next: NextFunction,
        mode: IssueCredentialsMode
    ): Promise<void> {
        try {
            const userId = ControllerUtils.getValue(
                req.params.id,
                req.params.userId,
                req.body?.id,
                req.body?.userId
            )

            if (!userId) {
                ControllerUtils.sendBadRequest(res, "userId is required")
                return
            }

            if (!isValidObjectId(userId)) {
                ControllerUtils.sendBadRequest(res, "Invalid userId")
                return
            }

            const user = await UserModel.findById(userId)

            if (!user) {
                ControllerUtils.sendNotFound(res, "User not found")
                return
            }

            if (user.role !== "STAFF" && user.role !== "ADMIN") {
                ControllerUtils.sendBadRequest(
                    res,
                    "Login credentials can only be sent to staff/admin accounts"
                )
                return
            }

            const targetEmail = normalizeEmail(
                ControllerUtils.getValue(req.body?.to, req.body?.email, user.email)
            )

            if (!targetEmail) {
                ControllerUtils.sendBadRequest(
                    res,
                    "Staff email is required before sending login credentials"
                )
                return
            }

            const providedPassword = String(
                ControllerUtils.getValue(
                    req.body?.password,
                    req.body?.temporaryPassword,
                    req.body?.newPassword
                ) ?? ""
            ).trim()

            const temporaryPassword = providedPassword || buildTemporaryPassword()
            const passwordSalt = randomBytes(16).toString("hex")
            const passwordIterations = Math.max(
                Number(user.passwordIterations || 150000),
                150000
            )
            const passwordHash = hashPassword(
                temporaryPassword,
                passwordSalt,
                passwordIterations
            )

            const previousCredentials = {
                email: user.email,
                passwordSalt: user.passwordSalt,
                passwordHash: user.passwordHash,
                passwordAlgo: user.passwordAlgo,
                passwordIterations: user.passwordIterations,
            }

            user.email = targetEmail
            user.passwordSalt = passwordSalt
            user.passwordHash = passwordHash
            user.passwordAlgo = "pbkdf2-sha256"
            user.passwordIterations = passwordIterations

            await user.save()

            try {
                await sendLoginCredentialsEmail({
                    to: targetEmail,
                    name: user.name,
                    email: targetEmail,
                    password: temporaryPassword,
                    role: user.role,
                    loginLink: String(req.body?.loginLink ?? "").trim() || undefined,
                })
            } catch (mailError) {
                user.email = previousCredentials.email
                user.passwordSalt = previousCredentials.passwordSalt
                user.passwordHash = previousCredentials.passwordHash
                user.passwordAlgo = previousCredentials.passwordAlgo
                user.passwordIterations = previousCredentials.passwordIterations

                try {
                    await user.save()
                } catch {
                    // ignore rollback failure and surface the original email error
                }

                throw mailError
            }

            await UserController.writeAuditLog(
                req,
                mode === "resend"
                    ? "STAFF_LOGIN_CREDENTIALS_RESENT"
                    : "STAFF_LOGIN_CREDENTIALS_SENT",
                user,
                {
                    email: targetEmail,
                    role: user.role,
                    mode,
                }
            )

            res.status(200).json({
                ok: true,
                message:
                    mode === "resend"
                        ? "Login credentials resent successfully"
                        : "Login credentials sent successfully",
                data: {
                    id: String(user._id),
                    name: user.name,
                    email: user.email,
                    role: user.role,
                },
            })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }

    static async createStaff(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {
        try {
            const name = String(req.body?.name ?? "").trim()
            const email = normalizeEmail(req.body?.email)
            const role = normalizeAccountRole(req.body?.role) || "STAFF"
            const sendCredentials = parseBooleanLike(req.body?.sendCredentials, true)
            const providedPassword = String(req.body?.password ?? "").trim()
            const loginLink = String(req.body?.loginLink ?? "").trim() || undefined

            if (!name) {
                ControllerUtils.sendBadRequest(res, "Name is required")
                return
            }

            if (!email) {
                ControllerUtils.sendBadRequest(res, "Email is required")
                return
            }

            if (!isStaffAccountRole(role)) {
                ControllerUtils.sendBadRequest(
                    res,
                    "Only STAFF or ADMIN accounts can be created from this route"
                )
                return
            }

            if (!sendCredentials && !providedPassword) {
                ControllerUtils.sendBadRequest(
                    res,
                    "Password is required when sendCredentials is disabled"
                )
                return
            }

            const existingUser = await UserModel.findOne({ email }).lean()

            if (existingUser) {
                res.status(409).json({
                    message: "A user with this email already exists",
                })
                return
            }

            const temporaryPassword = providedPassword || buildTemporaryPassword()
            const passwordSalt = randomBytes(16).toString("hex")
            const passwordIterations = 150000
            const passwordHash = hashPassword(
                temporaryPassword,
                passwordSalt,
                passwordIterations
            )

            const createdUser = await UserModel.create({
                name,
                email,
                role,
                active: parseBooleanLike(req.body?.active, true),
                passwordSalt,
                passwordHash,
                passwordAlgo: "pbkdf2-sha256",
                passwordIterations,
            })

            let credentialsSent = false
            let credentialsError = ""

            if (sendCredentials) {
                try {
                    await sendLoginCredentialsEmail({
                        to: email,
                        name,
                        email,
                        password: temporaryPassword,
                        role,
                        loginLink,
                    })

                    credentialsSent = true
                } catch (mailError) {
                    credentialsError = getErrorMessage(
                        mailError,
                        "Failed to send login credentials email"
                    )
                }
            }

            await UserController.writeAuditLog(req, "STAFF_ACCOUNT_CREATED", createdUser, {
                email,
                role,
                sendCredentials,
                credentialsSent,
                credentialsError: credentialsError || undefined,
            })

            const data =
                (await UserController.buildUserView(String(createdUser._id))) ??
                UserService.toView(createdUser)

            res.status(201).json({
                data,
                credentials: {
                    attempted: sendCredentials,
                    sent: credentialsSent,
                    error: credentialsError || undefined,
                },
                message:
                    sendCredentials && !credentialsSent
                        ? "Account created, but credentials email failed to send"
                        : "Account created successfully",
            })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }

    static async updateById(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {
        try {
            const userId = ControllerUtils.getValue(
                req.params.id,
                req.params.userId,
                req.body?.id,
                req.body?.userId
            )

            if (!userId) {
                ControllerUtils.sendBadRequest(res, "userId is required")
                return
            }

            if (!isValidObjectId(userId)) {
                ControllerUtils.sendBadRequest(res, "Invalid userId")
                return
            }

            const user = await UserModel.findById(userId)

            if (!user) {
                ControllerUtils.sendNotFound(res, "User not found")
                return
            }

            if (hasOwn(req.body, "name")) {
                const name = String(req.body?.name ?? "").trim()
                if (!name) {
                    ControllerUtils.sendBadRequest(res, "Name is required")
                    return
                }
                user.name = name
            }

            if (hasOwn(req.body, "email")) {
                const email = normalizeEmail(req.body?.email)
                if (!email) {
                    ControllerUtils.sendBadRequest(res, "Email is required")
                    return
                }

                const existingUser = await UserModel.findOne({
                    email,
                    _id: { $ne: user._id },
                }).lean()

                if (existingUser) {
                    res.status(409).json({
                        message: "A user with this email already exists",
                    })
                    return
                }

                user.email = email
            }

            if (hasOwn(req.body, "role")) {
                const role = normalizeAccountRole(req.body?.role)
                if (!role) {
                    ControllerUtils.sendBadRequest(res, "Invalid role")
                    return
                }
                user.role = role
            }

            if (hasOwn(req.body, "active")) {
                user.active = parseBooleanLike(req.body?.active, Boolean(user.active))
            }

            const nextPassword = String(req.body?.password ?? "").trim()
            if (nextPassword) {
                const passwordSalt = randomBytes(16).toString("hex")
                const passwordIterations = Math.max(
                    Number(user.passwordIterations || 150000),
                    150000
                )

                user.passwordSalt = passwordSalt
                user.passwordHash = hashPassword(
                    nextPassword,
                    passwordSalt,
                    passwordIterations
                )
                user.passwordAlgo = "pbkdf2-sha256"
                user.passwordIterations = passwordIterations
            }

            await user.save()

            await UserController.writeAuditLog(req, "USER_ACCOUNT_UPDATED", user, {
                updatedFields: Object.keys(req.body || {}).filter(Boolean),
                passwordUpdated: Boolean(nextPassword),
            })

            const data =
                (await UserController.buildUserView(String(user._id))) ??
                UserService.toView(user)

            res.status(200).json({
                data,
                message: nextPassword
                    ? "Account and credential updated successfully"
                    : "Account updated successfully",
            })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }

    static async deleteById(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {
        try {
            const userId = ControllerUtils.getValue(
                req.params.id,
                req.params.userId,
                req.body?.id,
                req.body?.userId
            )

            if (!userId) {
                ControllerUtils.sendBadRequest(res, "userId is required")
                return
            }

            if (!isValidObjectId(userId)) {
                ControllerUtils.sendBadRequest(res, "Invalid userId")
                return
            }

            const user = await UserModel.findById(userId)

            if (!user) {
                ControllerUtils.sendNotFound(res, "User not found")
                return
            }

            const data =
                (await UserController.buildUserView(String(user._id))) ??
                UserService.toView(user)

            const deleteResult = await UserModel.deleteOne({
                _id: user._id,
            }).exec()

            if (!deleteResult.deletedCount) {
                res.status(500).json({
                    message: "Failed to delete user",
                })
                return
            }

            await UserController.writeAuditLog(req, "USER_ACCOUNT_DELETED", user, {
                email: user.email,
                role: user.role,
            })

            res.status(200).json({
                ok: true,
                data,
                message: "Account deleted successfully",
            })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }

    static async sendLoginCredentials(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {
        return UserController.issueLoginCredentials(req, res, next, "send")
    }

    static async resendLoginCredentials(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {
        return UserController.issueLoginCredentials(req, res, next, "resend")
    }

    static async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const userId = ControllerUtils.getValue(req.params.id, req.params.userId)

            if (!userId) {
                ControllerUtils.sendBadRequest(res, "userId is required")
                return
            }

            if (!isValidObjectId(userId)) {
                ControllerUtils.sendBadRequest(res, "Invalid userId")
                return
            }

            const user = await UserService.getById(userId)

            if (!user) {
                ControllerUtils.sendNotFound(res, "User not found")
                return
            }

            res.status(200).json({ data: user })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }

    static async getByStudentId(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const studentId = ControllerUtils.getValue(
                req.params.studentId,
                req.query.studentId
            )

            if (!studentId) {
                ControllerUtils.sendBadRequest(res, "studentId is required")
                return
            }

            const user = await UserService.getByStudentId(studentId)

            if (!user) {
                ControllerUtils.sendNotFound(res, "User not found")
                return
            }

            res.status(200).json({ data: user })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }

    static async listStaff(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const includeInactive = ControllerUtils.parseBoolean(
                req.query.includeInactive,
                false
            )

            const users = await UserService.listStaff(includeInactive)

            res.status(200).json({
                data: users,
                count: users.length,
            })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }

    static async listParticipants(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const includeInactive = ControllerUtils.parseBoolean(
                req.query.includeInactive,
                false
            )

            const users = await UserService.listParticipants(includeInactive)

            res.status(200).json({
                data: users,
                count: users.length,
            })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }
}