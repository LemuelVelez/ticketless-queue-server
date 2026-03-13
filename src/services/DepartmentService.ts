import { Types } from "mongoose"
import { DepartmentModel } from "../models/Model"
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

function normalizeObjectIdString(
    value: string | Types.ObjectId | null | undefined
): string | null {
    const normalized = NameService.toIdString(value)
    if (!normalized) return null
    return Types.ObjectId.isValid(normalized) ? normalized : null
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