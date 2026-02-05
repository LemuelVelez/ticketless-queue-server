import type { Request, Response } from "express"
import { Types } from "mongoose"

import { AuditLogModel } from "../models/AuditLog"
import { DepartmentModel } from "../models/Department"
import { ServiceWindowModel } from "../models/ServiceWindow"
import { SettingModel } from "../models/Setting"
import { TicketModel } from "../models/Ticket"

import { getDateKeyManila, getDepartmentWindowAssignments } from "../services/queue.service"

function todayKey() {
    return getDateKeyManila()
}

function normalizeKey(v?: string) {
    return (v || "").trim().toUpperCase()
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

async function resolveHandledDepartmentIds(departmentId: string, windowNumber?: number) {
    const fallback = asObjectIdOrString(departmentId)

    if (!windowNumber) return [fallback]

    const assignments = getDepartmentWindowAssignments()
    const groupCodes = assignments[windowNumber]
    if (!groupCodes?.length) return [fallback]

    const enabledDepartments = await DepartmentModel.find({ enabled: true }).select("_id code name")
    const normalizedCodes = new Set(groupCodes.map((c) => normalizeKey(c)))

    const ids = enabledDepartments
        .filter((d) => normalizedCodes.has(normalizeKey(d.code || d.name)))
        .map((d) => d._id)

    if (!ids.length) return [fallback]

    const fallbackId = String(fallback)
    if (!ids.some((id) => String(id) === fallbackId)) {
        ids.push(fallback as Types.ObjectId)
    }

    return ids
}

function inHandledDepartments(ticketDepartment: unknown, handledDepartmentIds: Array<Types.ObjectId | string>) {
    const value = String(ticketDepartment || "")
    if (!value) return false

    const set = new Set(handledDepartmentIds.map((id) => String(id)))
    return set.has(value)
}

async function resolveStaffScope(req: Request) {
    const base = staffCtx(req)

    const window = base.windowId ? await ServiceWindowModel.findById(base.windowId).lean() : null
    const windowNumber = typeof (window as any)?.number === "number" ? Number((window as any).number) : undefined
    const handledDepartmentIds = await resolveHandledDepartmentIds(base.departmentId, windowNumber)

    return {
        ...base,
        window,
        windowNumber,
        handledDepartmentIds,
    }
}

export const staffController = {
    myAssignment: async (req: Request, res: Response) => {
        const scope = await resolveStaffScope(req)

        return res.json({
            departmentId: scope.departmentId || null,
            window: scope.window || null,
            handledDepartmentIds: scope.handledDepartmentIds.map((id) => String(id)),
        })
    },

    /**
     * GET /staff/queue/waiting?limit=25
     */
    listWaiting: async (req: Request, res: Response) => {
        const scope = await resolveStaffScope(req)
        if (!scope.departmentId) return res.status(400).json({ message: "Staff not assigned" })

        const limit = parseLimit(req, 25)
        const dateKey = todayKey()

        const tickets = await TicketModel.find({
            department: { $in: scope.handledDepartmentIds },
            dateKey,
            status: "WAITING",
        })
            .sort({ queueNumber: 1, waitingSince: 1 })
            .limit(limit)
            .exec()

        return res.json({ tickets })
    },

    /**
     * GET /staff/queue/hold?limit=25
     */
    listHold: async (req: Request, res: Response) => {
        const scope = await resolveStaffScope(req)
        if (!scope.departmentId) return res.status(400).json({ message: "Staff not assigned" })

        const limit = parseLimit(req, 25)
        const dateKey = todayKey()

        const tickets = await TicketModel.find({
            department: { $in: scope.handledDepartmentIds },
            dateKey,
            status: "HOLD",
        })
            .sort({ updatedAt: -1, queueNumber: 1 })
            .limit(limit)
            .exec()

        return res.json({ tickets })
    },

    /**
     * GET /staff/queue/out?limit=25
     */
    listOut: async (req: Request, res: Response) => {
        const scope = await resolveStaffScope(req)
        if (!scope.departmentId) return res.status(400).json({ message: "Staff not assigned" })

        const limit = parseLimit(req, 25)
        const dateKey = todayKey()

        const tickets = await TicketModel.find({
            department: { $in: scope.handledDepartmentIds },
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
        const scope = await resolveStaffScope(req)
        if (!scope.departmentId) return res.status(400).json({ message: "Staff not assigned" })

        const mine = parseBool(req.query.mine)
        if (mine && !scope.windowId) return res.status(400).json({ message: "Staff not assigned to a window" })

        const limit = parseLimit(req, 25)
        const dateKey = todayKey()

        const query: any = {
            department: { $in: scope.handledDepartmentIds },
            dateKey,
            status: { $in: ["CALLED", "SERVED", "OUT"] },
        }

        if (mine) {
            const or: any[] = [{ window: scope.windowId }]
            if (typeof scope.windowNumber === "number") {
                or.push({ windowNumber: scope.windowNumber })
            }
            query.$or = or
        }

        const tickets = await TicketModel.find(query).sort({ updatedAt: -1 }).limit(limit).exec()
        return res.json({ tickets })
    },

    callNext: async (req: Request, res: Response) => {
        const scope = await resolveStaffScope(req)
        if (!scope.departmentId || !scope.windowId) return res.status(400).json({ message: "Staff not assigned" })

        const win = await ServiceWindowModel.findById(scope.windowId)
        if (!win || !win.enabled) return res.status(400).json({ message: "Assigned window not found/disabled" })

        const dateKey = todayKey()

        const next = await TicketModel.findOne({
            department: { $in: scope.handledDepartmentIds },
            dateKey,
            status: "WAITING",
        })
            .sort({ queueNumber: 1, waitingSince: 1 })
            .exec()

        if (!next) return res.status(404).json({ message: "No waiting tickets" })

        next.status = "CALLED"
        next.calledAt = new Date()
        next.window = win._id as any
        next.windowNumber = win.number
        await next.save()

        await AuditLogModel.create({
            actor: scope.actor,
            actorRole: scope.actorRole,
            action: "STAFF_CALL_NEXT",
            entityType: "Ticket",
            entityId: next._id as any,
            meta: { windowNumber: win.number },
        })

        return res.json({ ticket: next })
    },

    currentCalledForWindow: async (req: Request, res: Response) => {
        const scope = await resolveStaffScope(req)
        if (!scope.departmentId || !scope.windowId) return res.status(400).json({ message: "Staff not assigned" })

        const dateKey = todayKey()
        const query: any = {
            department: { $in: scope.handledDepartmentIds },
            dateKey,
            status: "CALLED",
            $or: [{ window: scope.windowId }],
        }

        if (typeof scope.windowNumber === "number") {
            query.$or.push({ windowNumber: scope.windowNumber })
        }

        const ticket = await TicketModel.findOne(query).sort({ calledAt: -1, updatedAt: -1 })

        return res.json({ ticket: ticket || null })
    },

    markServed: async (req: Request, res: Response) => {
        const { id } = req.params
        const scope = await resolveStaffScope(req)
        if (!scope.departmentId || !scope.windowId) return res.status(400).json({ message: "Staff not assigned" })

        const ticket = await TicketModel.findById(id)
        if (!ticket) return res.status(404).json({ message: "Ticket not found" })
        if (!inHandledDepartments(ticket.department, scope.handledDepartmentIds)) {
            return res.status(403).json({ message: "Forbidden" })
        }

        ticket.status = "SERVED"
        ticket.servedAt = new Date()
        await ticket.save()

        await AuditLogModel.create({
            actor: scope.actor,
            actorRole: scope.actorRole,
            action: "STAFF_MARK_SERVED",
            entityType: "Ticket",
            entityId: ticket._id as any,
        })

        return res.json({ ticket })
    },

    holdNoShow: async (req: Request, res: Response) => {
        const { id } = req.params
        const scope = await resolveStaffScope(req)
        if (!scope.departmentId) return res.status(400).json({ message: "Staff not assigned" })

        const settings = await SettingModel.findOne({})
        const maxHoldAttempts = settings?.maxHoldAttempts ?? 4

        const ticket = await TicketModel.findById(id)
        if (!ticket) return res.status(404).json({ message: "Ticket not found" })
        if (!inHandledDepartments(ticket.department, scope.handledDepartmentIds)) {
            return res.status(403).json({ message: "Forbidden" })
        }

        ticket.holdAttempts = (ticket.holdAttempts || 0) + 1

        if (ticket.holdAttempts >= maxHoldAttempts) {
            ticket.status = "OUT"
            ticket.outAt = new Date()
        } else {
            ticket.status = "HOLD"
        }

        await ticket.save()

        await AuditLogModel.create({
            actor: scope.actor,
            actorRole: scope.actorRole,
            action: "STAFF_HOLD_NO_SHOW",
            entityType: "Ticket",
            entityId: ticket._id as any,
            meta: { holdAttempts: ticket.holdAttempts, maxHoldAttempts },
        })

        return res.json({ ticket })
    },

    returnFromHold: async (req: Request, res: Response) => {
        const { id } = req.params
        const scope = await resolveStaffScope(req)
        if (!scope.departmentId) return res.status(400).json({ message: "Staff not assigned" })

        const ticket = await TicketModel.findById(id)
        if (!ticket) return res.status(404).json({ message: "Ticket not found" })
        if (!inHandledDepartments(ticket.department, scope.handledDepartmentIds)) {
            return res.status(403).json({ message: "Forbidden" })
        }

        if (ticket.status !== "HOLD") return res.status(400).json({ message: "Ticket is not on HOLD" })

        ticket.status = "WAITING"
        ticket.waitingSince = new Date()
        ticket.window = undefined
        ticket.windowNumber = undefined
        await ticket.save()

        await AuditLogModel.create({
            actor: scope.actor,
            actorRole: scope.actorRole,
            action: "STAFF_RETURN_FROM_HOLD",
            entityType: "Ticket",
            entityId: ticket._id as any,
        })

        return res.json({ ticket })
    },

    /**
     * GET /staff/reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
     * - Scoped to staff's assigned window group (or assigned department if no group mapping).
     */
    reportsSummary: async (req: Request, res: Response) => {
        const scope = await resolveStaffScope(req)
        if (!scope.departmentId) return res.status(400).json({ message: "Staff not assigned" })

        const fallback = todayKey()
        const from = parseYmd(req.query.from, fallback)
        const to = parseYmd(req.query.to, fallback)
        if (from > to) return res.status(400).json({ message: "Invalid date range" })

        const waitMsExpr = {
            $cond: [
                {
                    $and: [
                        { $ne: ["$calledAt", null] },
                        { $ne: ["$waitingSince", null] },
                    ],
                },
                { $subtract: ["$calledAt", "$waitingSince"] },
                null,
            ],
        }

        const serviceMsExpr = {
            $cond: [
                {
                    $and: [
                        { $ne: ["$servedAt", null] },
                        { $ne: ["$calledAt", null] },
                    ],
                },
                { $subtract: ["$servedAt", "$calledAt"] },
                null,
            ],
        }

        const match: any = {
            department: { $in: scope.handledDepartmentIds },
            dateKey: { $gte: from, $lte: to },
        }

        const [agg] = await TicketModel.aggregate([
            { $match: match },
            {
                $facet: {
                    total: [{ $count: "count" }],
                    byStatus: [
                        { $group: { _id: "$status", count: { $sum: 1 } } },
                        { $sort: { _id: 1 } },
                    ],
                    timings: [
                        { $project: { waitMs: waitMsExpr, serviceMs: serviceMsExpr } },
                        {
                            $group: {
                                _id: null,
                                avgWaitMs: { $avg: "$waitMs" },
                                avgServiceMs: { $avg: "$serviceMs" },
                            },
                        },
                    ],
                    byDepartment: [
                        {
                            $group: {
                                _id: "$department",
                                total: { $sum: 1 },
                                waiting: { $sum: { $cond: [{ $eq: ["$status", "WAITING"] }, 1, 0] } },
                                called: { $sum: { $cond: [{ $eq: ["$status", "CALLED"] }, 1, 0] } },
                                hold: { $sum: { $cond: [{ $eq: ["$status", "HOLD"] }, 1, 0] } },
                                out: { $sum: { $cond: [{ $eq: ["$status", "OUT"] }, 1, 0] } },
                                served: { $sum: { $cond: [{ $eq: ["$status", "SERVED"] }, 1, 0] } },
                                avgWaitMs: { $avg: waitMsExpr },
                                avgServiceMs: { $avg: serviceMsExpr },
                            },
                        },
                        {
                            $lookup: {
                                from: "departments",
                                localField: "_id",
                                foreignField: "_id",
                                as: "department",
                            },
                        },
                        { $unwind: { path: "$department", preserveNullAndEmptyArrays: true } },
                        {
                            $project: {
                                _id: 1,
                                name: "$department.name",
                                code: "$department.code",
                                total: 1,
                                waiting: 1,
                                called: 1,
                                hold: 1,
                                out: 1,
                                served: 1,
                                avgWaitMs: 1,
                                avgServiceMs: 1,
                            },
                        },
                        { $sort: { name: 1 } },
                    ],
                },
            },
        ]).exec()

        const total = agg?.total?.[0]?.count ?? 0

        const byStatusArr: Array<{ _id: string; count: number }> = agg?.byStatus ?? []
        const byStatus: Record<string, number> = {
            WAITING: 0,
            CALLED: 0,
            HOLD: 0,
            OUT: 0,
            SERVED: 0,
        }
        for (const row of byStatusArr) byStatus[row._id] = row.count

        const timingRow = agg?.timings?.[0] ?? null
        const avgWaitMs = timingRow?.avgWaitMs ?? null
        const avgServiceMs = timingRow?.avgServiceMs ?? null

        const departments = (agg?.byDepartment ?? []).map((d: any) => ({
            departmentId: d._id ? String(d._id) : "",
            name: d.name,
            code: d.code,
            total: d.total ?? 0,
            waiting: d.waiting ?? 0,
            called: d.called ?? 0,
            hold: d.hold ?? 0,
            out: d.out ?? 0,
            served: d.served ?? 0,
            avgWaitMs: d.avgWaitMs ?? null,
            avgServiceMs: d.avgServiceMs ?? null,
        }))

        return res.json({
            range: { from, to },
            totals: {
                total,
                byStatus,
                avgWaitMs,
                avgServiceMs,
            },
            departments,
        })
    },

    /**
     * GET /staff/reports/timeseries?from=YYYY-MM-DD&to=YYYY-MM-DD
     * - Scoped to staff's assigned window group (or assigned department if no group mapping).
     */
    reportsTimeseries: async (req: Request, res: Response) => {
        const scope = await resolveStaffScope(req)
        if (!scope.departmentId) return res.status(400).json({ message: "Staff not assigned" })

        const fallback = todayKey()
        const from = parseYmd(req.query.from, fallback)
        const to = parseYmd(req.query.to, fallback)
        if (from > to) return res.status(400).json({ message: "Invalid date range" })

        const match: any = {
            department: { $in: scope.handledDepartmentIds },
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
