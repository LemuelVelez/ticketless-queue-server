import mongoose, { Schema, Types } from "mongoose"

export type UserRole = "ADMIN" | "STAFF" | "STUDENT" | "ALUMNI_VISITOR" | "GUEST"
export type ParticipantType = "STUDENT" | "ALUMNI_VISITOR" | "GUEST"

export type UserDoc = {
    // Core identity
    name: string
    email?: string
    role: UserRole
    active: boolean

    // Credentials (admin/staff password OR participant PIN-as-password)
    passwordSalt: string
    passwordHash: string
    passwordAlgo: "pbkdf2-sha256"
    passwordIterations: number

    // Staff assignment
    assignedTransactionManager?: string
    assignedDepartment?: Types.ObjectId
    assignedDepartments?: Types.ObjectId[]
    assignedWindow?: Types.ObjectId

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

function normalizeObjectIdList(values: Array<Types.ObjectId | string | null | undefined>) {
    const seen = new Set<string>()
    const out: Types.ObjectId[] = []

    for (const raw of values) {
        const s = String(raw ?? "").trim()
        if (!s || !Types.ObjectId.isValid(s) || seen.has(s)) continue
        seen.add(s)
        out.push(new Types.ObjectId(s))
    }

    return out
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
            required: function (this: UserDoc) {
                return isStaffRole(this.role)
            },
        },

        role: { type: String, enum: userRoles, required: true },
        active: { type: Boolean, default: true },

        passwordSalt: { type: String, required: true },
        passwordHash: { type: String, required: true },
        passwordAlgo: { type: String, default: "pbkdf2-sha256" },
        passwordIterations: { type: Number, default: 150000 },

        assignedTransactionManager: {
            type: String,
            trim: true,
            uppercase: true,
            index: true,
        },

        assignedDepartment: { type: Schema.Types.ObjectId, ref: "Department" },

        assignedDepartments: {
            type: [{ type: Schema.Types.ObjectId, ref: "Department" }],
            default: undefined,
        },

        assignedWindow: { type: Schema.Types.ObjectId, ref: "ServiceWindow" },

        // Participant fields used by register/login flow
        type: { type: String, enum: participantTypes },
        firstName: { type: String, trim: true },
        middleName: { type: String, trim: true },
        lastName: { type: String, trim: true },

        tcNumber: {
            type: String,
            trim: true,
            sparse: true,
            required: function (this: UserDoc) {
                return this.role === "STUDENT" || this.type === "STUDENT"
            },
        },
        studentId: { type: String, trim: true, sparse: true }, // alias of tcNumber

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

        // ✅ Avatar fields
        avatarKey: { type: String },
        avatarUrl: { type: String },

        // ✅ Password reset fields
        passwordResetTokenHash: { type: String },
        passwordResetExpiresAt: { type: Date },
    },
    { timestamps: true }
)

// Unique identifiers where applicable
UserSchema.index({ email: 1 }, { unique: true, sparse: true })
UserSchema.index({ tcNumber: 1 }, { unique: true, sparse: true })
UserSchema.index({ studentId: 1 }, { unique: true, sparse: true })

// Query/perf indexes for staff assignment lookups
UserSchema.index({ role: 1, assignedDepartment: 1 })
UserSchema.index({ role: 1, assignedDepartments: 1 })
UserSchema.index({ role: 1, assignedWindow: 1 })

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

    // Compose display name if not explicitly set
    if (!doc.name) {
        const composed = [doc.firstName, doc.middleName, doc.lastName]
            .map((x) => String(x ?? "").trim())
            .filter(Boolean)
            .join(" ")
        doc.name = composed
    }

    // STAFF: keep single + multi department assignments in sync.
    if (doc.role === "STAFF") {
        const primary = doc.assignedDepartment ? String(doc.assignedDepartment) : ""
        const arr = Array.isArray(doc.assignedDepartments) ? doc.assignedDepartments : []
        const merged = normalizeObjectIdList([primary, ...arr.map((v) => String(v))])

        if (merged.length > 0) {
            doc.assignedDepartments = merged
            doc.assignedDepartment = merged[0]
        } else {
            doc.assignedDepartments = undefined
            doc.assignedDepartment = undefined
        }
    } else {
        // Non-STAFF users should not carry staff assignment fields.
        doc.assignedTransactionManager = undefined
        doc.assignedDepartment = undefined
        doc.assignedDepartments = undefined
        doc.assignedWindow = undefined
    }

    next()
})

export const UserModel = mongoose.model<UserDoc>("User", UserSchema)
