import mongoose, { Schema, Types } from "mongoose"

export type UserRole = "ADMIN" | "STAFF" | "STUDENT" | "ALUMNI_VISITOR" | "GUEST"
export type ParticipantType = "STUDENT" | "ALUMNI_VISITOR" | "GUEST"

export type UserDoc = {
    // Core identity
    name: string
    email?: string
    role: UserRole
    active: boolean

    // Staff assignment fields
    assignedDepartment?: Types.ObjectId
    assignedDepartments?: Types.ObjectId[]
    assignedWindow?: Types.ObjectId
    assignedTransactionManager?: string

    // Credentials (admin/staff password OR participant PIN-as-password)
    passwordSalt: string
    passwordHash: string
    passwordAlgo: "pbkdf2-sha256"
    passwordIterations: number

    // Participant registration fields (used by register page)
    type?: ParticipantType
    firstName?: string
    middleName?: string
    lastName?: string
    tcNumber?: string
    studentId?: string // alias
    mobileNumber?: string
    phone?: string // alias
    departmentId?: Types.ObjectId

    // ✅ Participant preferences
    smsUpdates?: boolean

    // ✅ Avatar fields
    avatarKey?: string
    avatarUrl?: string

    // ✅ Password reset fields
    passwordResetTokenHash?: string
    passwordResetExpiresAt?: Date

    createdAt: Date
    updatedAt: Date
}

const participantTypes: ParticipantType[] = ["STUDENT", "ALUMNI_VISITOR", "GUEST"]
const userRoles: UserRole[] = ["ADMIN", "STAFF", "STUDENT", "ALUMNI_VISITOR", "GUEST"]

function isParticipantRole(role?: string) {
    return role === "STUDENT" || role === "ALUMNI_VISITOR" || role === "GUEST"
}

function isStaffRole(role?: string) {
    return role === "ADMIN" || role === "STAFF"
}

const UserSchema = new Schema<UserDoc>(
    {
        name: { type: String, required: true, trim: true },

        // Email is required for ADMIN/STAFF, optional for participant records.
        email: {
            type: String,
            lowercase: true,
            trim: true,
            sparse: true,
            unique: true,
            required: function (this: UserDoc) {
                return isStaffRole(this.role)
            },
        },

        role: { type: String, enum: userRoles, required: true },
        active: { type: Boolean, default: true },

        // Staff assignment fields
        assignedDepartment: { type: Schema.Types.ObjectId, ref: "Department", index: true },
        assignedDepartments: {
            type: [{ type: Schema.Types.ObjectId, ref: "Department" }],
            default: [],
            index: true,
        },
        assignedWindow: { type: Schema.Types.ObjectId, ref: "ServiceWindow", index: true },
        assignedTransactionManager: { type: String, trim: true, uppercase: true, index: true },

        passwordSalt: { type: String, required: true },
        passwordHash: { type: String, required: true },
        passwordAlgo: { type: String, default: "pbkdf2-sha256" },
        passwordIterations: { type: Number, default: 150000 },

        // Participant fields used by register/login flow
        type: { type: String, enum: participantTypes },
        firstName: { type: String, trim: true },
        middleName: { type: String, trim: true },
        lastName: { type: String, trim: true },

        tcNumber: {
            type: String,
            trim: true,
            sparse: true,
            unique: true,
            required: function (this: UserDoc) {
                return this.role === "STUDENT" || this.type === "STUDENT"
            },
        },
        studentId: { type: String, trim: true, sparse: true, unique: true }, // alias of tcNumber

        mobileNumber: {
            type: String,
            trim: true,
            sparse: true,
            required: function (this: UserDoc) {
                return isParticipantRole(this.role) || isParticipantRole(this.type)
            },
        },
        phone: { type: String, trim: true, sparse: true }, // alias of mobileNumber

        departmentId: {
            type: Schema.Types.ObjectId,
            ref: "Department",
            required: function (this: UserDoc) {
                return isParticipantRole(this.role) || isParticipantRole(this.type)
            },
        },

        // ✅ Participant preferences
        smsUpdates: { type: Boolean, default: true },

        // ✅ Avatar fields
        avatarKey: { type: String },
        avatarUrl: { type: String },

        // ✅ Password reset fields
        passwordResetTokenHash: { type: String },
        passwordResetExpiresAt: { type: Date },
    },
    { timestamps: true }
)

// Keep compatibility aliases synchronized
UserSchema.pre("validate", function (next) {
    const doc = this as UserDoc

    // If participant role is used directly, mirror to `type` when absent
    if (!doc.type && isParticipantRole(doc.role)) {
        doc.type = doc.role as ParticipantType
    }

    if (doc.tcNumber && !doc.studentId) {
        doc.studentId = doc.tcNumber
    } else if (doc.studentId && !doc.tcNumber) {
        doc.tcNumber = doc.studentId
    }

    if (doc.mobileNumber && !doc.phone) {
        doc.phone = doc.mobileNumber
    } else if (doc.phone && !doc.mobileNumber) {
        doc.mobileNumber = doc.phone
    }

    // Keep staff assignment fields consistent.
    if (isStaffRole(doc.role)) {
        const merged = new Set<string>()

        if (doc.assignedDepartment) merged.add(String(doc.assignedDepartment))
        for (const dep of doc.assignedDepartments || []) {
            if (dep) merged.add(String(dep))
        }

        doc.assignedDepartments = Array.from(merged)
            .map((id) => {
                try {
                    return new Types.ObjectId(id)
                } catch {
                    return null
                }
            })
            .filter((v): v is Types.ObjectId => Boolean(v))

        if (!doc.assignedDepartment && doc.assignedDepartments.length) {
            doc.assignedDepartment = doc.assignedDepartments[0]
        }
    }

    // Compose display name if not explicitly set
    if (!doc.name) {
        const composed = [doc.firstName, doc.middleName, doc.lastName]
            .map((x) => String(x ?? "").trim())
            .filter(Boolean)
            .join(" ")
        doc.name = composed
    }

    next()
})

export const UserModel = mongoose.model<UserDoc>("User", UserSchema)