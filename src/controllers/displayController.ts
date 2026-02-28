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

/**
 * ✅ Prefer participant full name according to queue.service.ts behavior:
 * - ticket.participantLabel (persisted)
 * - response fields like participantFullName / participantLabel
 * - name parts (first/middle/last) if present
 * - participantDisplay (Full Name • StudentId • Mobile) -> take first segment
 */
function pickParticipantFullName(anyObj?: any): string | undefined {
    if (!anyObj) return undefined

    const directCandidates = [
        anyObj.participantFullName,
        anyObj.participantLabel,
        anyObj.fullName,
        anyObj.displayName,
        anyObj.name,
    ]
        .map((x) => String(x ?? "").trim())
        .filter(Boolean)

    if (directCandidates.length) return directCandidates[0]

    const composed = [anyObj.firstName, anyObj.middleName, anyObj.lastName]
        .map((x) => String(x ?? "").trim())
        .filter(Boolean)
        .join(" ")
        .trim()
    if (composed) return composed

    const display = String(anyObj.participantDisplay ?? "").trim()
    if (display) return display.split("•")[0]?.trim() || display

    return undefined
}

function ticketIdOf(anyTicket?: any): string | undefined {
    const raw = anyTicket?.ticketId ?? anyTicket?.id ?? anyTicket?._id
    if (!raw) return undefined
    if (typeof raw === "string") return raw.trim() || undefined
    if (typeof raw?.toString === "function") {
        const s = String(raw.toString()).trim()
        return s || undefined
    }
    return undefined
}

async function backfillParticipantNamesFromTicketLabel(items: any[]) {
    const ids = Array.from(
        new Set(
            (items || [])
                .map((t) => ticketIdOf(t))
                .map((x) => String(x || "").trim())
                .filter((x) => Types.ObjectId.isValid(x))
        )
    )

    if (!ids.length) return

    const rows = await TicketModel.find({ _id: { $in: ids } }).select({ _id: 1, participantLabel: 1 }).lean().exec()
    const byId = new Map<string, string>()
    for (const r of rows || []) {
        const id = String((r as any)?._id || "").trim()
        const label = String((r as any)?.participantLabel || "").trim()
        if (id && label) byId.set(id, label)
    }

    for (const t of items || []) {
        const id = ticketIdOf(t)
        if (!id) continue

        const label = byId.get(String(id).trim())
        if (!label) continue

        // ✅ Keep compatibility: add participantFullName and also set participant.name if missing
        if (!String((t as any)?.participantFullName || "").trim()) (t as any).participantFullName = label
        if (!String((t as any)?.participantLabel || "").trim()) (t as any).participantLabel = label

        const p = (t as any)?.participant
        if (p && typeof p === "object") {
            if (!String(p?.name || "").trim()) p.name = label
            if (!String(p?.fullName || "").trim()) p.fullName = label
        } else if (!(t as any)?.participant) {
            ;(t as any).participant = { name: label }
        }
    }
}

async function enrichPublicDisplayState(state: Awaited<ReturnType<typeof getPublicDisplayState>>) {
    const items: any[] = []
    for (const w of state?.windows || []) {
        if ((w as any)?.nowServing) items.push((w as any).nowServing)
    }
    for (const t of state?.upNext || []) items.push(t)

    // ✅ Prefer ticket.participantLabel (persisted by queue.service.ts)
    await backfillParticipantNamesFromTicketLabel(items)

    // ✅ Also compute participantFullName using best-effort extraction
    for (const t of items || []) {
        const inferred =
            pickParticipantFullName(t) ||
            pickParticipantFullName((t as any)?.participant) ||
            pickParticipantFullName((t as any)?.account) ||
            undefined

        if (inferred) {
            if (!String((t as any)?.participantFullName || "").trim()) (t as any).participantFullName = inferred
            if ((t as any)?.participant && typeof (t as any).participant === "object") {
                if (!String((t as any).participant?.name || "").trim()) (t as any).participant.name = inferred
            }
        }
    }

    return state
}

function buildPublicDisplayText(state: Awaited<ReturnType<typeof getPublicDisplayState>>) {
    const lines: string[] = []
    lines.push(`Manager: ${state.manager} | Date: ${state.dateKey}`)

    for (const w of state.windows) {
        const serving = (w as any).nowServing
        const depName = serving?.department?.name ? ` • ${serving.department.name}` : ""

        const participantFullName =
            pickParticipantFullName(serving) ||
            pickParticipantFullName(serving?.participant) ||
            pickParticipantFullName(serving?.account) ||
            undefined

        const person = participantFullName ? ` • ${participantFullName}` : ""
        const label = serving ? `#${serving.queueNumber}${depName}${person}` : "—"
        lines.push(`Window ${w.number}: ${label}`)
    }

    const up = state.upNext.map((t: any) => `#${t.queueNumber}`).join(", ") || "—"
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
            await enrichPublicDisplayState(state)

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
            // (No heavy enrichment needed here; announcements should already contain voiceText.)
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
                return res
                    .status(400)
                    .json({ error: { status: 400, code: "INVALID_ID", message: "Invalid departmentId." } })
            }

            const dept = await DepartmentModel.findById(departmentId).select("_id name code enabled").lean().exec()
            if (!dept || !(dept as any).enabled) {
                return res.status(404).json({
                    error: { status: 404, code: "DEPARTMENT_NOT_FOUND", message: "Department not found or disabled." },
                })
            }

            const dateKey = resolveDateKey(req.query.dateKey)

            // Centralized state scoped to department
            const state = await getStaffQueueState(undefined, { departmentId: String(departmentId), dateKey })

            const nowServing = state.called.length ? (state.called[0] as any) : null

            // ✅ Ensure participant full name is present (queue.service.ts persists ticket.participantLabel)
            if (nowServing) {
                const inferred =
                    pickParticipantFullName(nowServing) ||
                    pickParticipantFullName(nowServing?.participant) ||
                    pickParticipantFullName(nowServing?.account) ||
                    undefined

                if (inferred) {
                    if (!String(nowServing.participantFullName || "").trim()) nowServing.participantFullName = inferred
                    if (nowServing.participant && typeof nowServing.participant === "object") {
                        if (!String(nowServing.participant?.name || "").trim()) nowServing.participant.name = inferred
                    }
                }
            }

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
            if (!manager)
                return res
                    .status(400)
                    .json({ error: { status: 400, code: "MISSING_MANAGER", message: "manager is required." } })

            const sinceIso = String((req.query.sinceIso ?? req.query.since ?? "") as string).trim() || undefined
            const snapshot = await getPublicDisplayState(manager, sinceIso)
            await enrichPublicDisplayState(snapshot)

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
            if (!manager)
                return res
                    .status(400)
                    .json({ error: { status: 400, code: "MISSING_MANAGER", message: "manager is required." } })

            const sinceIso = String((req.query.sinceIso ?? req.query.since ?? "") as string).trim() || undefined
            const state = await getPublicDisplayState(manager, sinceIso)
            await enrichPublicDisplayState(state)

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
     *   otherwise builds a fallback message using ticket/department/window + participant full name (ticket.participantLabel).
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

            if (!ticketId)
                return res
                    .status(400)
                    .json({ error: { status: 400, code: "MISSING_TICKET_ID", message: "ticketId is required." } })
            if (!Types.ObjectId.isValid(ticketId)) {
                return res.status(400).json({ error: { status: 400, code: "INVALID_ID", message: "Invalid ticketId." } })
            }

            // Prefer stored voiceText from audit logs (matches queueManagement callNextQueue behavior)
            const log = await AuditLogModel.findOne({
                action: "TICKET_CALLED",
                $or: [
                    { "meta.ticketId": ticketId },
                    { entityId: new Types.ObjectId(ticketId) },
                    { "meta.entityId": ticketId },
                ],
            })
                .sort({ createdAt: -1 })
                .lean()
                .exec()

            const voiceText = String((log as any)?.meta?.voiceText ?? "").trim()
            if (voiceText) return res.json({ ticketId, message: voiceText })

            // ✅ Fallback: build from ticket + participantLabel (persisted by queue.service.ts)
            const t = await TicketModel.findById(ticketId)
                .select({ queueNumber: 1, windowNumber: 1, studentId: 1, participantLabel: 1, department: 1, window: 1 })
                .populate("department", "name")
                .populate("window", "name number")
                .lean()
                .exec()
            if (!t) {
                return res.status(404).json({ error: { status: 404, code: "TICKET_NOT_FOUND", message: "Ticket not found." } })
            }

            const depName = String((t as any)?.department?.name ?? "").trim()
            const qn = Number((t as any)?.queueNumber ?? 0)
            const wn = Number((t as any)?.windowNumber ?? (t as any)?.window?.number ?? 0)

            let participantName = String((t as any)?.participantLabel ?? "").trim() || undefined

            // Extra fallback for old tickets without participantLabel: attempt to resolve via UserModel (students only)
            if (!participantName) {
                const sid = String((t as any)?.studentId ?? "").trim()
                if (sid) {
                    const u = await UserModel.findOne({ $or: [{ studentId: sid }, { tcNumber: sid }] })
                        .select("name firstName middleName lastName")
                        .lean()
                        .exec()
                    participantName = pickUserDisplayName(u)
                }
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