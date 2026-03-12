import type { NextFunction, Request, Response } from "express"
import { SettingService } from "../services/SettingService"
import { ControllerUtils } from "./ControllerUtils"

export class SettingController {
    static async getCurrent(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const setting = await SettingService.getCurrent()

            res.status(200).json({ data: setting })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }
}