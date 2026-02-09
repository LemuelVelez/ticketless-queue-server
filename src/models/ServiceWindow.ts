import mongoose, { Schema, Types } from "mongoose"

export type ServiceWindowDoc = {
    /**
     * Legacy primary department binding (kept for backward compatibility).
     * This is always synced to the first value of departmentIds.
     */
    department: Types.ObjectId

    /**
     * A window can belong to multiple departments.
     */
    departmentIds: Types.ObjectId[]

    name: string
    number: number
    enabled: boolean
    createdAt: Date
    updatedAt: Date
}

const ServiceWindowSchema = new Schema<ServiceWindowDoc>(
    {
        department: { type: Schema.Types.ObjectId, ref: "Department", required: true, index: true },

        departmentIds: {
            type: [{ type: Schema.Types.ObjectId, ref: "Department" }],
            default: [],
            index: true,
        },

        name: { type: String, required: true, trim: true },
        number: { type: Number, required: true },
        enabled: { type: Boolean, default: true },
    },
    { timestamps: true }
)

ServiceWindowSchema.index({ department: 1, number: 1 }, { unique: true })
ServiceWindowSchema.index({ departmentIds: 1, enabled: 1 })

export const ServiceWindowModel = mongoose.model<ServiceWindowDoc>("ServiceWindow", ServiceWindowSchema)
