import { SettingModel } from "../models/Model"
import { NameService } from "./NameService"

export type SettingView = {
    id: string
    maxHoldAttempts: number
    disallowDuplicateActiveTickets: boolean
    upNextCount: number
    createdAt?: Date
    updatedAt?: Date
}

export class SettingService {
    static toView(setting: any): SettingView {
        return {
            id: NameService.toIdString(setting?._id) ?? "",
            maxHoldAttempts: Number(setting?.maxHoldAttempts ?? 4),
            disallowDuplicateActiveTickets: Boolean(setting?.disallowDuplicateActiveTickets),
            upNextCount: Number(setting?.upNextCount ?? 5),
            createdAt: setting?.createdAt,
            updatedAt: setting?.updatedAt,
        }
    }

    static async getCurrent(): Promise<SettingView> {
        let setting = await SettingModel.findOne({}).sort({ createdAt: 1 }).exec()

        if (!setting) {
            setting = await SettingModel.create({})
        }

        return SettingService.toView(setting)
    }
}