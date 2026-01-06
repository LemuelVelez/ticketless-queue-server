import mongoose, { Schema, Types } from "mongoose"
import type { UserRole } from "./User"

export type AuditLogDoc = {
    actor?: Types.ObjectId
    actorRole?: UserRole
    action: string
    entityType?: string
    entityId?: Types.ObjectId
    meta?: Record<string, unknown>
    createdAt: Date
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

export const AuditLogModel = mongoose.model<AuditLogDoc>("AuditLog", AuditLogSchema)
