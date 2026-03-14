import {
    createHmac,
    pbkdf2Sync,
    randomBytes,
    timingSafeEqual,
} from "crypto"
import { PutObjectCommand } from "@aws-sdk/client-s3"
import type { NextFunction, Request, Response } from "express"
import { UserModel } from "../models/Model"
import {
    buildS3ObjectKey,
    fileExtFromContentType,
    getS3BucketName,
    getS3Client,
    resolveStoredFileUrl,
    withS3Prefix,
} from "../s3"
import { ControllerUtils } from "./ControllerUtils"

type AuthenticatedRequest = Request & {
    user?: {
        _id?: unknown
        id?: unknown
        role?: unknown
        email?: unknown
        name?: unknown
    }
    auth?: {
        userId?: unknown
        sub?: unknown
    }
    currentUser?: {
        _id?: unknown
        id?: unknown
        role?: unknown
        email?: unknown
        name?: unknown
    }
}

type UploadTokenPayload = {
    sub: string
    key: string
    contentType: string
    exp: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
}

function normalizeString(value: unknown): string {
    return String(value ?? "").trim()
}

function normalizeOptionalString(value: unknown): string | undefined {
    const clean = normalizeString(value)
    return clean || undefined
}

function normalizeNullableString(value: unknown): string | null {
    const clean = normalizeString(value)
    return clean || null
}

function normalizeEmail(value: unknown): string {
    return normalizeString(value).toLowerCase()
}

function normalizeBoolean(value: unknown, fallback = false): boolean {
    if (typeof value === "boolean") return value

    const raw = normalizeString(value).toLowerCase()
    if (!raw) return fallback

    if (["1", "true", "yes", "y", "on"].includes(raw)) return true
    if (["0", "false", "no", "n", "off"].includes(raw)) return false

    return fallback
}

function hasOwn(value: unknown, key: string) {
    return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key)
}

function hashPassword(password: string, salt: string, iterations: number) {
    return pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex")
}

function verifyPassword(user: any, password: string) {
    const passwordHash = normalizeString(user?.passwordHash)
    const passwordSalt = normalizeString(user?.passwordSalt)
    const passwordInput = normalizeString(password)
    const passwordIterations = Math.max(
        Number(user?.passwordIterations || 150000),
        1
    )

    if (!passwordHash || !passwordSalt || !passwordInput) return false

    const computed = hashPassword(passwordInput, passwordSalt, passwordIterations)

    try {
        const left = Buffer.from(computed, "hex")
        const right = Buffer.from(passwordHash, "hex")
        return left.length === right.length && timingSafeEqual(left, right)
    } catch {
        return computed === passwordHash
    }
}

function getCurrentUserId(req: AuthenticatedRequest): string {
    return normalizeString(
        req.user?._id ??
            req.user?.id ??
            req.currentUser?.id ??
            req.currentUser?._id ??
            req.auth?.sub ??
            req.auth?.userId ??
            ""
    )
}

function toBase64Url(value: string) {
    return Buffer.from(value, "utf8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "")
}

function fromBase64Url(value: string) {
    const base = String(value ?? "")
        .replace(/-/g, "+")
        .replace(/_/g, "/")
    const padding = base.length % 4 === 0 ? "" : "=".repeat(4 - (base.length % 4))
    return Buffer.from(`${base}${padding}`, "base64").toString("utf8")
}

function getAvatarUploadSecret() {
    return (
        normalizeOptionalString(process.env.SETTINGS_UPLOAD_SECRET) ||
        normalizeOptionalString(process.env.JWT_SECRET) ||
        normalizeOptionalString(process.env.SESSION_SECRET) ||
        normalizeOptionalString(process.env.AWS_SECRET_ACCESS_KEY) ||
        "queuepass-avatar-upload-secret"
    )
}

function signUploadToken(payload: UploadTokenPayload) {
    const encodedPayload = toBase64Url(JSON.stringify(payload))
    const signature = createHmac("sha256", getAvatarUploadSecret())
        .update(encodedPayload)
        .digest("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "")

    return `${encodedPayload}.${signature}`
}

function verifyUploadToken(token: string): UploadTokenPayload | null {
    const cleanToken = normalizeString(token)
    if (!cleanToken || !cleanToken.includes(".")) return null

    const [encodedPayload, signature] = cleanToken.split(".", 2)
    if (!encodedPayload || !signature) return null

    const expectedSignature = createHmac("sha256", getAvatarUploadSecret())
        .update(encodedPayload)
        .digest("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "")

    try {
        const left = Buffer.from(signature)
        const right = Buffer.from(expectedSignature)
        if (left.length !== right.length || !timingSafeEqual(left, right)) {
            return null
        }
    } catch {
        if (signature !== expectedSignature) return null
    }

    try {
        const parsed = JSON.parse(fromBase64Url(encodedPayload)) as UploadTokenPayload
        if (
            !parsed ||
            !normalizeString(parsed.sub) ||
            !normalizeString(parsed.key) ||
            !normalizeString(parsed.contentType) ||
            !Number.isFinite(parsed.exp)
        ) {
            return null
        }

        if (Number(parsed.exp) < Date.now()) return null

        return {
            sub: normalizeString(parsed.sub),
            key: normalizeString(parsed.key),
            contentType: normalizeString(parsed.contentType).toLowerCase(),
            exp: Number(parsed.exp),
        }
    } catch {
        return null
    }
}

function ensureSupportedImageContentType(value: unknown): string | null {
    const contentType = normalizeString(value).toLowerCase()
    if (!contentType.startsWith("image/")) return null
    return fileExtFromContentType(contentType) ? contentType : null
}

function buildAvatarObjectKey(userId: string, contentType: string) {
    const ext = fileExtFromContentType(contentType)
    if (!ext) return null

    return withS3Prefix(
        buildS3ObjectKey(
            "avatars",
            userId,
            `${Date.now()}-${randomBytes(8).toString("hex")}.${ext}`
        )
    )
}

function resolveAvatarUrl(user: any): string | null {
    const avatarKey = normalizeOptionalString(user?.avatarKey)
    const avatarUrl = normalizeOptionalString(user?.avatarUrl)

    if (avatarUrl) {
        return resolveStoredFileUrl(avatarUrl) ?? avatarUrl
    }

    if (avatarKey) {
        return resolveStoredFileUrl(avatarKey) ?? avatarKey
    }

    return null
}

function normalizeIdValue(value: unknown): string | null {
    const clean = normalizeString(value)
    return clean || null
}

function normalizeIdArray(values: unknown): string[] {
    if (!Array.isArray(values)) return []

    const out: string[] = []
    const seen = new Set<string>()

    for (const value of values) {
        const clean = normalizeString(value)
        if (!clean || seen.has(clean)) continue
        seen.add(clean)
        out.push(clean)
    }

    return out
}

function buildCurrentPayload(user: any) {
    const avatarKey = normalizeNullableString(user?.avatarKey)
    const avatarUrl = resolveAvatarUrl(user)
    const assignedDepartment = normalizeIdValue(user?.assignedDepartment)
    const assignedDepartments = normalizeIdArray(user?.assignedDepartments)
    const assignedWindow = normalizeIdValue(user?.assignedWindow)
    const departmentId = normalizeIdValue(user?.departmentId)

    return {
        user: {
            id: normalizeString(user?._id),
            name: normalizeString(user?.name),
            email: normalizeOptionalString(user?.email) ?? null,
            role: normalizeOptionalString(user?.role) ?? null,
            active:
                typeof user?.active === "boolean" ? Boolean(user.active) : true,
            type: normalizeOptionalString(user?.type) ?? null,
            firstName: normalizeOptionalString(user?.firstName) ?? null,
            middleName: normalizeOptionalString(user?.middleName) ?? null,
            lastName: normalizeOptionalString(user?.lastName) ?? null,
            studentId: normalizeOptionalString(user?.studentId) ?? null,
            tcNumber: normalizeOptionalString(user?.tcNumber) ?? null,
            mobileNumber: normalizeOptionalString(user?.mobileNumber) ?? null,
            phone: normalizeOptionalString(user?.phone) ?? null,
            departmentId,
            assignedDepartment,
            assignedDepartments,
            assignedWindow,
            assignedTransactionManager:
                normalizeOptionalString(user?.assignedTransactionManager) ?? null,
            smsUpdates:
                typeof user?.smsUpdates === "boolean"
                    ? Boolean(user.smsUpdates)
                    : true,
            avatarKey,
            avatarUrl,
            createdAt: user?.createdAt ?? null,
            updatedAt: user?.updatedAt ?? null,
        },
        profile: {
            name: normalizeString(user?.name),
            email: normalizeOptionalString(user?.email) ?? null,
            firstName: normalizeOptionalString(user?.firstName) ?? null,
            middleName: normalizeOptionalString(user?.middleName) ?? null,
            lastName: normalizeOptionalString(user?.lastName) ?? null,
            mobileNumber: normalizeOptionalString(user?.mobileNumber) ?? null,
            phone: normalizeOptionalString(user?.phone) ?? null,
            smsUpdates:
                typeof user?.smsUpdates === "boolean"
                    ? Boolean(user.smsUpdates)
                    : true,
        },
        avatarKey,
        avatarUrl,
    }
}

async function getCurrentUserOrThrow(req: AuthenticatedRequest) {
    const userId = getCurrentUserId(req)
    if (!userId) {
        const error = new Error("Unauthorized")
        ;(error as any).status = 401
        throw error
    }

    const user = await UserModel.findById(userId)
    if (!user) {
        const error = new Error("User not found")
        ;(error as any).status = 404
        throw error
    }

    return user
}

function getRawBodyBuffer(body: unknown): Buffer {
    if (Buffer.isBuffer(body)) return body
    if (body instanceof Uint8Array) return Buffer.from(body)
    if (typeof body === "string") return Buffer.from(body)
    return Buffer.alloc(0)
}

function parseMultipartAvatar(
    body: Buffer,
    contentTypeHeader: string
): { buffer: Buffer; contentType: string; fileName?: string } | null {
    const boundaryMatch = contentTypeHeader.match(/boundary=(?:"([^"]+)"|([^;]+))/i)
    const boundaryValue = boundaryMatch?.[1] || boundaryMatch?.[2]
    if (!boundaryValue) return null

    const boundary = `--${boundaryValue}`
    const raw = body.toString("latin1")
    const parts = raw.split(boundary)
    const fieldNamePattern =
        /name="(?:avatar|file|image|photo|picture|profile|profileImage)"/i

    for (const part of parts) {
        if (!part || !fieldNamePattern.test(part)) continue

        const headerEnd = part.indexOf("\r\n\r\n")
        if (headerEnd < 0) continue

        const headerText = part.slice(0, headerEnd)
        let fileText = part.slice(headerEnd + 4)

        fileText = fileText.replace(/\r\n--\s*$/, "")
        fileText = fileText.replace(/\r\n$/, "")

        const contentTypeMatch = headerText.match(
            /content-type:\s*([^\r\n;]+)/i
        )
        const fileNameMatch = headerText.match(/filename="([^"]*)"/i)

        const partContentType = ensureSupportedImageContentType(
            contentTypeMatch?.[1]
        )
        if (!partContentType) return null

        return {
            buffer: Buffer.from(fileText, "latin1"),
            contentType: partContentType,
            fileName: normalizeOptionalString(fileNameMatch?.[1]),
        }
    }

    return null
}

function extractAvatarUpload(req: Request) {
    const rawContentTypeHeader = normalizeString(req.headers["content-type"])
    const lowerContentTypeHeader = rawContentTypeHeader.toLowerCase()
    const body = getRawBodyBuffer(req.body)

    if (!body.length) return null

    const directImageContentType = ensureSupportedImageContentType(
        rawContentTypeHeader
    )
    if (directImageContentType) {
        return {
            buffer: body,
            contentType: directImageContentType,
        }
    }

    if (lowerContentTypeHeader.startsWith("multipart/form-data")) {
        return parseMultipartAvatar(body, rawContentTypeHeader)
    }

    return null
}

async function uploadAvatarBufferToS3(
    key: string,
    buffer: Buffer,
    contentType: string
) {
    await getS3Client().send(
        new PutObjectCommand({
            Bucket: getS3BucketName(),
            Key: key,
            Body: buffer,
            ContentType: contentType,
        })
    )
}

function setAvatarFields(user: any, key: string | null, url?: string | null) {
    const normalizedKey = normalizeNullableString(key)
    const normalizedUrl = normalizeNullableString(url)

    user.avatarKey = normalizedKey
    user.avatarUrl = normalizedKey
        ? resolveStoredFileUrl(normalizedKey) ??
          normalizedUrl ??
          normalizedKey
        : normalizedUrl
}

export class SettingController {
    static async getCurrent(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {
        try {
            const user = await getCurrentUserOrThrow(req as AuthenticatedRequest)
            res.status(200).json({ data: buildCurrentPayload(user) })
        } catch (error) {
            if ((error as any)?.status === 401) {
                res.status(401).json({ message: "Unauthorized" })
                return
            }
            if ((error as any)?.status === 404) {
                res.status(404).json({ message: "User not found" })
                return
            }
            ControllerUtils.forwardError(error, next)
        }
    }

    static async updateCurrent(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {
        try {
            const user = await getCurrentUserOrThrow(req as AuthenticatedRequest)
            const body = isRecord(req.body) ? req.body : {}

            const hasName = hasOwn(body, "name")
            const hasEmail = hasOwn(body, "email")
            const hasCurrentPassword = hasOwn(body, "currentPassword")
            const hasNewPassword = hasOwn(body, "newPassword")
            const hasConfirmPassword = hasOwn(body, "confirmPassword")
            const hasFirstName = hasOwn(body, "firstName")
            const hasMiddleName = hasOwn(body, "middleName")
            const hasLastName = hasOwn(body, "lastName")
            const hasMobileNumber = hasOwn(body, "mobileNumber")
            const hasPhone = hasOwn(body, "phone")
            const hasSmsUpdates = hasOwn(body, "smsUpdates")
            const hasAvatarKey = hasOwn(body, "avatarKey")
            const hasAvatarUrl = hasOwn(body, "avatarUrl")

            const currentPassword = normalizeString(body.currentPassword)
            const nextName = normalizeString(body.name)
            const nextEmail = normalizeEmail(body.email)
            const nextPassword = normalizeString(body.newPassword)
            const confirmPassword = normalizeString(body.confirmPassword)

            if (hasName) {
                if (!nextName) {
                    ControllerUtils.sendBadRequest(res, "Name is required")
                    return
                }
                user.name = nextName
            }

            if (hasFirstName) {
                user.firstName = normalizeOptionalString(body.firstName)
            }

            if (hasMiddleName) {
                user.middleName = normalizeOptionalString(body.middleName)
            }

            if (hasLastName) {
                user.lastName = normalizeOptionalString(body.lastName)
            }

            if (hasMobileNumber) {
                user.mobileNumber = normalizeOptionalString(body.mobileNumber)
            }

            if (hasPhone) {
                user.phone = normalizeOptionalString(body.phone)
            }

            if (hasSmsUpdates) {
                user.smsUpdates = normalizeBoolean(
                    body.smsUpdates,
                    Boolean(user.smsUpdates)
                )
            }

            if (!hasName && (hasFirstName || hasMiddleName || hasLastName)) {
                const composed = [
                    normalizeOptionalString(user.firstName),
                    normalizeOptionalString(user.middleName),
                    normalizeOptionalString(user.lastName),
                ]
                    .filter(Boolean)
                    .join(" ")
                    .trim()

                if (composed) {
                    user.name = composed
                }
            }

            const isChangingEmail =
                hasEmail &&
                nextEmail &&
                nextEmail !== normalizeEmail(user.email)

            if (hasEmail) {
                if (!nextEmail) {
                    ControllerUtils.sendBadRequest(res, "Email is required")
                    return
                }

                if (isChangingEmail) {
                    if (!currentPassword) {
                        ControllerUtils.sendBadRequest(
                            res,
                            "Current password is required to change email"
                        )
                        return
                    }

                    if (!verifyPassword(user, currentPassword)) {
                        ControllerUtils.sendBadRequest(
                            res,
                            "Current password is incorrect"
                        )
                        return
                    }

                    const emailOwner = await UserModel.findOne({
                        _id: { $ne: user._id },
                        email: nextEmail,
                    })
                        .select("_id")
                        .lean()

                    if (emailOwner) {
                        ControllerUtils.sendBadRequest(
                            res,
                            "Email is already in use"
                        )
                        return
                    }
                }

                user.email = nextEmail
            }

            if (hasNewPassword || hasConfirmPassword) {
                if (!currentPassword) {
                    ControllerUtils.sendBadRequest(
                        res,
                        "Current password is required"
                    )
                    return
                }

                if (!verifyPassword(user, currentPassword)) {
                    ControllerUtils.sendBadRequest(
                        res,
                        "Current password is incorrect"
                    )
                    return
                }

                if (!nextPassword || nextPassword.length < 8) {
                    ControllerUtils.sendBadRequest(
                        res,
                        "New password must be at least 8 characters"
                    )
                    return
                }

                if (hasConfirmPassword && confirmPassword !== nextPassword) {
                    ControllerUtils.sendBadRequest(
                        res,
                        "Confirm password does not match"
                    )
                    return
                }

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
            } else if (hasCurrentPassword && !hasEmail) {
                // currentPassword alone is allowed; no-op unless used for email/password update
            }

            if (hasAvatarKey || hasAvatarUrl) {
                const avatarKeyWasCleared =
                    hasAvatarKey &&
                    (body.avatarKey === null || !normalizeString(body.avatarKey))
                const avatarUrlWasCleared =
                    hasAvatarUrl &&
                    (body.avatarUrl === null || !normalizeString(body.avatarUrl))

                if (avatarKeyWasCleared || avatarUrlWasCleared) {
                    setAvatarFields(user, null, null)
                } else {
                    const nextAvatarKey = normalizeOptionalString(body.avatarKey)
                    const nextAvatarUrl = normalizeOptionalString(body.avatarUrl)

                    if (nextAvatarKey) {
                        setAvatarFields(
                            user,
                            nextAvatarKey,
                            nextAvatarUrl ??
                                resolveStoredFileUrl(nextAvatarKey) ??
                                nextAvatarKey
                        )
                    } else if (nextAvatarUrl) {
                        setAvatarFields(user, user.avatarKey ?? null, nextAvatarUrl)
                    }
                }
            }

            await user.save()

            res.status(200).json({
                data: buildCurrentPayload(user),
                message: "Settings updated successfully",
            })
        } catch (error) {
            if ((error as any)?.status === 401) {
                res.status(401).json({ message: "Unauthorized" })
                return
            }
            if ((error as any)?.status === 404) {
                res.status(404).json({ message: "User not found" })
                return
            }
            ControllerUtils.forwardError(error, next)
        }
    }

    static async presignCurrentAvatarUpload(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {
        try {
            const user = await getCurrentUserOrThrow(req as AuthenticatedRequest)
            const body = isRecord(req.body) ? req.body : {}

            const contentType = ensureSupportedImageContentType(body.contentType)
            if (!contentType) {
                ControllerUtils.sendBadRequest(
                    res,
                    "Unsupported avatar image type"
                )
                return
            }

            const key = buildAvatarObjectKey(String(user._id), contentType)
            if (!key) {
                ControllerUtils.sendBadRequest(
                    res,
                    "Unsupported avatar image type"
                )
                return
            }

            const uploadToken = signUploadToken({
                sub: String(user._id),
                key,
                contentType,
                exp: Date.now() + 10 * 60 * 1000,
            })

            const baseUrl = normalizeOptionalString(req.baseUrl) || "/api"
            const uploadUrl = `${baseUrl}/settings/current/avatar?key=${encodeURIComponent(
                key
            )}&token=${encodeURIComponent(uploadToken)}`
            const objectUrl = resolveStoredFileUrl(key) ?? key

            res.status(200).json({
                data: {
                    method: "PUT",
                    uploadUrl,
                    key,
                    objectUrl,
                    url: objectUrl,
                    contentType,
                    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
                },
            })
        } catch (error) {
            if ((error as any)?.status === 401) {
                res.status(401).json({ message: "Unauthorized" })
                return
            }
            if ((error as any)?.status === 404) {
                res.status(404).json({ message: "User not found" })
                return
            }
            ControllerUtils.forwardError(error, next)
        }
    }

    static async putCurrentAvatarUpload(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {
        try {
            const token = normalizeString(req.query.token)
            const key = normalizeString(req.query.key)

            if (!token || !key) {
                ControllerUtils.sendBadRequest(
                    res,
                    "Missing avatar upload token or key"
                )
                return
            }

            const payload = verifyUploadToken(token)
            if (!payload || payload.key !== key) {
                ControllerUtils.sendBadRequest(
                    res,
                    "Invalid or expired avatar upload token"
                )
                return
            }

            const contentType =
                ensureSupportedImageContentType(req.headers["content-type"]) ||
                ensureSupportedImageContentType(payload.contentType)

            if (!contentType) {
                ControllerUtils.sendBadRequest(
                    res,
                    "Unsupported avatar image type"
                )
                return
            }

            const buffer = getRawBodyBuffer(req.body)

            if (!buffer.length) {
                ControllerUtils.sendBadRequest(res, "Avatar file is required")
                return
            }

            if (buffer.length > 5 * 1024 * 1024) {
                ControllerUtils.sendBadRequest(
                    res,
                    "Please use an image up to 5MB"
                )
                return
            }

            await uploadAvatarBufferToS3(key, buffer, contentType)

            const user = await UserModel.findById(payload.sub)
            if (!user) {
                res.status(404).json({ message: "User not found" })
                return
            }

            const objectUrl = resolveStoredFileUrl(key) ?? key
            setAvatarFields(user, key, objectUrl)
            await user.save()

            res.status(200).json({
                ok: true,
                key,
                objectUrl,
                url: objectUrl,
                data: buildCurrentPayload(user),
                message: "Avatar updated successfully",
            })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }

    static async uploadCurrentAvatar(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {
        try {
            const user = await getCurrentUserOrThrow(req as AuthenticatedRequest)
            const upload = extractAvatarUpload(req)

            if (!upload) {
                ControllerUtils.sendBadRequest(
                    res,
                    "Avatar image file is required"
                )
                return
            }

            if (!upload.buffer.length) {
                ControllerUtils.sendBadRequest(
                    res,
                    "Avatar image file is required"
                )
                return
            }

            if (upload.buffer.length > 5 * 1024 * 1024) {
                ControllerUtils.sendBadRequest(
                    res,
                    "Please use an image up to 5MB"
                )
                return
            }

            const key = buildAvatarObjectKey(String(user._id), upload.contentType)
            if (!key) {
                ControllerUtils.sendBadRequest(
                    res,
                    "Unsupported avatar image type"
                )
                return
            }

            await uploadAvatarBufferToS3(key, upload.buffer, upload.contentType)

            const objectUrl = resolveStoredFileUrl(key) ?? key
            setAvatarFields(user, key, objectUrl)
            await user.save()

            res.status(200).json({
                data: buildCurrentPayload(user),
                message: "Avatar updated successfully",
            })
        } catch (error) {
            if ((error as any)?.status === 401) {
                res.status(401).json({ message: "Unauthorized" })
                return
            }
            if ((error as any)?.status === 404) {
                res.status(404).json({ message: "User not found" })
                return
            }
            ControllerUtils.forwardError(error, next)
        }
    }

    static async deleteCurrentAvatar(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {
        try {
            const user = await getCurrentUserOrThrow(req as AuthenticatedRequest)

            setAvatarFields(user, null, null)
            await user.save()

            res.status(200).json({
                data: buildCurrentPayload(user),
                message: "Avatar removed successfully",
            })
        } catch (error) {
            if ((error as any)?.status === 401) {
                res.status(401).json({ message: "Unauthorized" })
                return
            }
            if ((error as any)?.status === 404) {
                res.status(404).json({ message: "User not found" })
                return
            }
            ControllerUtils.forwardError(error, next)
        }
    }
}