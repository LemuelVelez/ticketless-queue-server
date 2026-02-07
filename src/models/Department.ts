import mongoose, { Schema } from "mongoose"

export type DepartmentDoc = {
    name: string
    code?: string

    /**
     * Top-level office/unit that manages the department's queue transactions.
     * Examples: REGISTRAR, LIBRARY, ADMIN_BUILDING
     */
    transactionManager: string

    enabled: boolean
    createdAt: Date
    updatedAt: Date
}

const DepartmentSchema = new Schema<DepartmentDoc>(
    {
        name: { type: String, required: true, trim: true },
        code: { type: String, trim: true },

        transactionManager: {
            type: String,
            required: true,
            trim: true,
            uppercase: true,
            default: "REGISTRAR",
            index: true,
        },

        enabled: { type: Boolean, default: true },
    },
    { timestamps: true }
)

DepartmentSchema.index({ transactionManager: 1, enabled: 1, name: 1 })

export const DepartmentModel = mongoose.model<DepartmentDoc>("Department", DepartmentSchema)
