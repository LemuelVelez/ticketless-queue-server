import mongoose, { Schema, Types } from "mongoose"

export type UserRole = "ADMIN" | "STAFF" | "STUDENT" | "ALUMNI_VISITOR" | "GUEST"
export type ParticipantType = "STUDENT" | "ALUMNI_VISITOR" | "GUEST"
export type TicketStatus = "WAITING" | "CALLED" | "HOLD" | "OUT" | "SERVED"
export type TicketParticipantType = "STUDENT" | "ALUMNI_VISITOR" | "GUEST"

export type AuditLogDoc = {
    actor?: Types.ObjectId
    actorRole?: UserRole
    action: string
    entityType?: string
    entityId?: Types.ObjectId
    meta?: Record<string, unknown>
    createdAt: Date
}

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

export type QueueCounterDoc = {
    department: Types.ObjectId
    dateKey: string
    seq: number
}

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

export type SettingDoc = {
    maxHoldAttempts: number
    disallowDuplicateActiveTickets: boolean
    upNextCount: number
    createdAt: Date
    updatedAt: Date
}

export type TicketDoc = {
    department: Types.ObjectId
    dateKey: string
    queueNumber: number

    studentId: string
    phone?: string

    /**
     * ✅ Participant display label (full name).
     * Used by window/monitor UIs so they can display a friendly participant name
     * without always populating the participant document.
     */
    participantLabel?: string

    /**
     * Who joined the queue.
     * Useful for staff visibility (Student / Alumni-Visitor / Guest).
     */
    participantType?: TicketParticipantType

    /**
     * Queue purpose / transaction context.
     * These fields allow staff to see why the participant joined.
     */
    transactionCategory?: string
    transactionKey?: string
    transactionLabel?: string
    purpose?: string

    status: TicketStatus
    holdAttempts: number

    waitingSince: Date
    window?: Types.ObjectId
    windowNumber?: number

    calledAt?: Date
    servedAt?: Date
    outAt?: Date

    createdAt: Date
    updatedAt: Date
}

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

const AuditLogSchema = new Schema<AuditLogDoc>(
    {
        actor: { type: Schema.Types.ObjectId, ref: "User" },
        actorRole: { type: String, enum: ["ADMIN", "STAFF"] },
        action: { type: String, required: true },
        entityType: { type: String },
        entityId: { type: Schema.Types.ObjectId },
        meta: { type: Schema.Types.Mixed },
        createdAt: { type: Date, default: () => new Date() },
    },
    { versionKey: false }
)

AuditLogSchema.index({ createdAt: -1 })
AuditLogSchema.index({ action: 1, createdAt: -1 })
AuditLogSchema.index({ actor: 1, createdAt: -1 })
AuditLogSchema.index({ entityType: 1, createdAt: -1 })

const DepartmentSchema = new Schema<DepartmentDoc>(
    {
        name: { type: String, required: true, trim: true },
        code: { type: String, trim: true },
        transactionManager: {
            type: String,
            required: true,
            trim: true,
            uppercase: true,
            index: true,
        },
        enabled: { type: Boolean, default: true },
    },
    { timestamps: true }
)

DepartmentSchema.index({ transactionManager: 1, enabled: 1, name: 1 })

const QueueCounterSchema = new Schema<QueueCounterDoc>(
    {
        department: { type: Schema.Types.ObjectId, ref: "Department", required: true, index: true },
        dateKey: { type: String, required: true, index: true },
        seq: { type: Number, default: 0 },
    },
    { versionKey: false }
)

QueueCounterSchema.index({ department: 1, dateKey: 1 }, { unique: true })

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

const SettingSchema = new Schema<SettingDoc>(
    {
        maxHoldAttempts: { type: Number, default: 4, min: 1, max: 20 },
        disallowDuplicateActiveTickets: { type: Boolean, default: true },
        upNextCount: { type: Number, default: 5, min: 1, max: 20 },
    },
    { timestamps: true }
)

const TicketSchema = new Schema<TicketDoc>(
    {
        department: { type: Schema.Types.ObjectId, ref: "Department", required: true, index: true },
        dateKey: { type: String, required: true, index: true },
        queueNumber: { type: Number, required: true },

        studentId: { type: String, required: true, trim: true, index: true },
        phone: { type: String, trim: true },

        // ✅ Persisted participant full name for window/monitor display
        participantLabel: { type: String, trim: true },

        participantType: {
            type: String,
            enum: ["STUDENT", "ALUMNI_VISITOR", "GUEST"],
            index: true,
        },

        transactionCategory: { type: String, trim: true, uppercase: true, index: true },
        transactionKey: { type: String, trim: true, lowercase: true, index: true },
        transactionLabel: { type: String, trim: true },
        purpose: { type: String, trim: true },

        status: { type: String, enum: ["WAITING", "CALLED", "HOLD", "OUT", "SERVED"], default: "WAITING" },
        holdAttempts: { type: Number, default: 0, min: 0 },

        waitingSince: { type: Date, required: true, default: () => new Date(), index: true },

        window: { type: Schema.Types.ObjectId, ref: "ServiceWindow" },
        windowNumber: { type: Number },

        calledAt: { type: Date },
        servedAt: { type: Date },
        outAt: { type: Date },
    },
    { timestamps: true }
)

TicketSchema.index({ department: 1, dateKey: 1, queueNumber: 1 }, { unique: true })
TicketSchema.index({ dateKey: 1, department: 1, status: 1 })
TicketSchema.index({ dateKey: 1, status: 1 })
TicketSchema.index({ dateKey: 1, department: 1, participantType: 1 })
TicketSchema.index({ dateKey: 1, department: 1, transactionKey: 1 })

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
            required: function (this: any) {
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
            required: function (this: any) {
                return this.role === "STUDENT" || this.type === "STUDENT"
            },
        },
        studentId: { type: String, trim: true, sparse: true, unique: true },

        mobileNumber: {
            type: String,
            trim: true,
            sparse: true,
            required: function (this: any) {
                return isParticipantRole(this.role) || isParticipantRole(this.type)
            },
        },
        phone: { type: String, trim: true, sparse: true },

        departmentId: {
            type: Schema.Types.ObjectId,
            ref: "Department",
            required: function (this: any) {
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

UserSchema.pre("validate", function (next) {
    const doc = this as mongoose.HydratedDocument<UserDoc>

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

    if (!doc.name) {
        const composed = [doc.firstName, doc.middleName, doc.lastName]
            .map((x) => String(x ?? "").trim())
            .filter(Boolean)
            .join(" ")
        doc.name = composed
    }

    next()
})

export const AuditLogModel =
    (mongoose.models.AuditLog as mongoose.Model<AuditLogDoc>) ||
    mongoose.model<AuditLogDoc>("AuditLog", AuditLogSchema)

export const DepartmentModel =
    (mongoose.models.Department as mongoose.Model<DepartmentDoc>) ||
    mongoose.model<DepartmentDoc>("Department", DepartmentSchema)

export const QueueCounterModel =
    (mongoose.models.QueueCounter as mongoose.Model<QueueCounterDoc>) ||
    mongoose.model<QueueCounterDoc>("QueueCounter", QueueCounterSchema)

export const ServiceWindowModel =
    (mongoose.models.ServiceWindow as mongoose.Model<ServiceWindowDoc>) ||
    mongoose.model<ServiceWindowDoc>("ServiceWindow", ServiceWindowSchema)

export const SettingModel =
    (mongoose.models.Setting as mongoose.Model<SettingDoc>) ||
    mongoose.model<SettingDoc>("Setting", SettingSchema)

export const TicketModel =
    (mongoose.models.Ticket as mongoose.Model<TicketDoc>) ||
    mongoose.model<TicketDoc>("Ticket", TicketSchema)

export const UserModel =
    (mongoose.models.User as mongoose.Model<UserDoc>) ||
    mongoose.model<UserDoc>("User", UserSchema)