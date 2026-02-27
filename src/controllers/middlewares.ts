import type { NextFunction, Request, Response } from "express"

import { verifyToken } from "./security"
import type { UserRole } from "../models/User"
import { verifyParticipantSession } from "../services/participantAuth.service"

export type AuthUser = {
    id: string
    role: UserRole
    name?: string
    email?: string
    avatarKey?: string
    avatarUrl?: string

    // Optional assignment context from JWT (fallback when DB lookup is unavailable)
    assignedDepartment?: string
    assignedDepartments?: string[]
    assignedWindow?: string
    assignedTransactionManager?: string
}

export type ParticipantType = "STUDENT" | "ALUMNI_VISITOR" | "GUEST"

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

function readSessionToken(req: Request) {
    // ✅ Compatibility with proxies/CDNs that strip Authorization
    // Frontend mirrors Bearer token into X-Session-Token.
    return (
        req.header("x-session-token") ||
        req.header("X-Session-Token") ||
        req.header("x-sessiontoken") ||
        req.header("X-SessionToken") ||
        ""
    ).trim()
}

function readBearerToken(req: Request) {
    const auth = (req.header("authorization") || req.header("Authorization") || "").trim()
    if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim()

    // ✅ Fallback: accept X-Session-Token as the token
    return readSessionToken(req)
}

function readOptionalString(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined
    const s = value.trim()
    return s || undefined
}

function readStringArray(value: unknown): string[] {
    const source = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : []

    const seen = new Set<string>()
    const out: string[] = []

    for (const v of source) {
        const s = String(v ?? "").trim()
        if (!s || seen.has(s)) continue
        seen.add(s)
        out.push(s)
    }

    return out
}

function normalizeParticipantType(raw: unknown): ParticipantType | null {
    const t = String(raw ?? "").trim().toUpperCase()

    if (t === "STUDENT") return "STUDENT"
    if (t === "ALUMNI_VISITOR" || t === "ALUMNI-VISITOR") return "ALUMNI_VISITOR"
    if (t === "GUEST" || t === "VISITOR") return "GUEST"

    return null
}

function fromJwtPayload(payload: Record<string, unknown>): ParticipantAuthUser | null {
    const participantId = String(payload.sub ?? payload.participantId ?? payload.id ?? "").trim()
    const participantType = normalizeParticipantType(payload.participantType ?? payload.type ?? payload.role)

    if (!participantId || !participantType) return null

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

    return {
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
    }
}

function parseAllowedOrigins(raw?: string): string[] {
    const s = String(raw ?? "").trim()
    if (!s) return []
    return s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
}

export function corsMiddleware(req: Request, res: Response, next: NextFunction) {
    const reqOrigin = String(req.headers.origin ?? "").trim()
    const allowed = parseAllowedOrigins(process.env.CLIENT_ORIGIN)

    let allowOrigin = ""

    // ✅ If CLIENT_ORIGIN is "*" or not set, echo the requesting origin (required for credentialed requests).
    // This fixes “Join Queue not working” in cross-origin deployments where fetch uses credentials/include.
    if (!allowed.length || allowed.includes("*")) {
        allowOrigin = reqOrigin || "*"
    } else if (reqOrigin && allowed.includes(reqOrigin)) {
        allowOrigin = reqOrigin
    } else {
        // fallback: pick the first configured origin (better than "*")
        allowOrigin = allowed[0] || reqOrigin || "*"
    }

    res.header("Access-Control-Allow-Origin", allowOrigin)
    res.header("Vary", "Origin")

    // Only send credentials=true when origin is explicit (not "*")
    if (allowOrigin && allowOrigin !== "*") {
        res.header("Access-Control-Allow-Credentials", "true")
    }

    res.header(
        "Access-Control-Allow-Headers",
        "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Session-Token, X-SessionToken, X-Error-Message"
    )
    res.header("Access-Control-Expose-Headers", "X-Error-Message")
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")

    if (req.method === "OPTIONS") return res.sendStatus(204)
    next()
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
    try {
        const token = readBearerToken(req)
        if (!token) {
            res.setHeader("X-Error-Message", "Missing token")
            return res.status(401).json({ message: "Missing token" })
        }

        const secret = process.env.JWT_SECRET
        if (!secret) {
            res.setHeader("X-Error-Message", "JWT_SECRET missing")
            return res.status(500).json({ message: "JWT_SECRET missing" })
        }

        const payload = verifyToken(token, secret) as Record<string, unknown>

        const id = String(payload.sub ?? payload.id ?? payload.userId ?? "").trim()
        const role = String(payload.role ?? payload.userRole ?? "").trim().toUpperCase() as UserRole

        const assignedDepartment =
            readOptionalString(payload.assignedDepartment) ||
            readOptionalString(payload.assignedDepartmentId) ||
            readOptionalString(payload.departmentId) ||
            readOptionalString(payload.department)

        const assignedDepartmentsFromToken = readStringArray(
            payload.assignedDepartments ??
                payload.assignedDepartmentIds ??
                payload.departmentIds ??
                payload.departments
        )

        const assignedDepartments = assignedDepartment
            ? Array.from(new Set([assignedDepartment, ...assignedDepartmentsFromToken]))
            : assignedDepartmentsFromToken

        const assignedWindow =
            readOptionalString(payload.assignedWindow) ||
            readOptionalString(payload.assignedWindowId) ||
            readOptionalString(payload.windowId) ||
            readOptionalString(payload.window)

        const assignedTransactionManager =
            readOptionalString(payload.assignedTransactionManager) ||
            readOptionalString(payload.transactionManager) ||
            readOptionalString(payload.assignedManager) ||
            readOptionalString(payload.manager)

        ;(req as any).user = {
            id,
            role,
            name: payload.name as string | undefined,
            email: payload.email as string | undefined,
            avatarKey: payload.avatarKey as string | undefined,
            avatarUrl: payload.avatarUrl as string | undefined,

            assignedDepartment,
            assignedDepartments,
            assignedWindow,
            assignedTransactionManager,
        } satisfies AuthUser

        if (!(req as any).user.id) {
            res.setHeader("X-Error-Message", "Invalid token")
            return res.status(401).json({ message: "Invalid token" })
        }

        next()
    } catch {
        res.setHeader("X-Error-Message", "Invalid/expired token")
        return res.status(401).json({ message: "Invalid/expired token" })
    }
}

export async function requireParticipantAuth(req: Request, res: Response, next: NextFunction) {
    try {
        const token = readBearerToken(req)
        if (!token) {
            res.setHeader("X-Error-Message", "Missing participant token")
            return res.status(401).json({ message: "Missing participant token" })
        }

        let participant: ParticipantAuthUser | null = null

        // 1) Try JWT participant token (legacy/alternate flow)
        const secret = process.env.JWT_SECRET
        if (secret) {
            try {
                const payload = verifyToken(token, secret) as Record<string, unknown>
                participant = fromJwtPayload(payload)
            } catch {
                // continue to session-token check
            }
        }

        // 2) Try participant session token (current flow)
        if (!participant) {
            const state = await verifyParticipantSession(token)
            if (state) {
                const p = state.participant
                participant = {
                    id: p._id.toString(),
                    type: p.type === "ALUMNI_VISITOR" ? "ALUMNI_VISITOR" : "STUDENT",
                    name: [p.firstName, p.middleName, p.lastName].filter(Boolean).join(" ").trim() || undefined,
                    studentId: p.tcNumber,
                    tcNumber: p.tcNumber,
                    mobileNumber: p.mobileNumber,
                    departmentId: p.department ? String(p.department) : undefined,
                }
            }
        }

        if (!participant) {
            res.setHeader("X-Error-Message", "Invalid/expired participant token")
            return res.status(401).json({ message: "Invalid/expired participant token" })
        }

        ;(req as any).participant = participant satisfies ParticipantAuthUser
        next()
    } catch {
        res.setHeader("X-Error-Message", "Invalid/expired participant token")
        return res.status(401).json({ message: "Invalid/expired participant token" })
    }
}

export function requireRole(...roles: UserRole[]) {
    return (req: Request, res: Response, next: NextFunction) => {
        const user = (req as any).user as AuthUser | undefined
        if (!user) {
            res.setHeader("X-Error-Message", "Unauthorized")
            return res.status(401).json({ message: "Unauthorized" })
        }
        if (!roles.includes(user.role)) {
            res.setHeader("X-Error-Message", "Forbidden")
            return res.status(403).json({ message: "Forbidden" })
        }
        next()
    }
}

export function notFoundHandler(_req: Request, res: Response) {
    res.setHeader("X-Error-Message", "Not found")
    res.status(404).json({ message: "Not found" })
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
    // eslint-disable-next-line no-console
    console.error(err)

    const status = Number(err?.status || 500)
    const message = err?.message || "Server error"
    res.setHeader("X-Error-Message", String(message))
    res.status(status).json({ message })
}