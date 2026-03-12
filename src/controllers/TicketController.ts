import type { NextFunction, Request, Response } from "express"
import { TicketService } from "../services/TicketService"
import { ControllerUtils } from "./ControllerUtils"

export class TicketController {
    static async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const ticketId = ControllerUtils.getValue(req.params.id, req.params.ticketId)

            if (!ticketId) {
                ControllerUtils.sendBadRequest(res, "ticketId is required")
                return
            }

            const ticket = await TicketService.getById(ticketId)

            if (!ticket) {
                ControllerUtils.sendNotFound(res, "Ticket not found")
                return
            }

            res.status(200).json({ data: ticket })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }

    static async listRecent(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const limit = ControllerUtils.parseLimit(req.query.limit, 50)

            const tickets = await TicketService.listRecent(limit)

            res.status(200).json({
                data: tickets,
                count: tickets.length,
            })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }

    static async listQueueByDepartment(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {
        try {
            const departmentId = ControllerUtils.getValue(
                req.params.departmentId,
                req.query.departmentId
            )

            if (!departmentId) {
                ControllerUtils.sendBadRequest(res, "departmentId is required")
                return
            }

            const dateKey = ControllerUtils.getDateKey(req.query.dateKey)

            const tickets = await TicketService.listQueueByDepartment(departmentId, dateKey)

            res.status(200).json({
                data: tickets,
                count: tickets.length,
                dateKey,
            })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }

    static async listActiveByDepartment(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {
        try {
            const departmentId = ControllerUtils.getValue(
                req.params.departmentId,
                req.query.departmentId
            )

            if (!departmentId) {
                ControllerUtils.sendBadRequest(res, "departmentId is required")
                return
            }

            const dateKey = ControllerUtils.getDateKey(req.query.dateKey)

            const tickets = await TicketService.listActiveByDepartment(departmentId, dateKey)

            res.status(200).json({
                data: tickets,
                count: tickets.length,
                dateKey,
            })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }
}