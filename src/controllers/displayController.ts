import type { Request, Response } from "express"
import { TicketModel } from "../models/Ticket"
import { DepartmentModel } from "../models/Department"
import { SettingModel } from "../models/Setting"

function todayKey() {
    return new Date().toISOString().slice(0, 10)
}

export const displayController = {
    departmentDisplay: async (req: Request, res: Response) => {
        const { departmentId } = req.params

        const dept = await DepartmentModel.findById(departmentId)
        if (!dept || !dept.enabled) return res.status(404).json({ message: "Department not found/disabled" })

        const settings = await SettingModel.findOne({})
        const upNextCount = settings?.upNextCount ?? 5

        const dateKey = todayKey()

        // Latest called ticket (now serving) for today
        const nowServing = await TicketModel.findOne({
            department: departmentId,
            dateKey,
            status: "CALLED",
        }).sort({ calledAt: -1 })

        const upNext = await TicketModel.find({
            department: departmentId,
            dateKey,
            status: "WAITING",
        })
            .sort({ waitingSince: 1 })
            .limit(upNextCount)

        return res.json({
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
}
