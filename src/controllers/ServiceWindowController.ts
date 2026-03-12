import type { NextFunction, Request, Response } from "express"
import { ServiceWindowService } from "../services/ServiceWindowService"
import { ControllerUtils } from "./ControllerUtils"

export class ServiceWindowController {
    static async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const windowId = ControllerUtils.getValue(req.params.id, req.params.windowId)

            if (!windowId) {
                ControllerUtils.sendBadRequest(res, "windowId is required")
                return
            }

            const window = await ServiceWindowService.getById(windowId)

            if (!window) {
                ControllerUtils.sendNotFound(res, "Service window not found")
                return
            }

            res.status(200).json({ data: window })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }

    static async listEnabled(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const windows = await ServiceWindowService.listEnabled()

            res.status(200).json({
                data: windows,
                count: windows.length,
            })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }

    static async listByDepartment(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const departmentId = ControllerUtils.getValue(
                req.params.departmentId,
                req.query.departmentId
            )

            if (!departmentId) {
                ControllerUtils.sendBadRequest(res, "departmentId is required")
                return
            }

            const includeDisabled = ControllerUtils.parseBoolean(
                req.query.includeDisabled,
                false
            )

            const windows = await ServiceWindowService.listByDepartment(
                departmentId,
                includeDisabled
            )

            res.status(200).json({
                data: windows,
                count: windows.length,
            })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }
}