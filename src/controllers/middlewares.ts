import type { NextFunction, Request, Response } from "express"

import { verifyToken } from "./security"
import type { UserRole } from "../models/User"

export type AuthUser = {
    id: string
    role: UserRole
    name?: string
    email?: string
    avatarKey?: string
    avatarUrl?: string
    assignedDepartment?: string
    assignedWindow?: string
}

export type ParticipantType = "STUDENT" | "GUEST"

export type ParticipantAuthUser = {
    id: string
    type: ParticipantType
    name?: string
    email?: string

    // Backward-compatible alias
    studentId?: string

    // New participant identity fields
    tcNumber?: string
    mobileNumber?: string
    departmentId?: string
    departmentCode?: string
}

function readBearerToken(req: Request) {
    const auth = req.header("authorization") || req.header("Authorization") || ""
    return auth.startsWith("Bearer ") ? auth.slice(7).trim() : ""
}

function normalizeParticipantType(raw: unknown): ParticipantType | null {
    const t = String(raw ?? "").trim().toUpperCase()

    if (t === "STUDENT") return "STUDENT"
    if (t === "GUEST") return "GUEST"

    // Backward compatibility with existing participant type/role names.
    if (t === "ALUMNI_VISITOR" || t === "ALUMNI-VISITOR" || t === "VISITOR") return "GUEST"

    return null
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
        const token = readBearerToken(req)
        if (!token) return res.status(401).json({ message: "Missing token" })

        const secret = process.env.JWT_SECRET
        if (!secret) return res.status(500).json({ message: "JWT_SECRET missing" })

        const payload = verifyToken(token, secret)

            ; (req as any).user = {
                id: String(payload.sub || ""),
                role: payload.role as UserRole,
                name: payload.name as string | undefined,
                email: payload.email as string | undefined,
                avatarKey: payload.avatarKey as string | undefined,
                avatarUrl: payload.avatarUrl as string | undefined,
                assignedDepartment: payload.assignedDepartment as string | undefined,
                assignedWindow: payload.assignedWindow as string | undefined,
            } satisfies AuthUser

        if (!(req as any).user.id) return res.status(401).json({ message: "Invalid token" })

        next()
    } catch {
        return res.status(401).json({ message: "Invalid/expired token" })
    }
}

export function requireParticipantAuth(req: Request, res: Response, next: NextFunction) {
    try {
        const token = readBearerToken(req)
        if (!token) return res.status(401).json({ message: "Missing participant token" })

        const secret = process.env.JWT_SECRET
        if (!secret) return res.status(500).json({ message: "JWT_SECRET missing" })

        const payload = verifyToken(token, secret) as Record<string, unknown>

        const participantId = String(payload.sub ?? payload.participantId ?? payload.id ?? "").trim()
        const participantType = normalizeParticipantType(
            payload.participantType ?? payload.type ?? payload.role
        )

        if (!participantId || !participantType) {
            return res.status(401).json({ message: "Invalid participant token" })
        }

        const tcNumber =
            typeof payload.tcNumber === "string"
                ? payload.tcNumber
                : typeof payload.studentId === "string"
                    ? payload.studentId
                    : undefined

        const mobileNumber =
            typeof payload.mobileNumber === "string"
                ? payload.mobileNumber
                : typeof payload.phone === "string"
                    ? payload.phone
                    : undefined

            ; (req as any).participant = {
                id: participantId,
                type: participantType,
                name: typeof payload.name === "string" ? payload.name : undefined,
                email: typeof payload.email === "string" ? payload.email : undefined,

                // backward-compatible
                studentId: typeof payload.studentId === "string" ? payload.studentId : tcNumber,

                // new fields
                tcNumber,
                mobileNumber,
                departmentId: typeof payload.departmentId === "string" ? payload.departmentId : undefined,
                departmentCode: typeof payload.departmentCode === "string" ? payload.departmentCode : undefined,
            } satisfies ParticipantAuthUser

        next()
    } catch {
        return res.status(401).json({ message: "Invalid/expired participant token" })
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
