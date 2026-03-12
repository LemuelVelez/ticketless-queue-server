import type {
    ErrorRequestHandler,
    NextFunction,
    Request,
    RequestHandler,
    Response,
} from "express"
import { getClientOrigin, getNodeEnv } from "../config/env"

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
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization")
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")

    if (req.method === "OPTIONS") {
        res.sendStatus(isAllowedOrigin || allowAnyOrigin ? 204 : 403)
        return
    }

    next()
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