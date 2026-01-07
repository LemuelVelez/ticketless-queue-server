import type { Request, Response } from "express"
import { Types } from "mongoose"
import { TicketModel } from "../models/Ticket"
import { SettingModel } from "../models/Setting"
import { ServiceWindowModel } from "../models/ServiceWindow"
import { AuditLogModel } from "../models/AuditLog"
import { DepartmentModel } from "../models/Department"

function todayKey() {
    return new Date().toISOString().slice(0, 10)
}

function staffCtx(req: Request) {
    const u = (req as any).user || {}
    return {
        staffId: String(u.id || ""),
        departmentId: String(u.assignedDepartment || ""),
        windowId: String(u.assignedWindow || ""),
        actor: u?.id,
        actorRole: u?.role,
    }
}

function parseLimit(req: Request, fallback = 25) {
    const raw = req.query.limit
    const n = typeof raw === "string" ? Number(raw) : Array.isArray(raw) ? Number(raw[0]) : NaN
    if (!Number.isFinite(n)) return fallback
    return Math.max(1, Math.min(100, Math.floor(n)))
}

function parseBool(v: unknown): boolean {
    if (typeof v === "boolean") return v
    if (typeof v !== "string") return false
    const s = v.trim().toLowerCase()
    return s === "1" || s === "true" || s === "yes" || s === "y" || s === "on"
}

function parseYmd(v: unknown, fallback: string) {
    const raw = typeof v === "string" ? v : Array.isArray(v) ? String(v[0] ?? "") : ""
    const s = raw.trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
    return fallback
}

function asObjectIdOrString(id: string) {
    try {
        return new Types.ObjectId(id)
    } catch {
        return id
    }
}

export const staffController = {
    myAssignment: async (req: Request, res: Response) => {
        const { departmentId, windowId } = staffCtx(req)
        const window = windowId ? await ServiceWindowModel.findById(windowId) : null
        return res.json({ departmentId: departmentId || null, window })
    },

    /**
     * GET /staff/queue/waiting?limit=25
     */
    listWaiting: async (req: Request, res: Response) => {
        const { departmentId } = staffCtx(req)
        if (!departmentId) return res.status(400).json({ message: "Staff not assigned" })

        const limit = parseLimit(req, 25)
        const dateKey = todayKey()

        const tickets = await TicketModel.find({
            department: departmentId,
            dateKey,
            status: "WAITING",
        })
            .sort({ waitingSince: 1 })
            .limit(limit)
            .exec()

        return res.json({ tickets })
    },

    /**
     * GET /staff/queue/hold?limit=25
     */
    listHold: async (req: Request, res: Response) => {
        const { departmentId } = staffCtx(req)
        if (!departmentId) return res.status(400).json({ message: "Staff not assigned" })

        const limit = parseLimit(req, 25)
        const dateKey = todayKey()

        const tickets = await TicketModel.find({
            department: departmentId,
            dateKey,
            status: "HOLD",
        })
            .sort({ updatedAt: -1 })
            .limit(limit)
            .exec()

        return res.json({ tickets })
    },

    /**
     * GET /staff/queue/out?limit=25
     */
    listOut: async (req: Request, res: Response) => {
        const { departmentId } = staffCtx(req)
        if (!departmentId) return res.status(400).json({ message: "Staff not assigned" })

        const limit = parseLimit(req, 25)
        const dateKey = todayKey()

        const tickets = await TicketModel.find({
            department: departmentId,
            dateKey,
            status: "OUT",
        })
            .sort({ outAt: -1, updatedAt: -1 })
            .limit(limit)
            .exec()

        return res.json({ tickets })
    },

    /**
     * GET /staff/queue/history?limit=25&mine=1
     * - mine=1 filters to tickets called to the staff's assigned window
     */
    listHistory: async (req: Request, res: Response) => {
        const { departmentId, windowId } = staffCtx(req)
        if (!departmentId) return res.status(400).json({ message: "Staff not assigned" })

        const mine = parseBool(req.query.mine)
        if (mine && !windowId) return res.status(400).json({ message: "Staff not assigned to a window" })

        const limit = parseLimit(req, 25)
        const dateKey = todayKey()

        const query: any = {
            department: departmentId,
            dateKey,
            status: { $in: ["CALLED", "SERVED", "OUT"] },
        }

        if (mine) query.window = windowId

        const tickets = await TicketModel.find(query).sort({ updatedAt: -1 }).limit(limit).exec()
        return res.json({ tickets })
    },

    callNext: async (req: Request, res: Response) => {
        const { departmentId, windowId, actor, actorRole } = staffCtx(req)
        if (!departmentId || !windowId) return res.status(400).json({ message: "Staff not assigned" })

        const win = await ServiceWindowModel.findById(windowId)
        if (!win || !win.enabled) return res.status(400).json({ message: "Assigned window not found/disabled" })

        const dateKey = todayKey()

        const next = await TicketModel.findOne({ department: departmentId, dateKey, status: "WAITING" })
            .sort({ waitingSince: 1 })
            .exec()

        if (!next) return res.status(404).json({ message: "No waiting tickets" })

        next.status = "CALLED"
        next.calledAt = new Date()
        next.window = win._id as any
        next.windowNumber = win.number
        await next.save()

        await AuditLogModel.create({
            actor,
            actorRole,
            action: "STAFF_CALL_NEXT",
            entityType: "Ticket",
            entityId: next._id as any,
            meta: { windowNumber: win.number },
        })

        return res.json({ ticket: next })
    },

    currentCalledForWindow: async (req: Request, res: Response) => {
        const { departmentId, windowId } = staffCtx(req)
        if (!departmentId || !windowId) return res.status(400).json({ message: "Staff not assigned" })

        const dateKey = todayKey()
        const ticket = await TicketModel.findOne({
            department: departmentId,
            dateKey,
            status: "CALLED",
            window: windowId,
        }).sort({ calledAt: -1 })

        return res.json({ ticket: ticket || null })
    },

    markServed: async (req: Request, res: Response) => {
        const { id } = req.params
        const { departmentId, windowId, actor, actorRole } = staffCtx(req)
        if (!departmentId || !windowId) return res.status(400).json({ message: "Staff not assigned" })

        const ticket = await TicketModel.findById(id)
        if (!ticket) return res.status(404).json({ message: "Ticket not found" })
        if (String(ticket.department) !== departmentId) return res.status(403).json({ message: "Forbidden" })

        ticket.status = "SERVED"
        ticket.servedAt = new Date()
        await ticket.save()

        await AuditLogModel.create({
            actor,
            actorRole,
            action: "STAFF_MARK_SERVED",
            entityType: "Ticket",
            entityId: ticket._id as any,
        })

        return res.json({ ticket })
    },

    holdNoShow: async (req: Request, res: Response) => {
        const { id } = req.params
        const { departmentId, actor, actorRole } = staffCtx(req)
        if (!departmentId) return res.status(400).json({ message: "Staff not assigned" })

        const settings = await SettingModel.findOne({})
        const maxHoldAttempts = settings?.maxHoldAttempts ?? 4

        const ticket = await TicketModel.findById(id)
        if (!ticket) return res.status(404).json({ message: "Ticket not found" })
        if (String(ticket.department) !== departmentId) return res.status(403).json({ message: "Forbidden" })

        ticket.holdAttempts = (ticket.holdAttempts || 0) + 1

        if (ticket.holdAttempts >= maxHoldAttempts) {
            ticket.status = "OUT"
            ticket.outAt = new Date()
        } else {
            ticket.status = "HOLD"
        }

        await ticket.save()

        await AuditLogModel.create({
            actor,
            actorRole,
            action: "STAFF_HOLD_NO_SHOW",
            entityType: "Ticket",
            entityId: ticket._id as any,
            meta: { holdAttempts: ticket.holdAttempts, maxHoldAttempts },
        })

        return res.json({ ticket })
    },

    returnFromHold: async (req: Request, res: Response) => {
        const { id } = req.params
        const { departmentId, actor, actorRole } = staffCtx(req)
        if (!departmentId) return res.status(400).json({ message: "Staff not assigned" })

        const ticket = await TicketModel.findById(id)
        if (!ticket) return res.status(404).json({ message: "Ticket not found" })
        if (String(ticket.department) !== departmentId) return res.status(403).json({ message: "Forbidden" })

        if (ticket.status !== "HOLD") return res.status(400).json({ message: "Ticket is not on HOLD" })

        ticket.status = "WAITING"
        ticket.waitingSince = new Date()
        ticket.window = undefined
        ticket.windowNumber = undefined
        await ticket.save()

        await AuditLogModel.create({
            actor,
            actorRole,
            action: "STAFF_RETURN_FROM_HOLD",
            entityType: "Ticket",
            entityId: ticket._id as any,
        })

        return res.json({ ticket })
    },

    /**
     * GET /staff/reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
     * - Always scoped to staff's assigned department.
     */
    reportsSummary: async (req: Request, res: Response) => {
        const { departmentId } = staffCtx(req)
        if (!departmentId) return res.status(400).json({ message: "Staff not assigned" })

        const fallback = todayKey()
        const from = parseYmd(req.query.from, fallback)
        const to = parseYmd(req.query.to, fallback)
        if (from > to) return res.status(400).json({ message: "Invalid date range" })

        const deptMatch = asObjectIdOrString(departmentId)

        const match: any = {
            department: deptMatch,
            dateKey: { $gte: from, $lte: to },
        }

        const [agg] = await TicketModel.aggregate([
            { $match: match },
            {
                $group: {
                    _id: null,
                    total: { $sum: 1 },
                    waiting: { $sum: { $cond: [{ $eq: ["$status", "WAITING"] }, 1, 0] } },
                    called: { $sum: { $cond: [{ $eq: ["$status", "CALLED"] }, 1, 0] } },
                    hold: { $sum: { $cond: [{ $eq: ["$status", "HOLD"] }, 1, 0] } },
                    out: { $sum: { $cond: [{ $eq: ["$status", "OUT"] }, 1, 0] } },
                    served: { $sum: { $cond: [{ $eq: ["$status", "SERVED"] }, 1, 0] } },
                    avgWaitMs: {
                        $avg: {
                            $cond: [
                                { $and: [{ $ne: ["$calledAt", null] }, { $ne: ["$waitingSince", null] }] },
                                { $subtract: ["$calledAt", "$waitingSince"] },
                                null,
                            ],
                        },
                    },
                    avgServiceMs: {
                        $avg: {
                            $cond: [
                                { $and: [{ $ne: ["$servedAt", null] }, { $ne: ["$calledAt", null] }] },
                                { $subtract: ["$servedAt", "$calledAt"] },
                                null,
                            ],
                        },
                    },
                },
            },
        ]).exec()

        const totals = {
            total: Number(agg?.total ?? 0),
            byStatus: {
                WAITING: Number(agg?.waiting ?? 0),
                CALLED: Number(agg?.called ?? 0),
                HOLD: Number(agg?.hold ?? 0),
                OUT: Number(agg?.out ?? 0),
                SERVED: Number(agg?.served ?? 0),
            },
            avgWaitMs: typeof agg?.avgWaitMs === "number" ? agg.avgWaitMs : null,
            avgServiceMs: typeof agg?.avgServiceMs === "number" ? agg.avgServiceMs : null,
        }

        const dept = await DepartmentModel.findById(departmentId).select("_id name code").lean().exec()

        const deptRow = {
            departmentId: String(departmentId),
            name: dept?.name,
            code: (dept as any)?.code,
            total: totals.total,
            waiting: totals.byStatus.WAITING ?? 0,
            called: totals.byStatus.CALLED ?? 0,
            hold: totals.byStatus.HOLD ?? 0,
            out: totals.byStatus.OUT ?? 0,
            served: totals.byStatus.SERVED ?? 0,
            avgWaitMs: totals.avgWaitMs,
            avgServiceMs: totals.avgServiceMs,
        }

        return res.json({
            range: { from, to },
            totals,
            departments: [deptRow],
        })
    },

    /**
     * GET /staff/reports/timeseries?from=YYYY-MM-DD&to=YYYY-MM-DD
     * - Always scoped to staff's assigned department.
     */
    reportsTimeseries: async (req: Request, res: Response) => {
        const { departmentId } = staffCtx(req)
        if (!departmentId) return res.status(400).json({ message: "Staff not assigned" })

        const fallback = todayKey()
        const from = parseYmd(req.query.from, fallback)
        const to = parseYmd(req.query.to, fallback)
        if (from > to) return res.status(400).json({ message: "Invalid date range" })

        const deptMatch = asObjectIdOrString(departmentId)

        const match: any = {
            department: deptMatch,
            dateKey: { $gte: from, $lte: to },
        }

        const rows = await TicketModel.aggregate([
            { $match: match },
            {
                $group: {
                    _id: { dateKey: "$dateKey", status: "$status" },
                    count: { $sum: 1 },
                },
            },
            { $sort: { "_id.dateKey": 1 } },
        ]).exec()

        const byDate = new Map<string, any>()

        for (const r of rows) {
            const dateKey = String(r?._id?.dateKey ?? "")
            const status = String(r?._id?.status ?? "").toUpperCase()
            const count = Number(r?.count ?? 0)

            if (!dateKey) continue

            if (!byDate.has(dateKey)) {
                byDate.set(dateKey, {
                    dateKey,
                    total: 0,
                    waiting: 0,
                    called: 0,
                    hold: 0,
                    out: 0,
                    served: 0,
                })
            }

            const obj = byDate.get(dateKey)
            obj.total += count

            if (status === "WAITING") obj.waiting += count
            else if (status === "CALLED") obj.called += count
            else if (status === "HOLD") obj.hold += count
            else if (status === "OUT") obj.out += count
            else if (status === "SERVED") obj.served += count
        }

        const series = Array.from(byDate.values()).sort((a, b) => String(a.dateKey).localeCompare(String(b.dateKey)))

        return res.json({
            range: { from, to },
            series,
        })
    },
}
