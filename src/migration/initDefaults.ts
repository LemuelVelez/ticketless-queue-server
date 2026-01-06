import { SettingModel } from "../models/Setting"

export async function initDefaults() {
    // Ensure exactly one settings doc exists
    const existing = await SettingModel.findOne({})
    if (!existing) {
        await SettingModel.create({
            maxHoldAttempts: 4,
            disallowDuplicateActiveTickets: true,
            upNextCount: 5,
        })
    }
}
