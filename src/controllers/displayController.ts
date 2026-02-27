import type { Request, Response } from "express"
import { Types } from "mongoose"

import { AuditLogModel } from "../models/AuditLog"
import { DepartmentModel } from "../models/Department"
import { TicketModel } from "../models/Ticket"
import { UserModel } from "../models/User"

import {
    getDateKey,
    getPublicDisplayState,
    getStaffQueueState,
    isHttpError,
    listDepartmentsByManager,
    listManagers,
    listWindowsByManager,
    toPublicError,
} from "../services/queueManagement"

function resolveDateKey(value: unknown) {
    const raw = typeof value === "string" ? value.trim() : ""
    return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : getDateKey()
}

function pickUserDisplayName(u?: any): string | undefined {
    if (!u) return undefined
    const n = String(u.name ?? "").trim()
    if (n) return n
    const composed = [u.firstName, u.middleName, u.lastName]
        .map((x) => String(x ?? "").trim())
        .filter(Boolean)
        .join(" ")
    return composed || undefined
}

function buildPublicDisplayText(state: Awaited<ReturnType<typeof getPublicDisplayState>>) {
    const lines: string[] = []
    lines.push(`Manager: ${state.manager} | Date: ${state.dateKey}`)

    for (const w of state.windows) {
        const serving = w.nowServing
        const depName = serving?.department?.name ? ` • ${serving.department.name}` : ""
        const person = serving?.participant?.name ? ` • ${serving.participant.name}` : ""
        const label = serving ? `#${serving.queueNumber}${depName}${person}` : "—"
        lines.push(`Window ${w.number}: ${label}`)
    }

    const up = state.upNext.map((t) => `#${t.queueNumber}`).join(", ") || "—"
    lines.push(`Up next: ${up}`)

    return lines.join("\n")
}

export const displayController = {
    /**
     * PUBLIC DISPLAY: list available managers (for dropdown/tabs).
     */
    managers: async (_req: Request, res: Response) => {
        try {
            const managers = await listManagers()
            return res.json({ managers })
        } catch (err: any) {
            const e = toPublicError(err)
            return res.status(e.status).json({ error: e })
        }
    },

    /**
     * PUBLIC DISPLAY: list departments under a manager (names first).
     */
    departmentsByManager: async (req: Request, res: Response) => {
        try {
            const manager = String(req.params.manager ?? "").trim()
            const departments = await listDepartmentsByManager(manager)
            return res.json({ manager: manager.toUpperCase(), departments })
        } catch (err: any) {
            const e = toPublicError(err)
            return res.status(e.status).json({ error: e })
        }
    },

    /**
     * PUBLIC DISPLAY: list windows under a manager (windows can belong to multiple departments).
     */
    windowsByManager: async (req: Request, res: Response) => {
        try {
            const manager = String(req.params.manager ?? "").trim()
            const windows = await listWindowsByManager(manager)
            return res.json({ manager: manager.toUpperCase(), windows })
        } catch (err: any) {
            const e = toPublicError(err)
            return res.status(e.status).json({ error: e })
        }
    },

    /**
     * PUBLIC DISPLAY: centralized state for the big screen (switch by manager).
     * Poll every 2–3 seconds.
     *
     * Query:
     * - since / sinceIso (optional): ISO cursor for announcements
     */
    managerState: async (req: Request, res: Response) => {
        try {
            const manager = String(req.params.manager ?? "").trim()
            const sinceIso = String((req.query.sinceIso ?? req.query.since ?? "") as string).trim() || undefined

            const state = await getPublicDisplayState(manager, sinceIso)
            return res.json(state)
        } catch (err: any) {
            const e = toPublicError(err)
            return res.status(e.status).json({ error: e })
        }
    },

    /**
     * PUBLIC DISPLAY: announcements only (voiceText included).
     */
    managerAnnouncements: async (req: Request, res: Response) => {
        try {
            const manager = String(req.params.manager ?? "").trim()
            const sinceIso = String((req.query.sinceIso ?? req.query.since ?? "") as string).trim() || undefined

            const state = await getPublicDisplayState(manager, sinceIso)
            return res.json({
                manager: state.manager,
                dateKey: state.dateKey,
                serverTime: state.serverTime,
                announcements: state.announcements,
            })
        } catch (err: any) {
            const e = toPublicError(err)
            return res.status(e.status).json({ error: e })
        }
    },

    /**
     * LEGACY: Department display (kept for compatibility).
     * Uses the centralized queueManagement service for consistent state.
     */
    departmentDisplay: async (req: Request, res: Response) => {
        try {
            const { departmentId } = req.params
            if (!Types.ObjectId.isValid(String(departmentId))) {
                return res.status(400).json({ error: { status: 400, code: "INVALID_ID", message: "Invalid departmentId." } })
            }

            const dept = await DepartmentModel.findById(departmentId).select("_id name code enabled").lean().exec()
            if (!dept || !(dept as any).enabled) {
                return res.status(404).json({ error: { status: 404, code: "DEPARTMENT_NOT_FOUND", message: "Department not found or disabled." } })
            }

            const dateKey = resolveDateKey(req.query.dateKey)

            // Centralized state scoped to department
            const state = await getStaffQueueState(undefined, { departmentId: String(departmentId), dateKey })

            const nowServing = state.called.length ? state.called[0] : null

            return res.json({
                dateKey,
                department: {
                    id: String((dept as any)._id),
                    name: String((dept as any).name),
                    code: (dept as any).code ? String((dept as any).code) : undefined,
                },
                nowServing,
                upNext: state.upNext,
            })
        } catch (err: any) {
            const e = isHttpError(err) ? toPublicError(err) : toPublicError(err)
            return res.status(e.status).json({ error: e })
        }
    },

    /**
     * LEGACY: monitor snapshot -> now returns manager-based public state.
     * Requires ?manager=... to support switching.
     */
    monitorSnapshot: async (req: Request, res: Response) => {
        try {
            const manager = String(req.query.manager ?? "").trim()
            if (!manager) return res.status(400).json({ error: { status: 400, code: "MISSING_MANAGER", message: "manager is required." } })

            const sinceIso = String((req.query.sinceIso ?? req.query.since ?? "") as string).trim() || undefined
            const snapshot = await getPublicDisplayState(manager, sinceIso)
            return res.json({ snapshot })
        } catch (err: any) {
            const e = toPublicError(err)
            return res.status(e.status).json({ error: e })
        }
    },

    /**
     * LEGACY: monitor text -> returns a readable text version of manager state.
     * Requires ?manager=...
     */
    monitorText: async (req: Request, res: Response) => {
        try {
            const manager = String(req.query.manager ?? "").trim()
            if (!manager) return res.status(400).json({ error: { status: 400, code: "MISSING_MANAGER", message: "manager is required." } })

            const sinceIso = String((req.query.sinceIso ?? req.query.since ?? "") as string).trim() || undefined
            const state = await getPublicDisplayState(manager, sinceIso)
            const text = buildPublicDisplayText(state)
            return res.json({ manager: state.manager, dateKey: state.dateKey, text })
        } catch (err: any) {
            const e = toPublicError(err)
            return res.status(e.status).json({ error: e })
        }
    },

    /**
     * LEGACY: Voice announcement endpoint.
     * - If ticketId is provided (path/query), returns the latest stored voiceText (preferred),
     *   otherwise builds a fallback message using ticket/department/window + participant name.
     * - If ticketId is not provided, supports ?manager=...&since=... to return announcement batch.
     */
    voiceAnnouncement: async (req: Request, res: Response) => {
        try {
            const ticketId = String(req.params.ticketId || req.query.ticketId || "").trim()
            const manager = String(req.query.manager ?? "").trim()
            const sinceIso = String((req.query.sinceIso ?? req.query.since ?? "") as string).trim() || undefined

            // Batch mode for public display voice polling
            if (!ticketId && manager) {
                const state = await getPublicDisplayState(manager, sinceIso)
                return res.json({
                    manager: state.manager,
                    dateKey: state.dateKey,
                    serverTime: state.serverTime,
                    announcements: state.announcements,
                    messages: state.announcements.map((a) => a.voiceText),
                })
            }

            if (!ticketId) return res.status(400).json({ error: { status: 400, code: "MISSING_TICKET_ID", message: "ticketId is required." } })
            if (!Types.ObjectId.isValid(ticketId)) {
                return res.status(400).json({ error: { status: 400, code: "INVALID_ID", message: "Invalid ticketId." } })
            }

            // Prefer stored voiceText from audit logs (matches queueManagement callNextQueue behavior)
            const log = await AuditLogModel.findOne({
                action: "TICKET_CALLED",
                $or: [{ "meta.ticketId": ticketId }, { entityId: new Types.ObjectId(ticketId) }, { "meta.entityId": ticketId }],
            })
                .sort({ createdAt: -1 })
                .lean()
                .exec()

            const voiceText = String((log as any)?.meta?.voiceText ?? "").trim()
            if (voiceText) return res.json({ ticketId, message: voiceText })

            // Fallback: build from ticket + participant name
            const t = await TicketModel.findById(ticketId).populate("department", "name").populate("window", "name number").lean().exec()
            if (!t) return res.status(404).json({ error: { status: 404, code: "TICKET_NOT_FOUND", message: "Ticket not found." } })

            const depName = String((t as any)?.department?.name ?? "").trim()
            const qn = Number((t as any)?.queueNumber ?? 0)
            const wn = Number((t as any)?.windowNumber ?? (t as any)?.window?.number ?? 0)

            const sid = String((t as any)?.studentId ?? "").trim()
            let participantName: string | undefined
            if (sid) {
                const u = await UserModel.findOne({ $or: [{ studentId: sid }, { tcNumber: sid }] })
                    .select("name firstName middleName lastName")
                    .lean()
                    .exec()
                participantName = pickUserDisplayName(u)
            }

            const parts = [
                "Now serving",
                depName ? `for ${depName}` : "",
                qn ? `queue number ${qn}.` : "",
                wn ? `Please proceed to window ${wn}.` : "",
                participantName ? `Participant ${participantName}.` : "",
            ]
                .map((s) => String(s).trim())
                .filter(Boolean)

            return res.json({ ticketId, message: parts.join(" ") || "Now serving." })
        } catch (err: any) {
            const e = toPublicError(err)
            return res.status(e.status).json({ error: e })
        }
    },
}