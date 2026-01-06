import type { Request, Response } from "express"
import { DepartmentModel } from "../models/Department"
import { TicketModel } from "../models/Ticket"
import { SettingModel } from "../models/Setting"
import { QueueCounterModel } from "../models/QueueCounter"

function todayKey() {
    return new Date().toISOString().slice(0, 10)
}

const ACTIVE_STATUSES = ["WAITING", "CALLED", "HOLD"] as const

async function nextQueueNumber(departmentId: string, dateKey: string) {
    const counter = await QueueCounterModel.findOneAndUpdate(
        { department: departmentId, dateKey },
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
    )
    return counter.seq
}

export const publicController = {
    listDepartments: async (_req: Request, res: Response) => {
        const departments = await DepartmentModel.find({ enabled: true }).sort({ name: 1 })
        return res.json({ departments })
    },

    joinQueue: async (req: Request, res: Response) => {
        const { departmentId, studentId, phone } = req.body || {}
        if (!departmentId || !studentId) {
            return res.status(400).json({ message: "departmentId and studentId are required" })
        }

        const dept = await DepartmentModel.findById(departmentId)
        if (!dept || !dept.enabled) return res.status(404).json({ message: "Department not found/disabled" })

        const settings = await SettingModel.findOne({})
        const disallowDup = settings?.disallowDuplicateActiveTickets ?? true

        const dateKey = todayKey()
        const sid = String(studentId).trim()

        if (disallowDup) {
            const existing = await TicketModel.findOne({
                department: departmentId,
                dateKey,
                studentId: sid,
                status: { $in: ACTIVE_STATUSES as any },
            })

            if (existing) {
                return res.status(409).json({
                    message: "Duplicate active ticket is not allowed for this department",
                    ticket: existing,
                })
            }
        }

        const queueNumber = await nextQueueNumber(String(departmentId), dateKey)

        const ticket = await TicketModel.create({
            department: departmentId,
            dateKey,
            queueNumber,
            studentId: sid,
            phone: phone ? String(phone).trim() : undefined,
            status: "WAITING",
            holdAttempts: 0,
            waitingSince: new Date(),
        })

        return res.status(201).json({ ticket })
    },

    getTicket: async (req: Request, res: Response) => {
        const { id } = req.params
        const ticket = await TicketModel.findById(id).populate("department", "name enabled")
        if (!ticket) return res.status(404).json({ message: "Ticket not found" })
        return res.json({ ticket })
    },

    // Handy lookup for student side (optional)
    findActiveByStudent: async (req: Request, res: Response) => {
        const { departmentId, studentId } = req.query as any
        if (!departmentId || !studentId) return res.status(400).json({ message: "departmentId and studentId are required" })

        const ticket = await TicketModel.findOne({
            department: String(departmentId),
            dateKey: todayKey(),
            studentId: String(studentId).trim(),
            status: { $in: ACTIVE_STATUSES as any },
        }).sort({ createdAt: -1 })

        return res.json({ ticket: ticket || null })
    },
}
