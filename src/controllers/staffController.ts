import type { Request, Response } from "express"
import { TicketModel } from "../models/Ticket"
import { SettingModel } from "../models/Setting"
import { ServiceWindowModel } from "../models/ServiceWindow"
import { AuditLogModel } from "../models/AuditLog"

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

export const staffController = {
    myAssignment: async (req: Request, res: Response) => {
        const { departmentId, windowId } = staffCtx(req)
        const window = windowId ? await ServiceWindowModel.findById(windowId) : null
        return res.json({ departmentId: departmentId || null, window })
    },

    callNext: async (req: Request, res: Response) => {
        const { departmentId, windowId, actor, actorRole } = staffCtx(req)
        if (!departmentId || !windowId) return res.status(400).json({ message: "Staff not assigned" })

        const win = await ServiceWindowModel.findById(windowId)
        if (!win || !win.enabled) return res.status(400).json({ message: "Assigned window not found/disabled" })

        const dateKey = todayKey()

        // Oldest WAITING by waitingSince (HOLD returns go to end because waitingSince is refreshed)
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
        ticket.waitingSince = new Date() // goes to end of WAITING line
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
}
