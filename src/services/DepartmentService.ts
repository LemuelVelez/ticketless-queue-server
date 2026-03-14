import { Types } from "mongoose"
import {
    DepartmentModel,
    ServiceWindowModel,
    TicketModel,
    UserModel,
    type RegistrarTransactionAudience,
    type RegistrarTransactionGroup,
} from "../models/Model"
import { NameService } from "./NameService"

export type DepartmentView = {
    id: string
    name: string
    code?: string
    transactionManager: string
    enabled: boolean
    createdAt?: Date
    updatedAt?: Date
}

export type DepartmentDeleteResult = {
    deleted: boolean
    notFound?: boolean
    references?: {
        serviceWindows: number
        tickets: number
        users: number
    }
}

function normalizeObjectIdString(
    value: string | Types.ObjectId | null | undefined
): string | null {
    const normalized = NameService.toIdString(value)
    if (!normalized) return null
    return Types.ObjectId.isValid(normalized) ? normalized : null
}

function hasOwn(source: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(source, key)
}

function normalizeTrimmedString(value: unknown): string {
    if (Array.isArray(value)) return String(value[0] ?? "").trim()
    return String(value ?? "").trim()
}

function normalizeOptionalString(value: unknown): string | undefined {
    const normalized = normalizeTrimmedString(value)
    return normalized || undefined
}

function normalizeTransactionManager(value: unknown): string {
    return normalizeTrimmedString(value).toUpperCase()
}

function parseBooleanish(value: unknown, fallback: boolean): boolean {
    if (typeof value === "boolean") return value
    if (typeof value === "number") return value !== 0

    const normalized = normalizeTrimmedString(value).toLowerCase()
    if (!normalized) return fallback

    if (["1", "true", "yes", "y", "on"].includes(normalized)) return true
    if (["0", "false", "no", "n", "off"].includes(normalized)) return false

    return fallback
}

function normalizeAudience(value: unknown): RegistrarTransactionAudience | null {
    const normalized = normalizeTrimmedString(value).toUpperCase()
    if (normalized === "INTERNAL" || normalized === "EXTERNAL") {
        return normalized
    }

    return null
}

function normalizeRegistrarTransactionGroups(value: unknown): RegistrarTransactionGroup[] {
    if (!Array.isArray(value)) return []

    const out: RegistrarTransactionGroup[] = []

    for (const entry of value) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue

        const record = entry as Record<string, unknown>
        const audience = normalizeAudience(record.audience)
        if (!audience) continue

        const rawItems = Array.isArray(record.items) ? record.items : []
        const items = Array.from(
            new Set(
                rawItems
                    .map((item) => normalizeTrimmedString(item))
                    .filter(Boolean)
            )
        )

        out.push({
            audience,
            items,
        })
    }

    return out
}

export class DepartmentService {
    static toView(department: any): DepartmentView {
        return {
            id: NameService.toIdString(department?._id) ?? "",
            name: NameService.getDepartmentName(department),
            code: department?.code ? String(department.code) : undefined,
            transactionManager: String(department?.transactionManager ?? "").trim(),
            enabled: Boolean(department?.enabled),
            createdAt: department?.createdAt,
            updatedAt: department?.updatedAt,
        }
    }

    static async getById(departmentId: string | Types.ObjectId): Promise<DepartmentView | null> {
        const normalizedDepartmentId = normalizeObjectIdString(departmentId)
        if (!normalizedDepartmentId) return null

        const department = await DepartmentModel.findById(normalizedDepartmentId).exec()
        return department ? DepartmentService.toView(department) : null
    }

    static async create(payload: Record<string, unknown>): Promise<DepartmentView> {
        const name = normalizeTrimmedString(payload.name)
        const transactionManager = normalizeTransactionManager(payload.transactionManager)
        const code = normalizeOptionalString(payload.code)
        const enabled = hasOwn(payload, "enabled")
            ? parseBooleanish(payload.enabled, true)
            : true
        const registrarTransactionGroups = hasOwn(payload, "registrarTransactionGroups")
            ? normalizeRegistrarTransactionGroups(payload.registrarTransactionGroups)
            : []

        if (!name) {
            throw new Error("Department name is required")
        }

        if (!transactionManager) {
            throw new Error("transactionManager is required")
        }

        const department = await DepartmentModel.create({
            name,
            code,
            transactionManager,
            enabled,
            registrarTransactionGroups,
        })

        return DepartmentService.toView(department)
    }

    static async update(
        departmentId: string | Types.ObjectId,
        payload: Record<string, unknown>
    ): Promise<DepartmentView | null> {
        const normalizedDepartmentId = normalizeObjectIdString(departmentId)
        if (!normalizedDepartmentId) {
            throw new Error("Invalid departmentId")
        }

        const department = await DepartmentModel.findById(normalizedDepartmentId).exec()
        if (!department) return null

        if (hasOwn(payload, "name")) {
            const name = normalizeTrimmedString(payload.name)
            if (!name) {
                throw new Error("Department name is required")
            }

            department.name = name
        }

        if (hasOwn(payload, "code")) {
            department.code = normalizeOptionalString(payload.code)
        }

        if (hasOwn(payload, "transactionManager")) {
            const transactionManager = normalizeTransactionManager(payload.transactionManager)
            if (!transactionManager) {
                throw new Error("transactionManager is required")
            }

            department.transactionManager = transactionManager
        }

        if (hasOwn(payload, "enabled")) {
            department.enabled = parseBooleanish(payload.enabled, department.enabled)
        }

        if (hasOwn(payload, "registrarTransactionGroups")) {
            department.registrarTransactionGroups = normalizeRegistrarTransactionGroups(
                payload.registrarTransactionGroups
            )
        }

        await department.save()

        return DepartmentService.toView(department)
    }

    static async remove(
        departmentId: string | Types.ObjectId
    ): Promise<DepartmentDeleteResult> {
        const normalizedDepartmentId = normalizeObjectIdString(departmentId)
        if (!normalizedDepartmentId) {
            throw new Error("Invalid departmentId")
        }

        const departmentObjectId = new Types.ObjectId(normalizedDepartmentId)
        const exists = await DepartmentModel.exists({ _id: departmentObjectId }).exec()

        if (!exists) {
            return {
                deleted: false,
                notFound: true,
            }
        }

        const [serviceWindows, tickets, users] = await Promise.all([
            ServiceWindowModel.countDocuments({
                $or: [
                    { department: departmentObjectId },
                    { departmentIds: departmentObjectId },
                ],
            }).exec(),
            TicketModel.countDocuments({
                department: departmentObjectId,
            }).exec(),
            UserModel.countDocuments({
                $or: [
                    { assignedDepartment: departmentObjectId },
                    { assignedDepartments: departmentObjectId },
                    { departmentId: departmentObjectId },
                ],
            }).exec(),
        ])

        if (serviceWindows > 0 || tickets > 0 || users > 0) {
            return {
                deleted: false,
                references: {
                    serviceWindows,
                    tickets,
                    users,
                },
            }
        }

        await DepartmentModel.deleteOne({ _id: departmentObjectId }).exec()

        return {
            deleted: true,
            references: {
                serviceWindows: 0,
                tickets: 0,
                users: 0,
            },
        }
    }

    static async listEnabled(): Promise<DepartmentView[]> {
        const departments = await DepartmentModel.find({ enabled: true })
            .sort({ name: 1 })
            .exec()

        return departments.map((department) => DepartmentService.toView(department))
    }

    static async listByTransactionManager(
        transactionManager: string,
        includeDisabled = false
    ): Promise<DepartmentView[]> {
        const filter: Record<string, unknown> = {
            transactionManager: String(transactionManager ?? "").trim().toUpperCase(),
        }

        if (!includeDisabled) filter.enabled = true

        const departments = await DepartmentModel.find(filter).sort({ name: 1 }).exec()

        return departments.map((department) => DepartmentService.toView(department))
    }

    static async getNameMap(
        ids: Array<string | Types.ObjectId | null | undefined>
    ): Promise<Map<string, string>> {
        const normalizedIds = Array.from(
            new Set(ids.map((id) => normalizeObjectIdString(id)).filter(Boolean) as string[])
        )

        if (!normalizedIds.length) return new Map()

        const departments = await DepartmentModel.find({ _id: { $in: normalizedIds } })
            .select("name code")
            .exec()

        const map = new Map<string, string>()

        for (const department of departments) {
            map.set(String(department._id), NameService.getDepartmentName(department))
        }

        return map
    }
}