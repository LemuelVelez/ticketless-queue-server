import type { Request, Response } from "express"

import { TicketModel } from "../models/Ticket"
import { DepartmentModel } from "../models/Department"
import { SettingModel } from "../models/Setting"

import {
    buildPublicDisplayMonitorText,
    getPublicDisplayMonitorSnapshot,
    getVoiceAnnouncementForTicket,
} from "../services/displayMonitor.service"
import { getDateKeyManila } from "../services/queue.service"

function resolveDateKey(value: unknown) {
    const raw = typeof value === "string" ? value.trim() : ""
    return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : getDateKeyManila()
}

export const displayController = {
    departmentDisplay: async (req: Request, res: Response) => {
        const { departmentId } = req.params

        const dept = await DepartmentModel.findById(departmentId)
        if (!dept || !dept.enabled) return res.status(404).json({ message: "Department not found/disabled" })

        const settings = await SettingModel.findOne({})
        const upNextCount = settings?.upNextCount ?? 5

        const dateKey = resolveDateKey(req.query.dateKey)

        // Latest called ticket (now serving) for selected dateKey
        const nowServing = await TicketModel.findOne({
            department: departmentId,
            dateKey,
            status: "CALLED",
        }).sort({ calledAt: -1, updatedAt: -1 })

        const upNext = await TicketModel.find({
            department: departmentId,
            dateKey,
            status: "WAITING",
        })
            .sort({ queueNumber: 1, waitingSince: 1 })
            .limit(upNextCount)

        return res.json({
            dateKey,
            department: { id: String(dept._id), name: dept.name },
            nowServing: nowServing
                ? {
                    id: String(nowServing._id),
                    queueNumber: nowServing.queueNumber,
                    windowNumber: nowServing.windowNumber ?? null,
                    calledAt: nowServing.calledAt ?? null,
                }
                : null,
            upNext: upNext.map((t) => ({
                id: String(t._id),
                queueNumber: t.queueNumber,
            })),
        })
    },

    monitorSnapshot: async (req: Request, res: Response) => {
        const dateKey = resolveDateKey(req.query.dateKey)
        const snapshot = await getPublicDisplayMonitorSnapshot(dateKey)

        return res.json({ dateKey, snapshot })
    },

    monitorText: async (req: Request, res: Response) => {
        const dateKey = resolveDateKey(req.query.dateKey)
        const snapshot = await getPublicDisplayMonitorSnapshot(dateKey)
        const text = buildPublicDisplayMonitorText(snapshot)

        return res.json({ dateKey, text })
    },

    voiceAnnouncement: async (req: Request, res: Response) => {
        const ticketId = String(req.params.ticketId || req.query.ticketId || "").trim()
        if (!ticketId) return res.status(400).json({ message: "ticketId is required" })

        const message = await getVoiceAnnouncementForTicket(ticketId)
        return res.json({ ticketId, message })
    },
}
