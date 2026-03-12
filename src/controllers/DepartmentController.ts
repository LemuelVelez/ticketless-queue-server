import type { NextFunction, Request, Response } from "express"
import { DepartmentService } from "../services/DepartmentService"
import { ControllerUtils } from "./ControllerUtils"

export class DepartmentController {
    static async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const departmentId = ControllerUtils.getValue(req.params.id, req.params.departmentId)

            if (!departmentId) {
                ControllerUtils.sendBadRequest(res, "departmentId is required")
                return
            }

            const department = await DepartmentService.getById(departmentId)

            if (!department) {
                ControllerUtils.sendNotFound(res, "Department not found")
                return
            }

            res.status(200).json({ data: department })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }

    static async listEnabled(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const departments = await DepartmentService.listEnabled()

            res.status(200).json({
                data: departments,
                count: departments.length,
            })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }

    static async listByTransactionManager(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {
        try {
            const transactionManager = ControllerUtils.getValue(
                req.params.transactionManager,
                req.query.transactionManager
            )

            if (!transactionManager) {
                ControllerUtils.sendBadRequest(res, "transactionManager is required")
                return
            }

            const includeDisabled = ControllerUtils.parseBoolean(
                req.query.includeDisabled,
                false
            )

            const departments = await DepartmentService.listByTransactionManager(
                transactionManager,
                includeDisabled
            )

            res.status(200).json({
                data: departments,
                count: departments.length,
            })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }
}