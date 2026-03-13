import mongoose from "mongoose"
import dotenv from "dotenv"
import { DepartmentModel, type RegistrarTransactionGroup } from "../models/Model"

dotenv.config()

const registrarTransactionGroups: RegistrarTransactionGroup[] = [
    {
        audience: "INTERNAL",
        items: [
            "Correction of grade entry",
            "Correction of Personal Record",
            "Enrollment/Validation of enrollment",
            "Follow-up/Request/Submit/Evaluation documents/Application for Graduation",
            "Issuance of Certificates/Forms/Authentication",
            "Issuance of Transcript of Records (TOR)",
            "Processing Faculty Clearance",
            "Processing of INC/NG; Adding, Changing & Dropping of subjects",
            "Processing of Student Clearance",
            "Release of Instructors Program",
            "Responding to request for institutional data",
        ],
    },
    {
        audience: "EXTERNAL",
        items: [
            "Correction of Personal Record",
            "Issuance of Certificates/Forms/Authentication",
            "Issuance of Certification, Verification, Authentication (CAV)",
            "Issuance of Diploma",
            "Issuance of Form 137 / Honorable Dismissal",
            "Issuance of Transcript of Records (TOR)",
            "Processing Faculty Clearance",
            "Processing of Student Clearance",
            "Responding to request for institutional data",
        ],
    },
]

async function main() {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error("DATABASE_URL is missing")

    const ssl = String(process.env.DATABASE_SSL || "false").toLowerCase() === "true"
    await mongoose.connect(url, ssl ? { tls: true } : {})

    const result = await DepartmentModel.updateMany(
        { transactionManager: "REGISTRAR" },
        {
            $set: {
                registrarTransactionGroups,
            },
        }
    )

    // eslint-disable-next-line no-console
    console.log("✅ Registrar transactions seeded", {
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
    })

    if (result.matchedCount === 0) {
        // eslint-disable-next-line no-console
        console.warn(
            "⚠️ No REGISTRAR departments found. Create or seed a registrar department first, then run this seeder again."
        )
    }

    await mongoose.connection.close()
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("❌ Registrar transaction seeder failed:", err)
    process.exit(1)
})