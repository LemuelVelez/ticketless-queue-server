import type { NextFunction, Request, Response } from "express"
import { ControllerUtils } from "./ControllerUtils"
import { PublicDisplayService } from "../services/PublicDisplayService"

export class PublicDisplayController {
    static async listManagers(
        _req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {
        try {
            const managers = await PublicDisplayService.listManagers()

            res.status(200).json({
                data: managers,
                count: managers.length,
            })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }

    static async getState(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {
        try {
            const transactionManager = ControllerUtils.getValue(
                req.params.transactionManager,
                req.query.transactionManager,
                req.query.manager
            )

            if (!transactionManager) {
                ControllerUtils.sendBadRequest(
                    res,
                    "transactionManager or manager is required"
                )
                return
            }

            const dateKey = ControllerUtils.getDateKey(req.query.dateKey)
            const since = ControllerUtils.getValue(req.query.since)

            const state = await PublicDisplayService.getState(
                transactionManager,
                dateKey,
                since
            )

            res.status(200).json({
                data: state,
            })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }
}