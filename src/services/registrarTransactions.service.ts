import { Types } from "mongoose"

import { DepartmentModel } from "../models/Department"
import {
    createTransaction as createCatalogTransaction,
    deleteTransaction as deleteCatalogTransaction,
    deleteTransactionByKey as deleteCatalogTransactionByKey,
    getTransactionById as getCatalogTransactionById,
    getTransactionByKey as getCatalogTransactionByKey,
    listTransactions as listCatalogTransactions,
    seedTransactions,
    type CreateTransactionInput,
    type ListTransactionsFilter,
    type SeedTransactionInput,
    type TransactionRecord,
    type UpdateTransactionInput,
    updateTransaction as updateCatalogTransaction,
    upsertTransactionByKey as upsertCatalogTransactionByKey,
} from "./transactions.service"

export type ParticipantQueueType = "STUDENT" | "ALUMNI_VISITOR"
export type TransactionScope = "INTERNAL" | "EXTERNAL"

export type RegistrarTransaction = {
    key: string
    label: string
    scopes: TransactionScope[]
}

const DEFAULT_TRANSACTION_MANAGER = "REGISTRAR"
const REGISTRAR_CATEGORY = DEFAULT_TRANSACTION_MANAGER

const DEFAULT_REGISTRAR_TRANSACTIONS: RegistrarTransaction[] = [
    // Internal
    { key: "correction-grade-entry", label: "Correction of Grade Entry", scopes: ["INTERNAL"] },
    { key: "correction-personal-record", label: "Correction of Personal Record", scopes: ["INTERNAL", "EXTERNAL"] },
    { key: "enrollment-validation-enrollment", label: "Enrollment / Validation of Enrollment", scopes: ["INTERNAL"] },
    {
        key: "followup-request-submission-evaluation-documents-application-graduation",
        label: "Follow-up / Request / Submission / Evaluation of Documents / Application for Graduation",
        scopes: ["INTERNAL"],
    },
    {
        key: "issuance-certificates-forms-authentication",
        label: "Issuance of Certificates / Forms / Authentication",
        scopes: ["INTERNAL", "EXTERNAL"],
    },
    { key: "issuance-transcript-of-records-tor", label: "Issuance of Transcript of Records (TOR)", scopes: ["INTERNAL", "EXTERNAL"] },
    { key: "processing-faculty-clearance", label: "Processing Faculty Clearance", scopes: ["INTERNAL", "EXTERNAL"] },
    {
        key: "processing-inc-ng-adding-changing-dropping-subjects",
        label: "Processing of INC/NG; Adding, Changing, and Dropping of Subjects",
        scopes: ["INTERNAL"],
    },
    { key: "processing-student-clearance", label: "Processing of Student Clearance", scopes: ["INTERNAL", "EXTERNAL"] },
    { key: "release-instructors-program", label: "Release of Instructor’s Program", scopes: ["INTERNAL"] },
    {
        key: "responding-to-requests-for-institutional-data",
        label: "Responding to Requests for Institutional Data",
        scopes: ["INTERNAL", "EXTERNAL"],
    },

    // External-only
    { key: "issuance-cav", label: "Issuance of Certification, Verification, and Authentication (CAV)", scopes: ["EXTERNAL"] },
    { key: "issuance-diploma", label: "Issuance of Diploma", scopes: ["EXTERNAL"] },
    { key: "issuance-form-137-honorable-dismissal", label: "Issuance of Form 137 / Honorable Dismissal", scopes: ["EXTERNAL"] },
]

let registrarCache: RegistrarTransaction[] = DEFAULT_REGISTRAR_TRANSACTIONS.map((t) => ({ ...t, scopes: [...t.scopes] }))
let bootstrapPromise: Promise<void> | null = null
let bootstrapReady = false

function normalizeCategory(category: string) {
    const value = String(category || "").trim().toUpperCase()
    return value || DEFAULT_TRANSACTION_MANAGER
}

function toScope(scope: string): TransactionScope | null {
    const v = scope.trim().toUpperCase()
    if (v === "INTERNAL" || v === "EXTERNAL") return v
    return null
}

function scopeForParticipant(type: ParticipantQueueType): TransactionScope {
    return type === "STUDENT" ? "INTERNAL" : "EXTERNAL"
}

function toRegistrarTransaction(record: TransactionRecord): RegistrarTransaction {
    const scopes = record.scopes.map((s) => toScope(s)).filter((s): s is TransactionScope => !!s)

    return {
        key: record.key,
        label: record.label,
        scopes,
    }
}

async function reloadRegistrarCache() {
    const records = await listCatalogTransactions({
        category: REGISTRAR_CATEGORY,
        enabledOnly: true,
        includeDisabled: false,
    })

    registrarCache = records.map(toRegistrarTransaction)
}

function defaultSeeds(): SeedTransactionInput[] {
    return DEFAULT_REGISTRAR_TRANSACTIONS.map((t, index) => ({
        key: t.key,
        label: t.label,
        scopes: t.scopes,
        enabled: true,
        sortOrder: index + 1,
        meta: { module: "registrar" },
    }))
}

async function resolveDepartmentCategory(departmentId: string | Types.ObjectId): Promise<string> {
    const id = String(departmentId || "").trim()
    if (!Types.ObjectId.isValid(id)) return DEFAULT_TRANSACTION_MANAGER

    const department = await DepartmentModel.findById(id).select("transactionManager").lean()
    if (!department) return DEFAULT_TRANSACTION_MANAGER

    return normalizeCategory(department.transactionManager || DEFAULT_TRANSACTION_MANAGER)
}

/**
 * Auto-creates default registrar transactions if missing.
 * It does NOT overwrite existing records (so CRUD updates are preserved).
 */
export async function ensureDefaultRegistrarTransactions() {
    if (bootstrapReady) return
    if (bootstrapPromise) return bootstrapPromise

    bootstrapPromise = (async () => {
        await seedTransactions(REGISTRAR_CATEGORY, defaultSeeds(), { updateExisting: false })
        await reloadRegistrarCache()
        bootstrapReady = true
    })()
        .catch((err) => {
            bootstrapReady = false
            throw err
        })
        .finally(() => {
            bootstrapPromise = null
        })

    return bootstrapPromise
}

function warmupDefaultsNonBlocking() {
    void ensureDefaultRegistrarTransactions().catch(() => {
        // intentionally silent for non-blocking warmup
    })
}

/**
 * Legacy sync getter (kept for compatibility with existing code).
 * Uses cache and triggers non-blocking DB bootstrap.
 */
export function getTransactionsByScope(scope: TransactionScope): RegistrarTransaction[] {
    warmupDefaultsNonBlocking()
    return registrarCache
        .filter((t) => t.scopes.includes(scope))
        .map((t) => ({ ...t, scopes: [...t.scopes] }))
}

/**
 * Legacy sync getter (kept for compatibility with existing code).
 */
export function getTransactionsForParticipant(type: ParticipantQueueType): RegistrarTransaction[] {
    return type === "STUDENT" ? getTransactionsByScope("INTERNAL") : getTransactionsByScope("EXTERNAL")
}

/**
 * Department-aware transaction list for queue participants.
 * Uses department.transactionManager (top-level office) + department-specific transaction bindings.
 */
export async function getTransactionsForParticipantInDepartment(
    type: ParticipantQueueType,
    departmentId: string | Types.ObjectId
): Promise<RegistrarTransaction[]> {
    await ensureDefaultRegistrarTransactions()

    const category = await resolveDepartmentCategory(departmentId)
    const scope = scopeForParticipant(type)

    const records = await listCatalogTransactions({
        category,
        scope,
        enabledOnly: true,
        includeDisabled: false,
        departmentId: String(departmentId),
        matchDepartmentOrGlobal: true,
    })

    return records.map(toRegistrarTransaction)
}

export async function getTransactionLabelMapForDepartment(
    departmentId: string | Types.ObjectId,
    opts?: { participantType?: ParticipantQueueType }
): Promise<Map<string, string>> {
    await ensureDefaultRegistrarTransactions()

    const category = await resolveDepartmentCategory(departmentId)
    const records = await listCatalogTransactions({
        category,
        scope: opts?.participantType ? scopeForParticipant(opts.participantType) : undefined,
        enabledOnly: true,
        includeDisabled: false,
        departmentId: String(departmentId),
        matchDepartmentOrGlobal: true,
    })

    return new Map(records.map((t) => [t.key, t.label]))
}

/**
 * Legacy sync getter (kept for compatibility with existing code).
 */
export function getAllRegistrarTransactions(): RegistrarTransaction[] {
    warmupDefaultsNonBlocking()
    return registrarCache.map((t) => ({ ...t, scopes: [...t.scopes] }))
}

/**
 * Legacy sync getter (kept for compatibility with existing code).
 */
export function getTransactionLabelMap(): Map<string, string> {
    warmupDefaultsNonBlocking()
    return new Map(registrarCache.map((t) => [t.key, t.label]))
}

/**
 * Legacy sync validator (kept for compatibility with existing code).
 */
export function validateTransactionsForParticipant(type: ParticipantQueueType, keys: string[]) {
    const allowed = new Set(getTransactionsForParticipant(type).map((t) => t.key))
    const invalidKeys = keys.filter((k) => !allowed.has(k))
    return {
        isValid: invalidKeys.length === 0,
        invalidKeys,
    }
}

export async function validateTransactionsForParticipantInDepartment(
    type: ParticipantQueueType,
    departmentId: string | Types.ObjectId,
    keys: string[]
) {
    const allowed = new Set((await getTransactionsForParticipantInDepartment(type, departmentId)).map((t) => t.key))
    const invalidKeys = keys.filter((k) => !allowed.has(k))
    return {
        isValid: invalidKeys.length === 0,
        invalidKeys,
    }
}

function isRegistrarCategory(category: string) {
    return category.trim().toUpperCase() === REGISTRAR_CATEGORY
}

/* -------------------------------------------------------------------------- */
/*                    Flexible CRUD for ALL transaction kinds                  */
/* -------------------------------------------------------------------------- */

export async function createTransactionDefinition(input: CreateTransactionInput) {
    await ensureDefaultRegistrarTransactions()
    const created = await createCatalogTransaction(input)

    if (isRegistrarCategory(created.category)) {
        await reloadRegistrarCache()
    }

    return created
}

export async function listTransactionDefinitions(filter: ListTransactionsFilter = {}) {
    await ensureDefaultRegistrarTransactions()
    return listCatalogTransactions(filter)
}

export async function getTransactionDefinitionById(id: string) {
    await ensureDefaultRegistrarTransactions()
    return getCatalogTransactionById(id)
}

export async function getTransactionDefinitionByKey(category: string, key: string) {
    await ensureDefaultRegistrarTransactions()
    return getCatalogTransactionByKey(category, key)
}

export async function updateTransactionDefinition(id: string, patch: UpdateTransactionInput) {
    await ensureDefaultRegistrarTransactions()
    const updated = await updateCatalogTransaction(id, patch)

    if (isRegistrarCategory(updated.category)) {
        await reloadRegistrarCache()
    }

    return updated
}

export async function upsertTransactionDefinitionByKey(
    category: string,
    key: string,
    patch: Partial<{
        label: string
        scopes: string[]
        departmentIds: string[]
        enabled: boolean
        sortOrder: number
        meta: Record<string, unknown>
    }>
) {
    await ensureDefaultRegistrarTransactions()
    const upserted = await upsertCatalogTransactionByKey(category, key, patch)

    if (isRegistrarCategory(upserted.category)) {
        await reloadRegistrarCache()
    }

    return upserted
}

export async function deleteTransactionDefinition(id: string) {
    await ensureDefaultRegistrarTransactions()

    const before = await getCatalogTransactionById(id)
    const deleted = await deleteCatalogTransaction(id)

    if (deleted && before?.category && isRegistrarCategory(before.category)) {
        await reloadRegistrarCache()
    }

    return deleted
}

export async function deleteTransactionDefinitionByKey(category: string, key: string) {
    await ensureDefaultRegistrarTransactions()

    const deleted = await deleteCatalogTransactionByKey(category, key)

    if (deleted && isRegistrarCategory(category)) {
        await reloadRegistrarCache()
    }

    return deleted
}
