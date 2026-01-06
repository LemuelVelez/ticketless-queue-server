import mongoose, { Schema } from "mongoose"

export type DepartmentDoc = {
    name: string
    code?: string
    enabled: boolean
    createdAt: Date
    updatedAt: Date
}

const DepartmentSchema = new Schema<DepartmentDoc>(
    {
        name: { type: String, required: true, trim: true },
        code: { type: String, trim: true },
        enabled: { type: Boolean, default: true },
    },
    { timestamps: true }
)

export const DepartmentModel = mongoose.model<DepartmentDoc>("Department", DepartmentSchema)
