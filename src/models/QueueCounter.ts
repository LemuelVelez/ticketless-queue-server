import mongoose, { Schema, Types } from "mongoose"

export type QueueCounterDoc = {
    department: Types.ObjectId
    dateKey: string
    seq: number
}

const QueueCounterSchema = new Schema<QueueCounterDoc>(
    {
        department: { type: Schema.Types.ObjectId, ref: "Department", required: true, index: true },
        dateKey: { type: String, required: true, index: true },
        seq: { type: Number, default: 0 },
    },
    { versionKey: false }
)

QueueCounterSchema.index({ department: 1, dateKey: 1 }, { unique: true })

export const QueueCounterModel = mongoose.model<QueueCounterDoc>("QueueCounter", QueueCounterSchema)
