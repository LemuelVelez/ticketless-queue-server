import mongoose, { Schema, Types } from "mongoose"

export type ServiceWindowDoc = {
    department: Types.ObjectId
    name: string
    number: number
    enabled: boolean
    createdAt: Date
    updatedAt: Date
}

const ServiceWindowSchema = new Schema<ServiceWindowDoc>(
    {
        department: { type: Schema.Types.ObjectId, ref: "Department", required: true, index: true },
        name: { type: String, required: true, trim: true },
        number: { type: Number, required: true },
        enabled: { type: Boolean, default: true },
    },
    { timestamps: true }
)

ServiceWindowSchema.index({ department: 1, number: 1 }, { unique: true })

export const ServiceWindowModel = mongoose.model<ServiceWindowDoc>("ServiceWindow", ServiceWindowSchema)
