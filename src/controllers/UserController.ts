import type { NextFunction, Request, Response } from "express"
import { UserService } from "../services/UserService"
import { ControllerUtils } from "./ControllerUtils"

export class UserController {
    static async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const userId = ControllerUtils.getValue(req.params.id, req.params.userId)

            if (!userId) {
                ControllerUtils.sendBadRequest(res, "userId is required")
                return
            }

            const user = await UserService.getById(userId)

            if (!user) {
                ControllerUtils.sendNotFound(res, "User not found")
                return
            }

            res.status(200).json({ data: user })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }

    static async getByStudentId(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const studentId = ControllerUtils.getValue(
                req.params.studentId,
                req.query.studentId
            )

            if (!studentId) {
                ControllerUtils.sendBadRequest(res, "studentId is required")
                return
            }

            const user = await UserService.getByStudentId(studentId)

            if (!user) {
                ControllerUtils.sendNotFound(res, "User not found")
                return
            }

            res.status(200).json({ data: user })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }

    static async listStaff(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const includeInactive = ControllerUtils.parseBoolean(
                req.query.includeInactive,
                false
            )

            const users = await UserService.listStaff(includeInactive)

            res.status(200).json({
                data: users,
                count: users.length,
            })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }

    static async listParticipants(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const includeInactive = ControllerUtils.parseBoolean(
                req.query.includeInactive,
                false
            )

            const users = await UserService.listParticipants(includeInactive)

            res.status(200).json({
                data: users,
                count: users.length,
            })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }
}