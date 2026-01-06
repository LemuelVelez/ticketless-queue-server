import mongoose, { Schema } from "mongoose"

export type SettingDoc = {
    maxHoldAttempts: number
    disallowDuplicateActiveTickets: boolean
    upNextCount: number
    createdAt: Date
    updatedAt: Date
}

const SettingSchema = new Schema<SettingDoc>(
    {
        maxHoldAttempts: { type: Number, default: 4, min: 1, max: 20 },
        disallowDuplicateActiveTickets: { type: Boolean, default: true },
        upNextCount: { type: Number, default: 5, min: 1, max: 20 },
    },
    { timestamps: true }
)

export const SettingModel = mongoose.model<SettingDoc>("Setting", SettingSchema)
