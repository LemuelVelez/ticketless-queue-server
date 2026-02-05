export type ParticipantQueueType = "STUDENT" | "ALUMNI_VISITOR"
export type TransactionScope = "INTERNAL" | "EXTERNAL"

export type RegistrarTransaction = {
    key: string
    label: string
    scopes: TransactionScope[]
}

const REGISTRAR_TRANSACTIONS: RegistrarTransaction[] = [
    // Internal
    {
        key: "correction-grade-entry",
        label: "Correction of Grade Entry",
        scopes: ["INTERNAL"],
    },
    {
        key: "correction-personal-record",
        label: "Correction of Personal Record",
        scopes: ["INTERNAL", "EXTERNAL"],
    },
    {
        key: "enrollment-validation-enrollment",
        label: "Enrollment / Validation of Enrollment",
        scopes: ["INTERNAL"],
    },
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
    {
        key: "issuance-transcript-of-records-tor",
        label: "Issuance of Transcript of Records (TOR)",
        scopes: ["INTERNAL", "EXTERNAL"],
    },
    {
        key: "processing-faculty-clearance",
        label: "Processing Faculty Clearance",
        scopes: ["INTERNAL", "EXTERNAL"],
    },
    {
        key: "processing-inc-ng-adding-changing-dropping-subjects",
        label: "Processing of INC/NG; Adding, Changing, and Dropping of Subjects",
        scopes: ["INTERNAL"],
    },
    {
        key: "processing-student-clearance",
        label: "Processing of Student Clearance",
        scopes: ["INTERNAL", "EXTERNAL"],
    },
    {
        key: "release-instructors-program",
        label: "Release of Instructor’s Program",
        scopes: ["INTERNAL"],
    },
    {
        key: "responding-to-requests-for-institutional-data",
        label: "Responding to Requests for Institutional Data",
        scopes: ["INTERNAL", "EXTERNAL"],
    },

    // External-only
    {
        key: "issuance-cav",
        label: "Issuance of Certification, Verification, and Authentication (CAV)",
        scopes: ["EXTERNAL"],
    },
    {
        key: "issuance-diploma",
        label: "Issuance of Diploma",
        scopes: ["EXTERNAL"],
    },
    {
        key: "issuance-form-137-honorable-dismissal",
        label: "Issuance of Form 137 / Honorable Dismissal",
        scopes: ["EXTERNAL"],
    },
]

export function getTransactionsByScope(scope: TransactionScope): RegistrarTransaction[] {
    return REGISTRAR_TRANSACTIONS.filter((t) => t.scopes.includes(scope))
}

export function getTransactionsForParticipant(type: ParticipantQueueType): RegistrarTransaction[] {
    return type === "STUDENT" ? getTransactionsByScope("INTERNAL") : getTransactionsByScope("EXTERNAL")
}

export function getAllRegistrarTransactions(): RegistrarTransaction[] {
    return [...REGISTRAR_TRANSACTIONS]
}

export function getTransactionLabelMap(): Map<string, string> {
    return new Map(REGISTRAR_TRANSACTIONS.map((t) => [t.key, t.label]))
}

export function validateTransactionsForParticipant(type: ParticipantQueueType, keys: string[]) {
    const allowed = new Set(getTransactionsForParticipant(type).map((t) => t.key))
    const invalidKeys = keys.filter((k) => !allowed.has(k))
    return {
        isValid: invalidKeys.length === 0,
        invalidKeys,
    }
}



