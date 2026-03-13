import type {
    ErrorRequestHandler,
    NextFunction,
    Request,
    RequestHandler,
    Response,
} from "express"
import type { UserRole } from "../models/Model"
import { getClientOrigin, getNodeEnv } from "../config/env"
import {
    AuthService,
    type AccessTokenPayload,
} from "../services/AuthService"
import type { UserView } from "../services/UserService"

function buildAllowedOrigins() {
    const configured = getClientOrigin()

    if (!configured) return []

    return configured
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => value.replace(/\/$/, ""))
}

const allowedOrigins = buildAllowedOrigins()

export type AuthenticatedRequest = Request & {
    auth?: AccessTokenPayload
    currentUser?: UserView
}

function extractTokenFromHeaderValue(value: unknown): string | null {
    if (Array.isArray(value)) {
        for (const item of value) {
            const token = extractTokenFromHeaderValue(item)
            if (token) return token
        }
        return null
    }

    const raw = String(value ?? "").trim()
    if (!raw) return null

    if (/^Bearer\s+/i.test(raw)) {
        const token = raw.replace(/^Bearer\s+/i, "").trim()
        return token || null
    }

    return raw
}

function getBearerToken(req: Request): string | null {
    const authHeader = extractTokenFromHeaderValue(req.headers.authorization)
    if (authHeader) return authHeader

    const xSessionToken = extractTokenFromHeaderValue(req.headers["x-session-token"])
    if (xSessionToken) return xSessionToken

    const xSessionTokenAlt = extractTokenFromHeaderValue(req.headers["x-sessiontoken"])
    if (xSessionTokenAlt) return xSessionTokenAlt

    return null
}

export const corsMiddleware: RequestHandler = (req, res, next) => {
    const requestOrigin = String(req.headers.origin ?? "").trim().replace(/\/$/, "")

    if (!requestOrigin) {
        next()
        return
    }

    const allowAnyOrigin = allowedOrigins.length === 0
    const isAllowedOrigin = allowAnyOrigin || allowedOrigins.includes(requestOrigin)

    if (isAllowedOrigin) {
        res.header("Access-Control-Allow-Origin", requestOrigin)
        res.header("Vary", "Origin")
    }

    res.header("Access-Control-Allow-Credentials", "true")
    res.header(
        "Access-Control-Allow-Headers",
        [
            "Origin",
            "X-Requested-With",
            "Content-Type",
            "Accept",
            "Authorization",
            "X-Session-Token",
            "X-SessionToken",
        ].join(", ")
    )
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")

    if (req.method === "OPTIONS") {
        res.sendStatus(isAllowedOrigin || allowAnyOrigin ? 204 : 403)
        return
    }

    next()
}

export const requireAuth: RequestHandler = async (req, res, next) => {
    try {
        const token = getBearerToken(req)

        if (!token) {
            res.status(401).json({
                ok: false,
                message: "Authentication required",
            })
            return
        }

        const payload = AuthService.verifyAccessToken(token)
        const currentUser = await AuthService.getCurrentUser(payload.sub)

        if (!currentUser) {
            res.status(401).json({
                ok: false,
                message: "Invalid or expired access token",
            })
            return
        }

        const authReq = req as AuthenticatedRequest
        authReq.auth = payload
        authReq.currentUser = currentUser

        next()
    } catch {
        res.status(401).json({
            ok: false,
            message: "Invalid or expired access token",
        })
    }
}

export function requireRoles(...roles: UserRole[]): RequestHandler {
    return (req, res, next) => {
        const authReq = req as AuthenticatedRequest
        const currentRole = authReq.currentUser?.role as UserRole | undefined

        if (!currentRole) {
            res.status(401).json({
                ok: false,
                message: "Authentication required",
            })
            return
        }

        if (!roles.includes(currentRole)) {
            res.status(403).json({
                ok: false,
                message: "You do not have permission to access this resource",
            })
            return
        }

        next()
    }
}

export const notFoundHandler: RequestHandler = (_req, res) => {
    res.status(404).json({
        message: "Route not found",
    })
}

export const errorHandler: ErrorRequestHandler = (
    error: unknown,
    _req: Request,
    res: Response,
    next: NextFunction
) => {
    if (res.headersSent) {
        next(error)
        return
    }

    const status =
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        typeof (error as { status?: unknown }).status === "number"
            ? Number((error as { status: number }).status)
            : 500

    const message =
        error instanceof Error
            ? error.message
            : "Internal server error"

    const response: Record<string, unknown> = {
        message,
    }

    if (getNodeEnv() !== "production" && error instanceof Error && error.stack) {
        response.stack = error.stack
    }

    res.status(status).json(response)
}