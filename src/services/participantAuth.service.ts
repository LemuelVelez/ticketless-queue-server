import mongoose, { Schema, Types } from "mongoose"
import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "crypto"

import { DepartmentModel } from "../models/Department"
import { getTransactionsForParticipant, type ParticipantQueueType } from "./registrarTransactions.service"

export type ParticipantType = ParticipantQueueType

export type ParticipantDoc = {
    type: ParticipantType
    firstName: string
    middleName?: string
    lastName: string

    tcNumber?: string
    mobileNumber: string

    department: Types.ObjectId
    active: boolean

    pinSalt: string
    pinHash: string
    pinAlgo: "pbkdf2-sha256"
    pinIterations: number

    createdAt: Date
    updatedAt: Date
}

export type ParticipantSessionDoc = {
    participant: Types.ObjectId
    tokenHash: string
    expiresAt: Date
    createdAt: Date
}

const ParticipantSchema = new Schema<ParticipantDoc>(
    {
        type: { type: String, enum: ["STUDENT", "ALUMNI_VISITOR"], required: true, index: true },
        firstName: { type: String, required: true, trim: true },
        middleName: { type: String, trim: true },
        lastName: { type: String, required: true, trim: true },

        tcNumber: { type: String, trim: true, uppercase: true, sparse: true },
        mobileNumber: { type: String, required: true, trim: true },

        department: { type: Schema.Types.ObjectId, ref: "Department", required: true, index: true },
        active: { type: Boolean, default: true },

        pinSalt: { type: String, required: true },
        pinHash: { type: String, required: true },
        pinAlgo: { type: String, default: "pbkdf2-sha256" },
        pinIterations: { type: Number, default: 150000 },
    },
    { timestamps: true }
)

ParticipantSchema.index({ tcNumber: 1 }, { unique: true, sparse: true })
ParticipantSchema.index({ mobileNumber: 1 }, { unique: true })

const ParticipantSessionSchema = new Schema<ParticipantSessionDoc>(
    {
        participant: { type: Schema.Types.ObjectId, ref: "QueueParticipant", required: true, index: true },
        tokenHash: { type: String, required: true, unique: true, index: true },
        expiresAt: { type: Date, required: true },
        createdAt: { type: Date, default: () => new Date() },
    },
    { versionKey: false }
)

ParticipantSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export const ParticipantModel =
    (mongoose.models.QueueParticipant as mongoose.Model<ParticipantDoc>) ||
    mongoose.model<ParticipantDoc>("QueueParticipant", ParticipantSchema)

export const ParticipantSessionModel =
    (mongoose.models.QueueParticipantSession as mongoose.Model<ParticipantSessionDoc>) ||
    mongoose.model<ParticipantSessionDoc>("QueueParticipantSession", ParticipantSessionSchema)

const PIN_ITERATIONS = 150000
const SESSION_TTL_HOURS = 12

export type PublicParticipantProfile = {
    id: string
    type: ParticipantType
    firstName: string
    middleName?: string
    lastName: string
    accountName: string
    tcNumber?: string
    mobileNumber: string
    departmentId: string
}

export type StudentSignupInput = {
    firstName: string
    middleName?: string
    lastName: string
    tcNumber: string
    department: string // code/name/objectId
    mobileNumber: string
    pin: string
}

export type AlumniVisitorSignupInput = {
    firstName: string
    middleName?: string
    lastName: string
    department: string // code/name/objectId
    mobileNumber: string
    pin: string
}

function escapeRegExp(input: string) {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function normalizeTCNumber(tcNumber: string) {
    return tcNumber.trim().replace(/\s+/g, "").toUpperCase()
}

function normalizeMobileNumber(mobileNumber: string) {
    const cleaned = mobileNumber.trim().replace(/[^\d+]/g, "")
    if (cleaned.startsWith("+")) return cleaned
    return cleaned
}

function assertPin(pin: string) {
    if (!/^\d{4}$/.test(pin)) {
        throw new Error("PIN must be exactly 4 digits.")
    }
}

function assertMobile(mobile: string) {
    if (!/^\+?\d{10,15}$/.test(mobile)) {
        throw new Error("Invalid mobile number format.")
    }
}

function hashPin(pin: string, salt: string, iterations = PIN_ITERATIONS) {
    return pbkdf2Sync(pin, salt, iterations, 32, "sha256").toString("hex")
}

function toPublicProfile(doc: mongoose.HydratedDocument<ParticipantDoc>): PublicParticipantProfile {
    return {
        id: doc._id.toString(),
        type: doc.type,
        firstName: doc.firstName,
        middleName: doc.middleName,
        lastName: doc.lastName,
        accountName: buildAccountName(doc),
        tcNumber: doc.tcNumber,
        mobileNumber: doc.mobileNumber,
        departmentId: doc.department.toString(),
    }
}

export function buildAccountName(name: Pick<ParticipantDoc, "firstName" | "middleName" | "lastName">) {
    return [name.firstName, name.middleName, name.lastName].filter(Boolean).join(" ").replace(/\s+/g, " ").trim()
}

async function resolveDepartmentId(departmentInput: string) {
    const value = departmentInput.trim()

    if (Types.ObjectId.isValid(value)) {
        const byId = await DepartmentModel.findById(value)
        if (byId?.enabled) return byId._id
    }

    const regex = new RegExp(`^${escapeRegExp(value)}$`, "i")
    const byCodeOrName = await DepartmentModel.findOne({
        enabled: true,
        $or: [{ code: regex }, { name: regex }],
    })

    if (!byCodeOrName) {
        throw new Error("Invalid department.")
    }

    return byCodeOrName._id
}

function createSessionToken() {
    return randomBytes(32).toString("hex")
}

function tokenToHash(token: string) {
    return createHash("sha256").update(token).digest("hex")
}

async function createParticipantSession(participantId: Types.ObjectId) {
    const token = createSessionToken()
    const tokenHash = tokenToHash(token)
    const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000)

    await ParticipantSessionModel.create({
        participant: participantId,
        tokenHash,
        expiresAt,
    })

    return {
        token,
        expiresAt,
    }
}

export async function signupStudent(input: StudentSignupInput) {
    const tcNumber = normalizeTCNumber(input.tcNumber)
    const mobileNumber = normalizeMobileNumber(input.mobileNumber)

    assertPin(input.pin)
    assertMobile(mobileNumber)

    const departmentId = await resolveDepartmentId(input.department)

    const existing = await ParticipantModel.findOne({
        $or: [{ tcNumber }, { mobileNumber }],
    })

    if (existing) {
        throw new Error("Student account already exists.")
    }

    const pinSalt = randomBytes(16).toString("hex")
    const pinHash = hashPin(input.pin, pinSalt, PIN_ITERATIONS)

    const participant = await ParticipantModel.create({
        type: "STUDENT",
        firstName: input.firstName,
        middleName: input.middleName,
        lastName: input.lastName,
        tcNumber,
        mobileNumber,
        department: departmentId,
        pinSalt,
        pinHash,
        pinAlgo: "pbkdf2-sha256",
        pinIterations: PIN_ITERATIONS,
        active: true,
    })

    return {
        participant: toPublicProfile(participant),
        login: "Use TC Number + 4-digit PIN",
    }
}

export async function signupAlumniVisitor(input: AlumniVisitorSignupInput) {
    const mobileNumber = normalizeMobileNumber(input.mobileNumber)

    assertPin(input.pin)
    assertMobile(mobileNumber)

    const departmentId = await resolveDepartmentId(input.department)

    const existing = await ParticipantModel.findOne({ mobileNumber })
    if (existing) {
        throw new Error("Mobile number is already registered.")
    }

    const pinSalt = randomBytes(16).toString("hex")
    const pinHash = hashPin(input.pin, pinSalt, PIN_ITERATIONS)

    const participant = await ParticipantModel.create({
        type: "ALUMNI_VISITOR",
        firstName: input.firstName,
        middleName: input.middleName,
        lastName: input.lastName,
        mobileNumber,
        department: departmentId,
        pinSalt,
        pinHash,
        pinAlgo: "pbkdf2-sha256",
        pinIterations: PIN_ITERATIONS,
        active: true,
    })

    return {
        participant: toPublicProfile(participant),
        login: "Use Mobile Number + 4-digit PIN",
    }
}

export async function loginStudent(tcNumberInput: string, pin: string) {
    assertPin(pin)
    const tcNumber = normalizeTCNumber(tcNumberInput)

    const participant = await ParticipantModel.findOne({
        type: "STUDENT",
        tcNumber,
        active: true,
    })

    if (!participant) {
        throw new Error("Invalid credentials.")
    }

    const computed = hashPin(pin, participant.pinSalt, participant.pinIterations)
    const isMatch = timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(participant.pinHash, "hex"))
    if (!isMatch) {
        throw new Error("Invalid credentials.")
    }

    const session = await createParticipantSession(participant._id)

    return {
        sessionToken: session.token,
        sessionExpiresAt: session.expiresAt,
        participant: toPublicProfile(participant),
        availableTransactions: getTransactionsForParticipant("STUDENT"),
    }
}

export async function loginAlumniVisitor(mobileInput: string, pin: string) {
    assertPin(pin)
    const mobileNumber = normalizeMobileNumber(mobileInput)

    const participant = await ParticipantModel.findOne({
        type: "ALUMNI_VISITOR",
        mobileNumber,
        active: true,
    })

    if (!participant) {
        throw new Error("Invalid credentials.")
    }

    const computed = hashPin(pin, participant.pinSalt, participant.pinIterations)
    const isMatch = timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(participant.pinHash, "hex"))
    if (!isMatch) {
        throw new Error("Invalid credentials.")
    }

    const session = await createParticipantSession(participant._id)

    return {
        sessionToken: session.token,
        sessionExpiresAt: session.expiresAt,
        participant: toPublicProfile(participant),
        availableTransactions: getTransactionsForParticipant("ALUMNI_VISITOR"),
    }
}

export async function verifyParticipantSession(sessionToken: string) {
    const tokenHash = tokenToHash(sessionToken)

    const session = await ParticipantSessionModel.findOne({
        tokenHash,
        expiresAt: { $gt: new Date() },
    })

    if (!session) return null

    const participant = await ParticipantModel.findById(session.participant)
    if (!participant || !participant.active) return null

    return {
        session,
        participant,
        profile: toPublicProfile(participant),
    }
}

export async function logoutParticipantSession(sessionToken: string) {
    const tokenHash = tokenToHash(sessionToken)
    await ParticipantSessionModel.deleteOne({ tokenHash })
}
