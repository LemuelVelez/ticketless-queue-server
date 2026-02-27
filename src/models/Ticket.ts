import mongoose, { Schema, Types } from "mongoose"

export type TicketStatus = "WAITING" | "CALLED" | "HOLD" | "OUT" | "SERVED"
export type TicketParticipantType = "STUDENT" | "ALUMNI_VISITOR" | "GUEST"

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

// Unique queue number per department per day
TicketSchema.index({ department: 1, dateKey: 1, queueNumber: 1 }, { unique: true })

// ✅ Reports-friendly indexes
TicketSchema.index({ dateKey: 1, department: 1, status: 1 })
TicketSchema.index({ dateKey: 1, status: 1 })

// Staff visibility helpers
TicketSchema.index({ dateKey: 1, department: 1, participantType: 1 })
TicketSchema.index({ dateKey: 1, department: 1, transactionKey: 1 })

export const TicketModel = mongoose.model<TicketDoc>("Ticket", TicketSchema)