import type { NextFunction, Request, Response } from "express"
import { verifyToken } from "./security"
import type { UserRole } from "../models/User"

export type AuthUser = {
    id: string
    role: UserRole
    name?: string
    assignedDepartment?: string
    assignedWindow?: string
}

export function corsMiddleware(req: Request, res: Response, next: NextFunction) {
    const origin = process.env.CLIENT_ORIGIN || "*"

    // If you want to allow multiple origins, expand here.
    res.header("Access-Control-Allow-Origin", origin)
    res.header("Vary", "Origin")
    res.header("Access-Control-Allow-Credentials", "true")
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization")
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")

    if (req.method === "OPTIONS") return res.sendStatus(204)
    next()
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
    try {
        const auth = req.header("authorization") || ""
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : ""

        if (!token) return res.status(401).json({ message: "Missing token" })

        const secret = process.env.JWT_SECRET
        if (!secret) return res.status(500).json({ message: "JWT_SECRET missing" })

        const payload = verifyToken(token, secret)

            ; (req as any).user = {
                id: String(payload.sub || ""),
                role: payload.role as UserRole,
                name: payload.name as string | undefined,
                assignedDepartment: payload.assignedDepartment as string | undefined,
                assignedWindow: payload.assignedWindow as string | undefined,
            } satisfies AuthUser

        if (!(req as any).user.id) return res.status(401).json({ message: "Invalid token" })

        next()
    } catch {
        return res.status(401).json({ message: "Invalid/expired token" })
    }
}

export function requireRole(...roles: UserRole[]) {
    return (req: Request, res: Response, next: NextFunction) => {
        const user = (req as any).user as AuthUser | undefined
        if (!user) return res.status(401).json({ message: "Unauthorized" })
        if (!roles.includes(user.role)) return res.status(403).json({ message: "Forbidden" })
        next()
    }
}

export function notFoundHandler(_req: Request, res: Response) {
    res.status(404).json({ message: "Not found" })
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
    // eslint-disable-next-line no-console
    console.error(err)

    const status = Number(err?.status || 500)
    const message = err?.message || "Server error"
    res.status(status).json({ message })
}
