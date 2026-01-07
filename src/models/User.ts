import mongoose, { Schema, Types } from "mongoose"

export type UserRole = "ADMIN" | "STAFF"

export type UserDoc = {
    name: string
    email: string
    role: UserRole
    active: boolean

    passwordSalt: string
    passwordHash: string
    passwordAlgo: "pbkdf2-sha256"
    passwordIterations: number

    assignedDepartment?: Types.ObjectId
    assignedWindow?: Types.ObjectId

    // ✅ Password reset fields
    passwordResetTokenHash?: string
    passwordResetExpiresAt?: Date

    createdAt: Date
    updatedAt: Date
}

const UserSchema = new Schema<UserDoc>(
    {
        name: { type: String, required: true, trim: true },
        email: { type: String, required: true, unique: true, lowercase: true, trim: true },
        role: { type: String, enum: ["ADMIN", "STAFF"], required: true },
        active: { type: Boolean, default: true },

        passwordSalt: { type: String, required: true },
        passwordHash: { type: String, required: true },
        passwordAlgo: { type: String, default: "pbkdf2-sha256" },
        passwordIterations: { type: Number, default: 150000 },

        assignedDepartment: { type: Schema.Types.ObjectId, ref: "Department" },
        assignedWindow: { type: Schema.Types.ObjectId, ref: "ServiceWindow" },

        // ✅ Password reset fields
        passwordResetTokenHash: { type: String },
        passwordResetExpiresAt: { type: Date },
    },
    { timestamps: true }
)

export const UserModel = mongoose.model<UserDoc>("User", UserSchema)
