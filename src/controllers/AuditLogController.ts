import type { NextFunction, Request, Response } from "express"
import { AuditLogService } from "../services/AuditLogService"
import { ControllerUtils } from "./ControllerUtils"

export class AuditLogController {
    static async listRecent(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const limit = ControllerUtils.parseLimit(req.query.limit, 50)

            const logs = await AuditLogService.listRecent(limit)

            res.status(200).json({
                data: logs,
                count: logs.length,
            })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }

    static async getByActor(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const actorId = ControllerUtils.getValue(req.params.actorId, req.query.actorId)

            if (!actorId) {
                ControllerUtils.sendBadRequest(res, "actorId is required")
                return
            }

            const limit = ControllerUtils.parseLimit(req.query.limit, 50)

            const logs = await AuditLogService.getByActor(actorId, limit)

            res.status(200).json({
                data: logs,
                count: logs.length,
            })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }
}