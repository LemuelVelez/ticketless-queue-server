import type { Request, Response } from "express"
import { Types } from "mongoose"

import { DepartmentModel } from "../models/Department"
import { TicketModel } from "../models/Ticket"
import { getDateKeyManila } from "../services/queue.service"

const STATUS_ORDER = ["WAITING", "CALLED", "HOLD", "SERVED", "OUT"] as const
const ACTIVE_STATUSES = ["WAITING", "CALLED", "HOLD"] as const
type ParticipantType = "STUDENT" | "ALUMNI_VISITOR" | "GUEST"

function asString(v: unknown) {
    if (typeof v === "string") return v.trim()
    if (Array.isArray(v) && v.length) return String(v[0] ?? "").trim()
    return ""
}

function normalizeParticipantType(v: unknown): ParticipantType | null {
    const s = asString(v).toUpperCase()
    if (s === "STUDENT" || s === "ALUMNI_VISITOR" || s === "GUEST") return s
    return null
}

function dateKeyManila(date: Date) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Manila",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date)

    const year = parts.find((p) => p.type === "year")?.value ?? "0000"
    const month = parts.find((p) => p.type === "month")?.value ?? "01"
    const day = parts.find((p) => p.type === "day")?.value ?? "01"

    return `${year}-${month}-${day}`
}

function recentDateKeys(days: number) {
    const out: string[] = []
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000)
        out.push(dateKeyManila(d))
    }
    return out
}

export const homeController = {
    overview: async (req: Request, res: Response) => {
        try {
            const participantType = normalizeParticipantType(req.query.participantType)
            const departmentId = asString(req.query.departmentId)

            const daysRaw = Number(asString(req.query.days) || "7")
            const days = Number.isFinite(daysRaw) ? Math.max(3, Math.min(14, Math.trunc(daysRaw))) : 7

            let departmentObjectId: Types.ObjectId | null = null
            if (departmentId) {
                if (!Types.ObjectId.isValid(departmentId)) {
                    return res.status(400).json({ message: "Invalid departmentId" })
                }
                departmentObjectId = new Types.ObjectId(departmentId)
            }

            const dateKey = getDateKeyManila()
            const baseMatch: Record<string, unknown> = departmentObjectId ? { department: departmentObjectId } : {}
            const todayMatch = { ...baseMatch, dateKey }

            const statusRows = await TicketModel.aggregate<{ _id: string; count: number }>([
                { $match: todayMatch },
                { $group: { _id: "$status", count: { $sum: 1 } } },
            ])

            const byStatus: Record<(typeof STATUS_ORDER)[number], number> = {
                WAITING: 0,
                CALLED: 0,
                HOLD: 0,
                SERVED: 0,
                OUT: 0,
            }

            for (const row of statusRows) {
                const key = String(row._id || "").toUpperCase() as (typeof STATUS_ORDER)[number]
                if (key in byStatus) byStatus[key] = Number(row.count || 0)
            }

            const totalToday = STATUS_ORDER.reduce((acc, s) => acc + (byStatus[s] || 0), 0)
            const activeTickets = ACTIVE_STATUSES.reduce((acc, s) => acc + (byStatus[s] || 0), 0)
            const servedToday = byStatus.SERVED || 0

            const departmentLoadRaw = await TicketModel.aggregate<{
                departmentId: Types.ObjectId
                name?: string
                code?: string
                total: number
                waiting: number
                called: number
                hold: number
                served: number
                out: number
            }>([
                { $match: todayMatch },
                {
                    $group: {
                        _id: "$department",
                        total: { $sum: 1 },
                        waiting: { $sum: { $cond: [{ $eq: ["$status", "WAITING"] }, 1, 0] } },
                        called: { $sum: { $cond: [{ $eq: ["$status", "CALLED"] }, 1, 0] } },
                        hold: { $sum: { $cond: [{ $eq: ["$status", "HOLD"] }, 1, 0] } },
                        served: { $sum: { $cond: [{ $eq: ["$status", "SERVED"] }, 1, 0] } },
                        out: { $sum: { $cond: [{ $eq: ["$status", "OUT"] }, 1, 0] } },
                    },
                },
                { $sort: { total: -1 } },
                { $limit: 8 },
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
                        _id: 0,
                        departmentId: "$_id",
                        name: "$department.name",
                        code: "$department.code",
                        total: 1,
                        waiting: 1,
                        called: 1,
                        hold: 1,
                        served: 1,
                        out: 1,
                    },
                },
            ])

            const departmentLoad = departmentLoadRaw.map((row) => ({
                departmentId: String(row.departmentId),
                name: row.name || "Unknown Department",
                code: row.code || "",
                total: Number(row.total || 0),
                waiting: Number(row.waiting || 0),
                called: Number(row.called || 0),
                hold: Number(row.hold || 0),
                served: Number(row.served || 0),
                out: Number(row.out || 0),
            }))

            const trendKeys = recentDateKeys(days)

            const trendRows = await TicketModel.aggregate<{
                _id: string
                total: number
                served: number
                waiting: number
                called: number
            }>([
                {
                    $match: {
                        ...baseMatch,
                        dateKey: { $in: trendKeys },
                    },
                },
                {
                    $group: {
                        _id: "$dateKey",
                        total: { $sum: 1 },
                        served: { $sum: { $cond: [{ $eq: ["$status", "SERVED"] }, 1, 0] } },
                        waiting: { $sum: { $cond: [{ $eq: ["$status", "WAITING"] }, 1, 0] } },
                        called: { $sum: { $cond: [{ $eq: ["$status", "CALLED"] }, 1, 0] } },
                    },
                },
                { $sort: { _id: 1 } },
            ])

            const trendMap = new Map<string, { total: number; served: number; waiting: number; called: number }>()
            for (const row of trendRows) {
                trendMap.set(String(row._id), {
                    total: Number(row.total || 0),
                    served: Number(row.served || 0),
                    waiting: Number(row.waiting || 0),
                    called: Number(row.called || 0),
                })
            }

            const trend = trendKeys.map((k) => {
                const found = trendMap.get(k)
                return {
                    dateKey: k,
                    total: found?.total ?? 0,
                    served: found?.served ?? 0,
                    waiting: found?.waiting ?? 0,
                    called: found?.called ?? 0,
                }
            })

            const enabledDepartments = await DepartmentModel.countDocuments({ enabled: true })

            let selectedDepartmentName: string | null = null
            if (departmentObjectId) {
                const selected = await DepartmentModel.findById(departmentObjectId).select("name").lean()
                selectedDepartmentName = selected?.name ?? null
            }

            return res.json({
                dateKey,
                generatedAt: new Date().toISOString(),
                participantType,
                scope: {
                    departmentId: departmentObjectId ? String(departmentObjectId) : null,
                    departmentName: selectedDepartmentName,
                },
                highlights: {
                    totalToday,
                    activeTickets,
                    servedToday,
                    enabledDepartments,
                },
                statusDistribution: STATUS_ORDER.map((status) => ({
                    status,
                    count: byStatus[status] || 0,
                })),
                departmentLoad,
                trend,
            })
        } catch (err) {
            const message = err instanceof Error ? err.message : "Unable to load home overview"
            return res.status(500).json({ message })
        }
    },
}
