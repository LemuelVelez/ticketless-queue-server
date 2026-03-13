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

type IssueCredentialsMode = "send" | "resend"

export class UserController {
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

            const actorRaw =
                (req as any)?.user?._id ||
                (req as any)?.user?.id ||
                (req as any)?.auth?.userId ||
                ""

            const actorId =
                actorRaw && Types.ObjectId.isValid(String(actorRaw))
                    ? new Types.ObjectId(String(actorRaw))
                    : undefined

            try {
                await AuditLogModel.create({
                    actor: actorId,
                    actorRole: (req as any)?.user?.role,
                    action:
                        mode === "resend"
                            ? "STAFF_LOGIN_CREDENTIALS_RESENT"
                            : "STAFF_LOGIN_CREDENTIALS_SENT",
                    entityType: "User",
                    entityId: user._id,
                    meta: {
                        email: targetEmail,
                        role: user.role,
                        mode,
                    },
                    createdAt: new Date(),
                })
            } catch {
                // do not fail the main request if audit logging fails
            }

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