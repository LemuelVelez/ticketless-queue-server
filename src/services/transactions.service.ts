import mongoose, { Schema } from "mongoose"

export type TransactionCatalogDoc = {
    category: string
    key: string
    label: string
    scopes: string[]
    enabled: boolean
    sortOrder: number
    meta?: Record<string, unknown>
    createdAt: Date
    updatedAt: Date
}

export type TransactionRecord = {
    id: string
    category: string
    key: string
    label: string
    scopes: string[]
    enabled: boolean
    sortOrder: number
    meta?: Record<string, unknown>
    createdAt: Date
    updatedAt: Date
}

const TransactionCatalogSchema = new Schema<TransactionCatalogDoc>(
    {
        category: { type: String, required: true, trim: true, uppercase: true, index: true },
        key: { type: String, required: true, trim: true, lowercase: true, index: true },
        label: { type: String, required: true, trim: true },
        scopes: [{ type: String, trim: true, uppercase: true }],
        enabled: { type: Boolean, default: true, index: true },
        sortOrder: { type: Number, default: 1000, index: true },
        meta: { type: Schema.Types.Mixed },
    },
    { timestamps: true }
)

TransactionCatalogSchema.index({ category: 1, key: 1 }, { unique: true })
TransactionCatalogSchema.index({ category: 1, enabled: 1, sortOrder: 1, label: 1 })

export const TransactionCatalogModel =
    (mongoose.models.TransactionCatalog as mongoose.Model<TransactionCatalogDoc>) ||
    mongoose.model<TransactionCatalogDoc>("TransactionCatalog", TransactionCatalogSchema)

type EnsureState = {
    done: boolean
    promise: Promise<void> | null
}
const ensureState: EnsureState = { done: false, promise: null }

async function ensureIndexes() {
    if (ensureState.done) return
    if (ensureState.promise) return ensureState.promise

    ensureState.promise = (async () => {
        await TransactionCatalogModel.createIndexes()
        ensureState.done = true
    })().finally(() => {
        ensureState.promise = null
    })

    return ensureState.promise
}

function normalizeCategory(category: string) {
    return category.trim().toUpperCase()
}

function normalizeKey(key: string) {
    return key.trim().toLowerCase()
}

function normalizeLabel(label: string) {
    return label.trim()
}

function uniqueStrings(values: string[]) {
    const seen = new Set<string>()
    const out: string[] = []

    for (const raw of values) {
        const v = raw.trim().toUpperCase()
        if (!v) continue
        if (seen.has(v)) continue
        seen.add(v)
        out.push(v)
    }

    return out
}

function toRecord(doc: TransactionCatalogDoc & { _id: mongoose.Types.ObjectId }): TransactionRecord {
    return {
        id: doc._id.toString(),
        category: doc.category,
        key: doc.key,
        label: doc.label,
        scopes: [...doc.scopes],
        enabled: doc.enabled,
        sortOrder: doc.sortOrder,
        meta: doc.meta,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    }
}

export type CreateTransactionInput = {
    category: string
    key: string
    label: string
    scopes?: string[]
    enabled?: boolean
    sortOrder?: number
    meta?: Record<string, unknown>
}

export async function createTransaction(input: CreateTransactionInput): Promise<TransactionRecord> {
    await ensureIndexes()

    const category = normalizeCategory(input.category || "")
    const key = normalizeKey(input.key || "")
    const label = normalizeLabel(input.label || "")

    if (!category) throw new Error("category is required.")
    if (!key) throw new Error("key is required.")
    if (!label) throw new Error("label is required.")

    const doc = await TransactionCatalogModel.create({
        category,
        key,
        label,
        scopes: uniqueStrings(input.scopes || []),
        enabled: input.enabled ?? true,
        sortOrder: input.sortOrder ?? 1000,
        meta: input.meta,
    })

    return toRecord(doc.toObject({ depopulate: true }) as TransactionCatalogDoc & { _id: mongoose.Types.ObjectId })
}

export type ListTransactionsFilter = {
    category?: string
    scope?: string
    enabledOnly?: boolean
    includeDisabled?: boolean
    key?: string
}

export async function listTransactions(filter: ListTransactionsFilter = {}): Promise<TransactionRecord[]> {
    await ensureIndexes()

    const query: Record<string, unknown> = {}

    if (filter.category) {
        query.category = normalizeCategory(filter.category)
    }

    if (filter.key) {
        query.key = normalizeKey(filter.key)
    }

    if (filter.scope) {
        query.scopes = filter.scope.trim().toUpperCase()
    }

    const enabledOnly = filter.enabledOnly ?? false
    const includeDisabled = filter.includeDisabled ?? false

    if (enabledOnly && !includeDisabled) {
        query.enabled = true
    }

    const docs = await TransactionCatalogModel.find(query)
        .sort({ sortOrder: 1, label: 1, createdAt: 1 })
        .lean()

    return docs.map((d) => toRecord(d as TransactionCatalogDoc & { _id: mongoose.Types.ObjectId }))
}

export async function getTransactionById(id: string): Promise<TransactionRecord | null> {
    await ensureIndexes()

    if (!mongoose.Types.ObjectId.isValid(id)) return null

    const doc = await TransactionCatalogModel.findById(id).lean()
    if (!doc) return null

    return toRecord(doc as TransactionCatalogDoc & { _id: mongoose.Types.ObjectId })
}

export async function getTransactionByKey(category: string, key: string): Promise<TransactionRecord | null> {
    await ensureIndexes()

    const doc = await TransactionCatalogModel.findOne({
        category: normalizeCategory(category),
        key: normalizeKey(key),
    }).lean()

    if (!doc) return null

    return toRecord(doc as TransactionCatalogDoc & { _id: mongoose.Types.ObjectId })
}

export type UpdateTransactionInput = Partial<{
    category: string
    key: string
    label: string
    scopes: string[]
    enabled: boolean
    sortOrder: number
    meta: Record<string, unknown>
}>

export async function updateTransaction(id: string, patch: UpdateTransactionInput): Promise<TransactionRecord> {
    await ensureIndexes()

    if (!mongoose.Types.ObjectId.isValid(id)) {
        throw new Error("Invalid transaction id.")
    }

    const set: Record<string, unknown> = {}

    if (patch.category !== undefined) set.category = normalizeCategory(patch.category)
    if (patch.key !== undefined) set.key = normalizeKey(patch.key)
    if (patch.label !== undefined) set.label = normalizeLabel(patch.label)
    if (patch.scopes !== undefined) set.scopes = uniqueStrings(patch.scopes)
    if (patch.enabled !== undefined) set.enabled = !!patch.enabled
    if (patch.sortOrder !== undefined) set.sortOrder = patch.sortOrder
    if (patch.meta !== undefined) set.meta = patch.meta

    if (!Object.keys(set).length) {
        throw new Error("No update fields provided.")
    }

    const updated = await TransactionCatalogModel.findByIdAndUpdate(id, { $set: set }, { new: true, runValidators: true })
    if (!updated) {
        throw new Error("Transaction not found.")
    }

    return toRecord(updated.toObject({ depopulate: true }) as TransactionCatalogDoc & { _id: mongoose.Types.ObjectId })
}

export async function deleteTransaction(id: string): Promise<boolean> {
    await ensureIndexes()

    if (!mongoose.Types.ObjectId.isValid(id)) return false

    const result = await TransactionCatalogModel.deleteOne({ _id: id })
    return result.deletedCount > 0
}

export async function deleteTransactionByKey(category: string, key: string): Promise<boolean> {
    await ensureIndexes()

    const result = await TransactionCatalogModel.deleteOne({
        category: normalizeCategory(category),
        key: normalizeKey(key),
    })

    return result.deletedCount > 0
}

export type UpsertTransactionByKeyInput = Partial<{
    label: string
    scopes: string[]
    enabled: boolean
    sortOrder: number
    meta: Record<string, unknown>
}>

export async function upsertTransactionByKey(
    category: string,
    key: string,
    patch: UpsertTransactionByKeyInput
): Promise<TransactionRecord> {
    await ensureIndexes()

    const normalizedCategory = normalizeCategory(category)
    const normalizedKey = normalizeKey(key)

    const set: Record<string, unknown> = {}
    if (patch.label !== undefined) set.label = normalizeLabel(patch.label)
    if (patch.scopes !== undefined) set.scopes = uniqueStrings(patch.scopes)
    if (patch.enabled !== undefined) set.enabled = !!patch.enabled
    if (patch.sortOrder !== undefined) set.sortOrder = patch.sortOrder
    if (patch.meta !== undefined) set.meta = patch.meta

    const doc = await TransactionCatalogModel.findOneAndUpdate(
        { category: normalizedCategory, key: normalizedKey },
        {
            $set: set,
            $setOnInsert: {
                category: normalizedCategory,
                key: normalizedKey,
                label: patch.label ? normalizeLabel(patch.label) : normalizedKey,
                scopes: patch.scopes ? uniqueStrings(patch.scopes) : [],
                enabled: patch.enabled ?? true,
                sortOrder: patch.sortOrder ?? 1000,
                meta: patch.meta,
            },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    )

    return toRecord(doc.toObject({ depopulate: true }) as TransactionCatalogDoc & { _id: mongoose.Types.ObjectId })
}

export type SeedTransactionInput = {
    key: string
    label: string
    scopes?: string[]
    enabled?: boolean
    sortOrder?: number
    meta?: Record<string, unknown>
}

export async function seedTransactions(
    category: string,
    defaults: SeedTransactionInput[],
    opts?: { updateExisting?: boolean }
): Promise<void> {
    await ensureIndexes()

    if (!defaults.length) return

    const normalizedCategory = normalizeCategory(category)
    const updateExisting = opts?.updateExisting ?? false

    const ops = defaults.map((item, index) => {
        const normalizedKey = normalizeKey(item.key)
        const baseSetOnInsert = {
            category: normalizedCategory,
            key: normalizedKey,
            label: normalizeLabel(item.label),
            scopes: uniqueStrings(item.scopes || []),
            enabled: item.enabled ?? true,
            sortOrder: item.sortOrder ?? index + 1,
            meta: item.meta,
        }

        const update = updateExisting
            ? {
                $setOnInsert: { category: normalizedCategory, key: normalizedKey },
                $set: {
                    label: normalizeLabel(item.label),
                    scopes: uniqueStrings(item.scopes || []),
                    sortOrder: item.sortOrder ?? index + 1,
                    ...(item.enabled !== undefined ? { enabled: item.enabled } : {}),
                    ...(item.meta !== undefined ? { meta: item.meta } : {}),
                },
            }
            : { $setOnInsert: baseSetOnInsert }

        return {
            updateOne: {
                filter: { category: normalizedCategory, key: normalizedKey },
                update,
                upsert: true,
            },
        }
    })

    await TransactionCatalogModel.bulkWrite(ops, { ordered: false })
}
